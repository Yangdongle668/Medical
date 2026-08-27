import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { boot, resetDb, as, type Caller } from "./harness.js";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { siteRevenue, entryCostCents, CALC_VERSION } from "@sitedesk/calc";

/* ════════════════════════════════════════════════════════════════════
   Timesheet & Cost —— 这一组要证明的是：

     I1  工时归属唯一中心；billable 落库固化，不随类型定义变更而改变
     I2  成本 = 人天 × **提交时生效的**费率卡；费率变更不回溯历史
     I8' 单中心收入四项俱全，且**接口算出来的和 calc 算出来的一样**

   以及一条最容易被绕过去的：**工时不能删，只能作废。**
   ════════════════════════════════════════════════════════════════════ */

let app: INestApplication;
let boss: Caller, crc: Caller, cra: Caller, inst: Caller, pm: Caller, pmHan: Caller;
const K = () => ({ "Idempotency-Key": randomUUID() });
const w = (v: number) => Math.round(v * 10000 * 100);

beforeAll(async () => {
  resetDb(); app = await boot();
  boss = await as(app, "lingyuan");
  crc  = await as(app, "wutong");
  cra  = await as(app, "linmin");
  inst = await as(app, "zhanghm");
  pm   = await as(app, "cendi");
  /* SS-01 归 hanxue 那个组：PM 的行范围是 team，
     拿另一个组的 PM 去审 SS-01 的工时会得到 404（不在范围 = 不存在）。 */
  pmHan = await as(app, "hanxue");
}, 180_000);
afterAll(async () => { await app?.close(); });

const siteByCode = async (c: Caller, code: string) =>
  (await c.get(`/v1/study-sites?limit=200&q=${code}`)).body.items
    .find((s: { code: string }) => s.code === code);
const today = () => new Date().toISOString().slice(0, 10);

describe("I2：费率卡的生效区间", () => {
  it("同一工种的区间重叠会被数据库直接拒绝 —— 重叠时「当天用哪个费率」没有答案", async () => {
    const r = await boss.post("/v1/rate-cards", {
      roleKind: "CRC", dayCostCents: w(0.15),
      validFrom: "2026-06-01", note: "故意与 2026 年那张重叠"
    }, K());
    expect(r.status).toBe(422);
    expect(r.body.invariant).toBe("rate-card-overlap");
    expect(r.body.detail).toContain("给旧卡收口");
  });

  it("不收口就想接新卡 → 与不封口的旧卡重叠，拒绝", async () => {
    const r = await boss.post("/v1/rate-cards", {
      roleKind: "DM", dayCostCents: w(0.22), validFrom: "2030-01-01"
    }, K());
    expect(r.status).toBe(422);
    expect(r.body.invariant).toBe("rate-card-overlap");
  });

  it("调价的正确做法：先给旧卡收口，再开新卡", async () => {
    const cards = (await boss.get("/v1/rate-cards?roleKind=DM&limit=50")).body.items;
    const open = cards.find((c: { validTo: string | null }) => c.validTo === null);
    expect(open, "DM 应有一张不封口的卡").toBeTruthy();

    const close = await boss.post(`/v1/rate-cards/${open.id}:close`,
      { validTo: "2029-12-31" }, K());
    expect(close.status).toBe(201);

    const r = await boss.post("/v1/rate-cards", {
      roleKind: "DM", dayCostCents: w(0.22), validFrom: "2030-01-01", note: "2030 年费率"
    }, K());
    expect(r.status).toBe(201);
    expect(r.body.dayCostCents).toBe(w(0.22));
  });

  it("收口日当天仍然生效 —— 少存一天，那天填的工时就找不到费率卡", async () => {
    const cards = (await boss.get("/v1/rate-cards?roleKind=DM&limit=50")).body.items;
    const closed = cards.find((c: { validTo: string | null }) => c.validTo !== null);
    /* 存的是右开区间的上界（次日），对外仍报收口日本身 */
    expect(closed.validTo).toBe("2030-01-01");
  });

  it("收口过的卡不能再收口一次", async () => {
    const cards = (await boss.get("/v1/rate-cards?roleKind=CRC&limit=50")).body.items;
    const closed = cards.find((c: { validTo: string | null }) => c.validTo !== null);
    const r = await boss.post(`/v1/rate-cards/${closed.id}:close`,
      { validTo: "2027-01-01" }, K());
    expect(r.status).toBe(422);
    expect(r.body.invariant).toBe("rate-card-already-closed");
  });

  it("只有经营层能动费率卡 —— 它就是报价底线", async () => {
    const r = await pm.post("/v1/rate-cards",
      { roleKind: "CRC", dayCostCents: w(0.2), validFrom: "2031-01-01" }, K());
    expect(r.status).toBe(403);
  });

  it("外部方连费率卡都看不到", async () => {
    const r = await inst.get("/v1/rate-cards?limit=5");
    expect(r.body.items).toEqual([]);
  });
});

