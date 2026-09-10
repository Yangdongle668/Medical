import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { boot, resetDb, as, type Caller } from "./harness.js";

const idem = () => ({ "Idempotency-Key": randomUUID() });

/* ════════════════════════════════════════════════════════════════════
   立项与建档。

   这一组盯的是**这条流程最容易漏的几格**：
     · 提交人自己批自己 —— 门槛只是多点一次鼠标；
     · 批准了但项目档案没建 —— 批的人以为建了，做的人以为会自动建；
     · 退回不说理由 —— 提交人只能猜，猜错就拿着同一份价格再谈一轮；
     · 调用方自己报毛利率 —— 门槛形同虚设。
   ════════════════════════════════════════════════════════════════════ */

let app: INestApplication;
let boss: Caller, pm: Caller, crc: Caller, inst: Caller;

beforeAll(async () => {
  resetDb(); app = await boot();
  boss = await as(app, "lingyuan");
  pm   = await as(app, "hanxue");
  crc  = await as(app, "wutong");
  inst = await as(app, "zhanghm");
}, 180_000);
afterAll(async () => { await app?.close(); });

const list = async (c: Caller, qs = "") =>
  (await c.get(`/v1/intake-applications?limit=100${qs}`)).body.items as any[];

describe("立项台账", () => {
  it("种子里的两条申请都在，毛利率由服务端算", async () => {
    const items = await list(boss);
    expect(items.length).toBeGreaterThanOrEqual(2);
    const low = items.find(x => x.code === "NP-2026-011");
    expect(low.grossMargin).toBeCloseTo(0.205, 3);
    expect(low.belowGate).toBe(true);
    /* 保本合同额比毛利率更能推动谈判 */
    expect(low.breakEvenContractCents).toBeGreaterThan(low.contractCents);
  });

  it("**越线的排最前** —— 按提交日排的话它会沉在底下", async () => {
    const items = await list(boss);
    expect(items[0].belowGate).toBe(true);
  });

  it("**外部方一条都看不到** —— 看得到我们按什么毛利率接项目，下轮就不用谈了",
    async () => {
      expect(await list(inst)).toHaveLength(0);
      const b = await inst.get("/v1/intake-applications/board");
      expect(b.status).toBe(200);
      expect(b.body.open).toBe(0);
    });

  it("金额与毛利受列权限管辖 —— CRC 看得到项目，看不到账", async () => {
    const items = await list(crc);
    if (items[0]) {
      expect("contractCents" in items[0], "CRC 没有 price").toBe(false);
      expect("grossMargin" in items[0], "CRC 没有 margin").toBe(false);
      /* 越线这件事本身不是钱 —— 它照常给 */
      expect(typeof items[0].belowGate).toBe("boolean");
    }
  });

  it("**看板上的合计金额同样受列权限管辖**", async () => {
    const rich = (await boss.get("/v1/intake-applications/board")).body;
    expect(rich.openContractCents).toBeGreaterThan(0);
    const thin = (await crc.get("/v1/intake-applications/board")).body;
    expect("openContractCents" in thin, "CRC 没有 price 列权限").toBe(false);
    /* 建档滞后不是钱 —— 它照常给 */
    expect(thin.missingSites).toBeGreaterThan(0);
    expect("contractCents" in thin.studies[0], "项目合同额同样要删").toBe(false);
  });

  it("只看越线的：筛在 SQL 里，不是取回来再筛", async () => {
    const all = await list(boss);
    const low = await list(boss, "&belowGateOnly=true");
    expect(low.length).toBeGreaterThan(0);
    expect(low.length).toBeLessThan(all.length + 1);
    for (const x of low) expect(x.belowGate).toBe(true);
  });
});

