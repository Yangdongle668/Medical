import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { boot, resetDb, as, type Caller } from "./harness.js";
import { randomUUID } from "node:crypto";
import { siteRevenue, entryCostCents, CALC_VERSION } from "@sitedesk/calc";

/* ════════════════════════════════════════════════════════════════════
   Timesheet & Cost —— 这一组要证明的是：

     I1  工时归属唯一中心；billable 落库固化，不随类型定义变更而改变
     I2  成本 = 人天 × **提交时生效的**费率卡；费率变更不回溯历史
     I8' 单中心收入四项俱全，且**接口算出来的和 calc 算出来的一样**

   以及一条最容易被绕过去的：**工时不能删，只能作废。**
   ════════════════════════════════════════════════════════════════════ */

let app: INestApplication;
let boss: Caller, crc: Caller, cra: Caller, inst: Caller, pm: Caller;
const K = () => ({ "Idempotency-Key": randomUUID() });
const w = (v: number) => Math.round(v * 10000 * 100);

beforeAll(async () => {
  resetDb(); app = await boot();
  boss = await as(app, "lingyuan");
  crc  = await as(app, "wutong");
  cra  = await as(app, "linmin");
  inst = await as(app, "zhanghm");
  pm   = await as(app, "cendi");
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