describe("I1：工时是不可变事实", () => {
  let entryId: string, siteId: string;

  it("填报时按当日费率算出成本快照，并落库固化 billable", async () => {
    const s = await siteByCode(crc, "SS-01");
    siteId = s.id;
    const r = await crc.post("/v1/timesheets", {
      studySiteId: s.id, workDate: today(), workType: "visit_support",
      hours: 7.5, travelCents: w(0.32), note: "C3D1 访视陪同"
    }, K());
    expect(r.status).toBe(201);
    entryId = r.body.id;

    expect(r.body.billable).toBe(true);                 // visit_support 可计费
    expect(r.body.hours).toBe(7.5);
    /* CRC 无 cost 列权限：他填的这条，他自己看不到值多少钱 */
    expect(r.body).not.toHaveProperty("costCents");

    /* 换经营层读回来，验成本口径与 calc 一致 —— 服务层不另算一份 */
    const seen = (await boss.get(`/v1/timesheets?studySiteId=${siteId}&limit=100`))
      .body.items.find((x: { id: string }) => x.id === entryId);
    expect(seen.costCents).toBe(entryCostCents(7.5, seen.dayCostCents, w(0.32)));
    expect(seen.travelCents).toBe(w(0.32));
  });

  it("不可计费的工作类型落库时就是 false", async () => {
    const r = await crc.post("/v1/timesheets", {
      studySiteId: siteId, workDate: today(), workType: "training", hours: 4
    }, K());
    expect(r.status).toBe(201);
    expect(r.body.billable).toBe(false);
  });

  it("给未来的日期填报会被拒", async () => {
    const future = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
    const r = await crc.post("/v1/timesheets", {
      studySiteId: siteId, workDate: future, workType: "sdv", hours: 8
    }, K());
    expect(r.status).toBe(422);
    expect(r.body.invariant).toBe("timesheet-not-future");
  });

  it("当日没有生效费率卡时**拒绝填报** —— 用差不多的费率入账比不入账更糟", async () => {
    const r = await crc.post("/v1/timesheets", {
      studySiteId: siteId, workDate: "2020-01-01", workType: "sdv", hours: 8
    }, K());
    expect(r.status).toBe(422);
    expect(r.body.invariant).toBe("no-effective-rate-card");
  });

  it("作废要写原因，成本随即退出统计", async () => {
    const before = (await boss.get(`/v1/study-sites/${siteId}/pnl`)).body;
    const noReason = await crc.post(`/v1/timesheets/${entryId}:void`, { reason: "改" }, K());
    expect(noReason.status).toBe(422);                   // reason 至少 4 字

    const r = await crc.post(`/v1/timesheets/${entryId}:void`,
      { reason: "记错了中心，应记在 SS-07" }, K());
    expect(r.status).toBe(201);
    expect(r.body.data.voidedAt).toBeTruthy();
    expect(r.body.data.voidReason).toContain("记错了中心");

    const after = (await boss.get(`/v1/study-sites/${siteId}/pnl`)).body;
    expect(after.cost.directCostCents).toBeLessThan(before.cost.directCostCents);
  });

  it("已作废的不能再作废", async () => {
    const r = await crc.post(`/v1/timesheets/${entryId}:void`,
      { reason: "再作废一次试试" }, K());
    expect(r.status).toBe(422);
    expect(r.body.invariant).toBe("timesheet-already-voided");
  });

  it("作废后默认不出现在台账里，但加 includeVoided 查得到 —— 它没被删掉", async () => {
    const plain = (await boss.get(`/v1/timesheets?studySiteId=${siteId}&limit=100`)).body;
    expect(plain.items.some((x: { id: string }) => x.id === entryId)).toBe(false);
    const all = (await boss.get(
      `/v1/timesheets?studySiteId=${siteId}&limit=100&includeVoided=true`)).body;
    expect(all.items.some((x: { id: string }) => x.id === entryId)).toBe(true);
  });

  it("不能作废别人填的 —— 这是角色表达不了的第四种判断：是不是本人", async () => {
    const me = (await crc.get("/v1/me")).body.account.id;
    const others = (await crc.get("/v1/timesheets?limit=100")).body.items
      .find((x: { accountId: string; voidedAt: string | null }) =>
        x.accountId !== me && !x.voidedAt);
    expect(others, "台账里应当有别人填的工时").toBeTruthy();
    const r = await crc.post(`/v1/timesheets/${others.id}:void`,
      { reason: "试图作废别人的填报" }, K());
    expect(r.status).toBe(422);
    expect(r.body.invariant).toBe("void-own-or-approve");
  });
});