describe("建档滞后", () => {
  it("**合同写了几个中心 vs 系统里建了几个**", async () => {
    const b = (await boss.get("/v1/intake-applications/board")).body;
    expect(b.studies.length).toBeGreaterThanOrEqual(4);
    for (const s of b.studies) {
      expect(s.plannedSites).toBeGreaterThan(0);
      expect(s.builtSites).toBeGreaterThanOrEqual(0);
      expect(s.missingSites).toBeGreaterThanOrEqual(0);
    }
    /* 原型的 STUDIES 合同中心数合计 46，SITES 只铺了 15 —— 差得很明显 */
    expect(b.missingSites).toBeGreaterThan(0);
  });

  it("**差得最多的排最前**", async () => {
    const b = (await boss.get("/v1/intake-applications/board")).body;
    const m = b.studies.map((s: any) => s.missingSites);
    expect([...m].sort((x: number, y: number) => y - x)).toEqual(m);
  });

  it("**建得比合同多不算负数** —— 那是合同变更那一页的事", async () => {
    const b = (await boss.get("/v1/intake-applications/board")).body;
    for (const s of b.studies) expect(s.missingSites).toBeGreaterThanOrEqual(0);
  });
});

describe("提交与审批", () => {
  const body = (over: Record<string, unknown> = {}) => ({
    drug: "KY-309 胶囊（BTK 抑制剂）", sponsorName: "新芽生物", phase: "II期",
    indication: "复发难治性套细胞淋巴瘤",
    plannedSites: 10, plannedSubjects: 90, enrollMonths: 18,
    contractCents: 900_0000_00, estimatedCostCents: 600_0000_00,
    note: "新客户，中心多为未合作医院，启动成本不可复用。", ...over
  });

  it("**CRC 提交不了立项** —— 没有 bid 动作权限", async () => {
    expect((await crc.post("/v1/intake-applications", body(), idem())).status).toBe(403);
  });

  it("PM 提交：越线的会在副作用里直说", async () => {
    const r = await pm.post("/v1/intake-applications",
      body({ estimatedCostCents: 800_0000_00 }), idem());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.belowGate).toBe(true);
    expect(r.body.sideEffects[0].summary).toContain("低于");
    /* **毛利率不接受调用方传入** —— 它是算出来的 */
    expect(r.body.data.grossMargin).toBeCloseTo((900 - 800) / 900, 4);
  });

  it("**提交人不能批准自己的申请**", async () => {
    const a = (await pm.post("/v1/intake-applications", body(), idem())).body.data;
    const r = await pm.post(`/v1/intake-applications/${a.id}:decide`,
      { result: "approved" }, idem());
    expect(r.status).toBe(422);
    expect(r.body.invariant).toBe("intake-self-approval");
  });

  it("**退回必须写理由**", async () => {
    const a = (await pm.post("/v1/intake-applications", body(), idem())).body.data;
    const bare = await boss.post(`/v1/intake-applications/${a.id}:decide`,
      { result: "returned" }, idem());
    expect(bare.status).toBe(422);
    expect(bare.body.invariant).toBe("intake-return-needs-reason");

    const ok = await boss.post(`/v1/intake-applications/${a.id}:decide`,
      { result: "returned", reason: "毛利率虽达标，但新客户账期未谈定，先补一轮" }, idem());
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data.state).toBe("returned");
    expect(ok.body.data.decisionNote).toContain("账期");
    expect(ok.body.sideEffects[0].summary).toContain("已退回 韩雪");
  });

  it("**批准会在同一个事务里建出项目档案与客户**", async () => {
    const before = (await boss.get("/v1/intake-applications/board")).body.studies.length;
    const a = (await pm.post("/v1/intake-applications", body(), idem())).body.data;
    const r = await boss.post(`/v1/intake-applications/${a.id}:decide`,
      { result: "approved" }, idem());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.state).toBe("approved");
    expect(r.body.data.studyCode).toMatch(/^HJ-\d{4}-\d{3}$/);
    expect(r.body.sideEffects[0].summary).toContain("一个都还没建档");

    /* 项目档案真的建出来了，而且带着合同中心数 */
    const board = (await boss.get("/v1/intake-applications/board")).body;
    expect(board.studies.length).toBe(before + 1);
    const made = board.studies.find((s: any) => s.studyCode === r.body.data.studyCode);
    expect(made.plannedSites).toBe(10);
    expect(made.builtSites).toBe(0);
    expect(made.missingSites).toBe(10);
    /* 新客户也一起建了 */
    expect(made.clientName).toBe("新芽生物");
  });

  it("决定过一次就不能再决定", async () => {
    const a = (await pm.post("/v1/intake-applications", body(), idem())).body.data;
    await boss.post(`/v1/intake-applications/${a.id}:decide`,
      { result: "returned", reason: "先退回一次" }, idem());
    const again = await boss.post(`/v1/intake-applications/${a.id}:decide`,
      { result: "approved" }, idem());
    expect(again.status).toBe(422);
    expect(again.body.invariant).toBe("intake-already-decided");
  });
});

/* ════════════════════════════════════════════════════════════════════
   批准之后：新项目在「选项目」那一栏里出得来吗？

   这一组补的是一个**死锁**，而不是一条权限规则：
   `listStudies` 原来的范围写作「只返回本行范围内有中心的项目」，
   而 EXISTS 在空集上恒为假 —— 刚批下来的项目一个中心都没有，
   于是它谁也看不见，连 row_rule=all 的管理员也看不见
   （数据库策略里一直有那个短路，是应用层手写的 WHERE 漏了）。
   而中心可行性调查、中心建档、立项受理递交、合同变更
   这四张表单第一栏都是「选项目」：
   **项目要有中心才看得见，中心要先选中项目才建得出来。**

   第二把锁在 team_study：批准立项从来没往里写过一行（只有 seed 灌过），
   于是每个真正走完流程的项目都没有归属组，
   而做可行性调查的正是 pm —— 行范围 team。

   下面这条测试走的是完整的一趟：批准 → 选到项目 → 登记可行性 → 建中心。
   ════════════════════════════════════════════════════════════════════ */
describe("批准之后，项目要能被选到", () => {
  const fresh = () => ({
    drug: `LK-${Math.floor(Math.random() * 9000 + 1000)} 注射液`,
    sponsorName: "长空药业", phase: "III期", indication: "转移性结直肠癌",
    plannedSites: 8, plannedSubjects: 120, enrollMonths: 20,
    contractCents: 1200_0000_00, estimatedCostCents: 700_0000_00
  });

  /** 批一个新项目出来，返回它的 code */
  async function 批一个() {
    const a = (await pm.post("/v1/intake-applications", fresh(), idem())).body.data;
    const r = await boss.post(`/v1/intake-applications/${a.id}:decide`,
      { result: "approved" }, idem());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.data.studyCode as string;
  }

  const codes = async (c: Caller) =>
    ((await c.get("/v1/studies?limit=100")).body.items as { code: string }[])
      .map(s => s.code);

  it("**经营层立刻在项目列表里看得到它** —— 它一个中心都还没有", async () => {
    const code = await 批一个();
    expect(await codes(boss), "刚批下来的项目不在项目列表里").toContain(code);
  });

  it("**承接它的那个组也看得到** —— 可行性调查是在建中心之前做的", async () => {
    const code = await 批一个();
    /* 提交人是 hanxue（PM，行范围 team）。归属组由批准那一步写入 team_study。 */
    expect(await codes(pm), "项目组看不到自己刚接下的项目").toContain(code);
  });

  it("别的组看不到 —— 修的是死锁，不是把范围放开", async () => {
    const code = await 批一个();
    const 别的组 = await as(app, "cendi");   // 另一个 PM，另一个组
    expect(await codes(别的组)).not.toContain(code);
  });

  it("外部方（机构办）看不到 —— 它连一个中心都还没有", async () => {
    const code = await 批一个();
    expect(await codes(inst)).not.toContain(code);
  });

  it("**选得到之后，可行性和建档这两步真的走得通**", async () => {
    const code = await 批一个();
    const study = ((await pm.get("/v1/studies?limit=100")).body.items as
      { id: string; code: string }[]).find(s => s.code === code);
    expect(study, `${code} 不在 PM 的项目列表里，后面两步无从谈起`).toBeTruthy();

    /* 一、登记一次可行性调查 —— 用户卡住的正是这一步 */
    const feas = await pm.post("/v1/feasibility", {
      studyId: study!.id, hospital: "长空附属医院", city: "杭州",
      dept: "肿瘤内科", piName: "秦望", surveyedOn: "2026-09-10",
      answers: {
        ptYear: 600, pastN: 3, pastBest: 5, compet: 1,
        ethicsDays: 30, startDays: 45, teamN: 6, piCommit: 4, eligPct: 0.35
      }
    }, idem());
    expect(feas.status, JSON.stringify(feas.body)).toBe(201);

    /* 二、给它建第一个中心 */
    const site = await pm.post("/v1/study-sites", {
      studyId: study!.id, code: `${code}-01`, hospital: "长空附属医院",
      dept: "肿瘤内科", city: "杭州", piName: "秦望",
      contracted: 15, unitPriceCents: 3_0000_00, startupFeeCents: 8_0000_00
    }, idem());
    expect(site.status, JSON.stringify(site.body)).toBe(201);
  });
});