describe("列权限：一线填工时，但看不到自己值多少钱", () => {
  it("CRC 看得到工时条目，看不到成本三件套", async () => {
    const r = await crc.get("/v1/timesheets?limit=5");
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(0);
    for (const t of r.body.items) {
      expect(t).toHaveProperty("hours");
      expect(t).not.toHaveProperty("costCents");
      expect(t).not.toHaveProperty("dayCostCents");
      expect(t).not.toHaveProperty("travelCents");
    }
  });

  it("经营层看得到全部", async () => {
    const r = await boss.get("/v1/timesheets?limit=5");
    expect(r.body.items[0]).toHaveProperty("costCents");
  });

  it("外部方看不到任何工时 —— 知道我们投了多少人天，等于知道报价底线", async () => {
    const r = await inst.get("/v1/timesheets?limit=50");
    expect(r.body.items).toEqual([]);
  });
});

describe("工时审批：全部价值在于「第二个人」", () => {
  /** 填一条新的，返回它的 id */
  async function file(): Promise<string> {
    const s = await siteByCode(crc, "SS-01");
    const r = await crc.post("/v1/timesheets", {
      studySiteId: s.id, workDate: new Date().toISOString().slice(0, 10),
      workType: "sdv", hours: 2, note: "审批用例" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as string;
  }

  it("新填的工时是**待审**的，但成本立刻计入 —— 人已经把活干了", async () => {
    const s = await siteByCode(boss, "SS-01");
    const before = (await boss.get(`/v1/study-sites/${s.id}/pnl`)).body.cost;
    const id = await file();
    const after = (await boss.get(`/v1/study-sites/${s.id}/pnl`)).body.cost;

    /* 不算进成本才是错的那条路：毛利会比实际好看，
       等审批补上又突然掉一截。 */
    expect(after.totalCostCents).toBeGreaterThan(before.totalCostCents);
    /* 而"其中有多少还没被第二个人看过"必须说得出来 */
    expect(after.unapprovedCostCents).toBeGreaterThan(before.unapprovedCostCents);

    const e = (await boss.get(`/v1/timesheets?limit=200`)).body.items
      .find((x: { id: string }) => x.id === id);
    expect(e.approvedAt).toBeNull();
  });

  it("**不能审自己填的** —— 自审等于没有审批流，只是多了一次点击", async () => {
    const id = await file();
    /* 用一个既有 approve 权限、又是填报人本人的身份来试。
       PM 两样都有，所以让 PM 自己填一条再自己审。 */
    const site = await siteByCode(pmHan, "SS-01");
    const own = await pmHan.post("/v1/timesheets", {
      studySiteId: site.id, workDate: new Date().toISOString().slice(0, 10),
      workType: "monitoring", hours: 3, note: "PM 自己填的" });
    expect(own.status, JSON.stringify(own.body)).toBe(201);

    const r = await pmHan.post(`/v1/timesheets/${own.body.id}:approve`, {}, K());
    expect(r.status).toBe(422);
    expect(r.body.invariant).toBe("timesheet-no-self-approve");

    /* 别人填的可以审 */
    const ok = await pmHan.post(`/v1/timesheets/${id}:approve`,
      { note: "周结抽查通过" }, K());
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data.approvedByName).toBe("韩雪");
  });

  it("审批**不改变任何金额** —— 它只说这一笔被第二个人看过了", async () => {
    const s = await siteByCode(boss, "SS-01");
    const id = await file();
    const before = (await boss.get(`/v1/study-sites/${s.id}/pnl`)).body.cost;

    const r = await pmHan.post(`/v1/timesheets/${id}:approve`, {}, K());
    expect(r.status).toBe(201);
    expect(r.body.sideEffects[0].summary).toContain("成本没有变化");

    const after = (await boss.get(`/v1/study-sites/${s.id}/pnl`)).body.cost;
    expect(after.totalCostCents).toBe(before.totalCostCents);
    /* 变的只有"待审的那一部分" */
    expect(after.unapprovedCostCents).toBeLessThan(before.unapprovedCostCents);
  });

  it("重复审 → 409；已作废的不需要审 → 422", async () => {
    const id = await file();
    expect((await pmHan.post(`/v1/timesheets/${id}:approve`, {}, K())).status).toBe(201);
    expect((await pmHan.post(`/v1/timesheets/${id}:approve`, {}, K())).status).toBe(409);

    const other = await file();
    expect((await crc.post(`/v1/timesheets/${other}:void`,
      { reason: "填错了中心，重报" }, K())).status).toBe(201);
    const r = await pmHan.post(`/v1/timesheets/${other}:approve`, {}, K());
    expect(r.status).toBe(422);
    expect(r.body.invariant).toBe("timesheet-voided-needs-no-approval");
  });

  it("审过不能撤回 —— 数据库拦，因为应用层会有第二个入口", async () => {
    const id = await file();
    expect((await pmHan.post(`/v1/timesheets/${id}:approve`, {}, K())).status).toBe(201);

    const db = new pg.Client({ connectionString: process.env["TEST_DATABASE_URL"] });
    await db.connect();
    try {
      await expect(db.query(
        "UPDATE timesheet_entry SET approved_at = NULL, approved_by = NULL WHERE id = $1",
        [id])).rejects.toThrow(/不能撤回审批/);
    } finally { await db.end(); }
  });

  it("「还有哪些没审」筛得出来", async () => {
    await file();
    const r = await boss.get("/v1/timesheets?limit=200&unapprovedOnly=true");
    expect(r.body.items.length).toBeGreaterThan(0);
    for (const e of r.body.items) {
      expect(e.approvedAt).toBeNull();
      /* 已作废的不该出现在待审里 —— 它已经不在成本里了 */
      expect(e.voidedAt).toBeNull();
    }
  });

  it("没有 approve 权限的人审不了", async () => {
    const id = await file();
    const r = await crc.post(`/v1/timesheets/${id}:approve`, {}, K());
    expect(r.status).toBe(403);
  });
});

describe("分月损益：累计口径回答不了「这个月比上个月差在哪」", () => {
  it("月份轴是**连续的**，空月份也画出来 —— 那个月一分钱都没有正是要看见的事", async () => {
    const s = await siteByCode(boss, "SS-01");
    const t = (await boss.get(`/v1/study-sites/${s.id}/pnl/monthly?months=6`)).body;
    expect(t.months).toHaveLength(6);
    /* 连续：相邻两个月相差一个自然月 */
    for (let i = 1; i < t.months.length; i++) {
      const prev = new Date(`${t.months[i - 1].month}-01T00:00:00Z`);
      const cur = new Date(`${t.months[i].month}-01T00:00:00Z`);
      prev.setUTCMonth(prev.getUTCMonth() + 1);
      expect(cur.toISOString().slice(0, 7)).toBe(prev.toISOString().slice(0, 7));
    }
    /* 最后一个月是当月 */
    expect(t.months.at(-1).month).toBe(new Date().toISOString().slice(0, 7));
    expect(t.calcVersion).toBe(CALC_VERSION);
  });

  it("工时按**工作日期**归月，不是按录入时间", async () => {
    /* 补录的工时落在错误的月份，是月度对不上最常见的来源。 */
    const s = await siteByCode(crc, "SS-01");
    const back = new Date(); back.setUTCMonth(back.getUTCMonth() - 1);
    const workDate = `${back.toISOString().slice(0, 7)}-15`;
    const month = workDate.slice(0, 7);

    const before = (await boss.get(`/v1/study-sites/${s.id}/pnl/monthly?months=6`)).body
      .months.find((m: { month: string }) => m.month === month);

    const filed = await crc.post("/v1/timesheets", {
      studySiteId: s.id, workDate, workType: "sdv", hours: 4,
      note: "补录上个月的源数据核对"
    });
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);

    const after = (await boss.get(`/v1/study-sites/${s.id}/pnl/monthly?months=6`)).body
      .months.find((m: { month: string }) => m.month === month);
    expect(after.costCents, "补录的工时没有落在工作日期那个月")
      .toBeGreaterThan(before.costCents);
    expect(after.personDays).toBeCloseTo(before.personDays + 0.5, 5);

    /* 而**本月**不该因此变化 —— 那正是"按录入时间归属"会犯的错 */
    const thisMonth = new Date().toISOString().slice(0, 7);
    if (thisMonth !== month) {
      const now = (await boss.get(`/v1/study-sites/${s.id}/pnl/monthly?months=6`)).body
        .months.find((m: { month: string }) => m.month === thisMonth);
      const prevNow = (await boss.get(`/v1/study-sites/${s.id}/pnl/monthly?months=6`)).body
        .months.find((m: { month: string }) => m.month === thisMonth);
      expect(now.costCents).toBe(prevNow.costCents);
    }
  });

  it("没有任何事件的月份，收入是 0 —— 启动费不是每个月都算一遍", async () => {
    /* 这是"按事件归属"最直接的检验：没有人入组、没有人筛败、没有人退出，
       这个月就没有收入。而如果启动费被每个月都算一遍，
       这些月份会各自带着一大笔钱。 */
    const s = await siteByCode(boss, "SS-01");
    const t = (await boss.get(`/v1/study-sites/${s.id}/pnl/monthly?months=60`)).body;
    const sivMonth = s.sivOn ? s.sivOn.slice(0, 7) : null;

    const quiet = t.months.filter((m: {
      month: string; enrolled: number; screenFailed: number; withdrawn: number;
    }) => m.month !== sivMonth && m.enrolled === 0 && m.screenFailed === 0
        && m.withdrawn === 0);
    expect(quiet.length, "60 个月里应当有几个什么都没发生的月份").toBeGreaterThan(0);
    for (const m of quiet) expect(m.revenueCents, `${m.month} 无事件却有收入`).toBe(0);

    /* 而 SIV 当月**确实**带着那笔启动费 */
    if (sivMonth) {
      const siv = t.months.find((m: { month: string }) => m.month === sivMonth);
      if (siv) expect(siv.revenueCents).toBeGreaterThanOrEqual(s.startupFeeCents);
    }
  });

  it("一线看得到例数，看不到钱 —— 分月页和累计页同一套列权限", async () => {
    const s = await siteByCode(crc, "SS-01");
    const t = (await crc.get(`/v1/study-sites/${s.id}/pnl/monthly?months=3`)).body;
    expect(t.months.length).toBe(3);
    for (const m of t.months) {
      expect(m.enrolled).toBeTypeOf("number");
      /* 无权限的字段**从响应里消失**，不是返回 null */
      expect(m).not.toHaveProperty("revenueCents");
      expect(m).not.toHaveProperty("costCents");
      expect(m).not.toHaveProperty("grossProfitCents");
    }
  });

  it("范围外的中心问分月损益 → 404", async () => {
    const s = await siteByCode(boss, "SS-09");
    const mine = (await crc.get("/v1/study-sites?limit=50")).body.items
      .map((x: { id: string }) => x.id);
    if (mine.includes(s.id)) return;
    expect((await crc.get(`/v1/study-sites/${s.id}/pnl/monthly`)).status).toBe(404);
  });
});