/* ════════════════════════════════════════════════════════════════════
   方案编号：行数不是序号。

   原来这么取：`SELECT count(*) + 1 FROM study WHERE code LIKE 'HJ-2026-%'`。
   序号一旦有缺口，行数就永远追不上最大号，每次都撞在缺口后面那个
   已经用掉的号上 —— 演示数据里有 HJ-2026-004 而没有 001–003，
   于是**第三次批准必然 500**，报的是唯一约束冲突。
   而缺口是常态：删过项目、从别的系统迁过数据、跑过两个租户，都会留下。
   ════════════════════════════════════════════════════════════════════ */
describe("方案编号", () => {
  it("**连批四次都不撞号** —— 种子里已经占着 HJ-2026-004", async () => {
    const 已有 = ((await boss.get("/v1/studies?limit=100")).body.items as
      { code: string }[]).map(s => s.code);
    expect(已有, "这条测试的前提是种子里有一个带缺口的编号").toContain("HJ-2026-004");

    const 新的: string[] = [];
    for (let i = 0; i < 4; i++) {
      const a = (await pm.post("/v1/intake-applications", {
        drug: `编号测试 ${i}`, sponsorName: "长空药业", phase: "I期",
        indication: "编号测试", plannedSites: 2, plannedSubjects: 20,
        enrollMonths: 6, contractCents: 100_0000_00, estimatedCostCents: 60_0000_00
      }, idem())).body.data;
      const r = await boss.post(`/v1/intake-applications/${a.id}:decide`,
        { result: "approved" }, idem());
      expect(r.status, `第 ${i + 1} 次批准：${JSON.stringify(r.body)}`).toBe(201);
      新的.push(r.body.data.studyCode);
    }

    /* 既不撞已有的，彼此也不撞 */
    for (const c of 新的) expect(已有).not.toContain(c);
    expect(new Set(新的).size, `发出去的号有重复：${新的.join(" ")}`).toBe(4);
    /* 而且是接着**最大号**往下走的，不是随手挑一个没用过的。
       起点不能写死：同一个文件里前面的用例已经批过几个了。 */
    const 序号 = (c: string) => Number(c.slice("HJ-2026-".length));
    const 最大 = Math.max(...已有.filter(c => c.startsWith("HJ-2026-")).map(序号));
    expect(新的.map(序号)).toEqual([最大 + 1, 最大 + 2, 最大 + 3, 最大 + 4]);
  });
});