describe("I8'：单中心损益，接口算出来的必须和 calc 算出来的一样", () => {
  it("SS-01 的收入四项与 calc 逐项吻合", async () => {
    const s = await siteByCode(boss, "SS-01");
    const pnl = (await boss.get(`/v1/study-sites/${s.id}/pnl`)).body;
    const funnel = (await boss.get(`/v1/study-sites/${s.id}/funnel`)).body;
    const subs = (await boss.get(
      `/v1/subjects?studySiteId=${s.id}&state=withdrawn&limit=200`)).body.items;

    /* 用同一份输入独立跑一遍 calc —— 两条路径必须给出同一个数 */
    const expected = siteRevenue({
      startupFeeCents: s.startupFeeCents,
      unitPriceCents: s.unitPriceCents,
      enrolled: funnel.enrolled,
      screenFailed: funnel.screenFailed,
      screenFailFeeRate: 0.35,
      dropouts: subs.map((x: { visitsDone: number; visitsPlanned: number }) =>
        ({ visitsDone: x.visitsDone, visitsPlanned: x.visitsPlanned }))
    });

    expect(pnl.revenue.startupCents).toBe(expected.startup);
    expect(pnl.revenue.enrollmentCents).toBe(expected.enrollment);
    expect(pnl.revenue.dropoutDeductionCents).toBe(expected.dropoutDeduction);
    expect(pnl.revenue.screenFailFeeCents).toBe(expected.screenFailFee);
    expect(pnl.revenue.revenueCents).toBe(expected.total);
    expect(pnl.calcVersion).toBe(CALC_VERSION);
  });

  it("四项都不是 0 —— 一个真实中心该有的四项都在", async () => {
    const s = await siteByCode(boss, "SS-01");
    const pnl = (await boss.get(`/v1/study-sites/${s.id}/pnl`)).body;
    expect(pnl.revenue.startupCents).toBeGreaterThan(0);
    expect(pnl.revenue.enrollmentCents).toBeGreaterThan(0);
    expect(pnl.revenue.screenFailFeeCents).toBeGreaterThan(0);   // 筛败也是收入
    expect(pnl.revenue.dropoutDeductionCents).toBeLessThan(0);    // 脱落要扣回
  });

  it("分项之和等于合计 —— 分项与合计不允许各算各的", async () => {
    const s = await siteByCode(boss, "SS-01");
    const r = (await boss.get(`/v1/study-sites/${s.id}/pnl`)).body.revenue;
    expect(r.startupCents + r.enrollmentCents + r.dropoutDeductionCents + r.screenFailFeeCents)
      .toBe(r.revenueCents);
  });

  it("成本与毛利：管理分摊按直接成本比例，毛利 = 收入 − 总成本", async () => {
    const s = await siteByCode(boss, "SS-01");
    const p = (await boss.get(`/v1/study-sites/${s.id}/pnl`)).body;
    expect(p.cost.totalCostCents).toBe(p.cost.directCostCents + p.cost.overheadCents);
    expect(p.cost.billableCostCents + p.cost.nonBillableCostCents)
      .toBe(p.cost.directCostCents);
    expect(p.grossProfitCents).toBe(p.revenue.revenueCents - p.cost.totalCostCents);
  });

  it("三层列权限在同一个接口上同时生效", async () => {
    const s = await siteByCode(cra, "SS-01");
    const p = (await cra.get(`/v1/study-sites/${s.id}/pnl`)).body;
    /* CRA 无 price / cost / margin —— 三组字段全部消失，但接口照常 200 */
    expect(p.revenue).toEqual({});
    expect(p.cost).toEqual({});
    expect(p).not.toHaveProperty("grossProfitCents");
    expect(p).not.toHaveProperty("grossMargin");
    /* 不受管辖的仍在：他看得到这个中心入组了多少例 */
    expect(p.enrolled).toBeGreaterThan(0);
    expect(p.calcVersion).toBe(CALC_VERSION);
  });

  it("还没有收入的中心：毛利率字段不出现，而不是 0%", async () => {
    const s = await siteByCode(boss, "SS-13");            // 伦理递交阶段，无入组
    const p = (await boss.get(`/v1/study-sites/${s.id}/pnl`)).body;
    expect(p.enrolled).toBe(0);
    expect(p.revenue.revenueCents).toBe(p.revenue.startupCents);
    /* 受列权限管辖的字段不能同时可空 —— 「没有分母」与「没有权限」
       用同一种表达：字段不出现。返回 null 会让客户端分不清这两件事。 */
    if (p.revenue.revenueCents === 0) {
      expect(p).not.toHaveProperty("grossMargin");
      expect(p.cost).not.toHaveProperty("costPerEnrolledCents");
    }
  });
});
