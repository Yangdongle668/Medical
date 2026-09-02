import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { boot, resetDb, as, type Caller } from "./harness.js";

const idem = () => ({ "Idempotency-Key": randomUUID() });

/* ════════════════════════════════════════════════════════════════════
   投标闭环 · 合同变更。

   两组断言都围着同一件事：**不知道 ≠ 零。**
     · 问不到对手报价的那几标，不能当成「和我们报得一样」；
     · 变更金额为 NULL（还没谈）和为 0（谈过了不给钱）不是一回事。
   两处只要把 null 当 0，一次亏得很惨的事在统计上就毫无痕迹。
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

describe("投标 · 行范围与列权限", () => {
  it("经营层看得到八条", async () => {
    const r = await boss.get("/v1/bids?limit=50");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.items).toHaveLength(8);
  });

  it("**外部方一行都看不到** —— 投标价格是直接的商业损失", async () => {
    const r = await inst.get("/v1/bids?limit=50");
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(0);
  });

  it("拿不到 price 列的人：看得到投了几个标，看不到价", async () => {
    const r = await crc.get("/v1/bids?limit=50");
    expect(r.status).toBe(200);
    const one = r.body.items[0];
    expect(one).toBeDefined();
    /* **字段消失，不是置 null** —— 与全站同一条规矩 */
    expect("ourQuoteCents" in one, "报价不该出现").toBe(false);
    expect("winningPriceCents" in one, "成交价不该出现").toBe(false);
    expect(one.sponsor).toBeTruthy();
    expect(one.daysPerSubject).toBeGreaterThan(0);
  });
});

describe("报价偏差复盘", () => {
  it("中标率的分母是已出结果的，不是全部", async () => {
    const r = await boss.get("/v1/bids/review");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const all = await boss.get("/v1/bids?limit=50");
    const decided = all.body.items.filter(
      (b: { status: string }) => b.status !== "pending").length;
    expect(r.body.total).toBe(8);
    expect(r.body.decided).toBe(decided);
    expect(r.body.winRate).toBeCloseTo(r.body.won / decided, 6);
  });

  it("**失标偏差与总体偏差都给，且样本数一并下发**", async () => {
    const r = await boss.get("/v1/bids/review");
    expect(r.body.priceBias).not.toBeNull();
    expect(r.body.lostBias).not.toBeNull();
    expect(r.body.biasSamples).toBeGreaterThan(0);
    expect(r.body.lostBiasSamples).toBeGreaterThan(0);
    /* 中标的天然贴着成交价，所以失标偏差应当更大 —— 真相在那一边 */
    expect(r.body.lostBias).toBeGreaterThan(r.body.priceBias);
  });

  it("种子里我们是**系统性报高**的 —— 那正是这条端点存在的理由", async () => {
    const r = await boss.get("/v1/bids/review");
    expect(r.body.priceBias).toBeGreaterThan(0);
  });

  it("带口径版本号", async () => {
    const r = await boss.get("/v1/bids/review");
    expect(r.body.calcVersion).toMatch(/^\d{4}\.\d+$/);
  });

  it("review 不能被当成一个 id —— 路由顺序", async () => {
    const r = await boss.get("/v1/bids/review");
    expect(r.status).toBe(200);
    expect("winRate" in r.body).toBe(true);
  });
});

describe("回写开标结果", () => {
  const pending = async () =>
    (await boss.get("/v1/bids?limit=50&status=pending")).body.items[0];

  it("中标必须填成交价 —— 那个数就在合同上", async () => {
    const b = await pending();
    expect(b, "种子里应该有一条待定的").toBeDefined();
    const bare = await boss.post(`/v1/bids/${b.id}:decide`, { result: "won" }, idem());
    expect(bare.status).toBe(422);
    expect(bare.body.detail).toContain("成交价");
  });

  it("**失标可以不填成交价**，而且要说清它不进统计", async () => {
    const created = await boss.post("/v1/bids", {
      sponsor: "某某药业", name: "问不到对手价的那一标",
      submittedOn: "2026-07-01", sites: 5, subjects: 60,
      ourQuoteCents: 80_000_00, ourPersonDays: 300
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const before = await boss.get("/v1/bids/review");
    const r = await boss.post(`/v1/bids/${created.body.id}:decide`,
      { result: "lost" }, idem());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    /* **字段不出现 = 问不到** —— 与全站同一条规矩（不是 null） */
    expect("winningPriceCents" in r.body.data).toBe(false);
    expect(r.body.data.gap).toBeNull();
    expect(r.body.sideEffects.map((s: { summary: string }) => s.summary).join(""))
      .toContain("不进偏差统计");

    /* **样本数不变** —— 把 null 当成"和我们一样"会让它 +1，
       而那一标的偏差会被记成 0。 */
    const after = await boss.get("/v1/bids/review");
    expect(after.body.biasSamples).toBe(before.body.biasSamples);
    expect(after.body.decided).toBe(before.body.decided + 1);
  });

  it("偏差大于 15% 要当场说出来", async () => {
    const created = await boss.post("/v1/bids", {
      sponsor: "某某药业", name: "报高了的那一标",
      submittedOn: "2026-07-02", sites: 5, subjects: 60,
      ourQuoteCents: 130_000_00, ourPersonDays: 300
    });
    const r = await boss.post(`/v1/bids/${created.body.id}:decide`,
      { result: "lost", winningPriceCents: 100_000_00 }, idem());
    expect(r.status).toBe(201);
    expect(r.body.data.gap).toBeCloseTo(0.3, 4);
    expect(r.body.sideEffects.map((s: { type: string }) => s.type))
      .toContain("BidDecided");
    expect(r.body.sideEffects[0].summary).toContain("系统性");
  });

  it("结果不能改 —— 开标只开一次", async () => {
    const done = (await boss.get("/v1/bids?limit=50&status=won")).body.items[0];
    const again = await boss.post(`/v1/bids/${done.id}:decide`,
      { result: "lost" }, idem());
    expect(again.status).toBe(422);
    expect(again.body.detail).toContain("已经出过结果");
  });

  it("CRC 没有 bid 动作：读得到，写不了", async () => {
    const b = await pending();
    if (!b) return;
    const r = await crc.post(`/v1/bids/${b.id}:decide`,
      { result: "won", winningPriceCents: 100_00 }, idem());
    expect(r.status).toBe(403);
  });
});

describe("合同变更", () => {
  it("受影响例数是**算出来的**，随入组进度变", async () => {
    const r = await boss.get("/v1/contract-changes?limit=50");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const perSubject = r.body.items.find((c: { perSubject: boolean }) => c.perSubject);
    expect(perSubject, "种子里应该有一条按例计的").toBeDefined();
    expect(perSubject.affectedSubjects).toBeGreaterThan(0);
    expect(perSubject.totalPersonDays)
      .toBeCloseTo(perSubject.personDaysImpact * perSubject.affectedSubjects, 4);
  });

  it("全项目的变更（studySiteId 为空）按项目下全部中心算例数", async () => {
    const r = await boss.get("/v1/contract-changes?limit=50");
    const whole = r.body.items.find(
      (c: { studySiteId: string | null; perSubject: boolean }) =>
        c.studySiteId === null && c.perSubject);
    const oneSite = r.body.items.find(
      (c: { studySiteId: string | null; perSubject: boolean }) =>
        c.studySiteId !== null && c.perSubject);
    if (whole && oneSite)
      expect(whole.affectedSubjects).toBeGreaterThan(oneSite.affectedSubjects);
  });

  it("**未覆盖工作量：三种「没有金额」都算，已签署的不算**", async () => {
    const r = await boss.get("/v1/contract-changes/scope-creep");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const list = await boss.get("/v1/contract-changes?limit=50");
    const open = list.body.items.filter(
      (c: { status: string }) => c.status !== "signed");
    expect(r.body.openCount).toBe(open.length);
    expect(r.body.uncoveredDays)
      .toBeCloseTo(open.reduce((n: number, c: { totalPersonDays: number }) =>
        n + c.totalPersonDays, 0), 4);
    expect(r.body.uncoveredCents).not.toBe(0);
    expect(Number.isInteger(r.body.uncoveredCents)).toBe(true);
  });

  it("覆盖率的分母用绝对值 —— 负人天不该把它做大", async () => {
    const r = await boss.get("/v1/contract-changes/scope-creep");
    expect(r.body.coverage).not.toBeNull();
    expect(r.body.coverage).toBeGreaterThanOrEqual(0);
    expect(r.body.coverage).toBeLessThanOrEqual(1);
  });

  it("uncoveredOnly 只留下没签的", async () => {
    const r = await boss.get("/v1/contract-changes?limit=50&uncoveredOnly=true");
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(0);
    for (const c of r.body.items) expect(c.status).not.toBe("signed");
  });

  it("已签署的 uncoveredCents 是 null —— 不是白做的", async () => {
    const r = await boss.get("/v1/contract-changes?limit=50&status=signed");
    expect(r.body.items.length).toBeGreaterThan(0);
    for (const c of r.body.items) expect("uncoveredCents" in c).toBe(false);
  });

  it("外部方一行都看不到", async () => {
    const r = await inst.get("/v1/contract-changes?limit=50");
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(0);
  });

  it("PM 只看本组承接项目下的", async () => {
    const mine = await pm.get("/v1/contract-changes?limit=50");
    expect(mine.status).toBe(200);
    const sites = await pm.get("/v1/study-sites?limit=100");
    const myStudies = new Set(
      sites.body.items.map((s: { study: { id: string } }) => s.study.id));
    for (const c of mine.body.items)
      expect(myStudies.has(c.study.id), `${c.code} 越界了`).toBe(true);
  });
});

describe("推进变更单", () => {
  const draft = async () =>
    (await boss.get("/v1/contract-changes?limit=50&status=draft")).body.items[0];

  it("**签署必须填金额，哪怕是 0**", async () => {
    const c = await draft();
    expect(c, "种子里应该有一条待提出的").toBeDefined();
    const bare = await boss.post(`/v1/contract-changes/${c.id}:settle`,
      { status: "signed" }, idem());
    expect(bare.status).toBe(422);
    expect(bare.body.detail).toContain("0 表示");

    const zero = await boss.post(`/v1/contract-changes/${c.id}:settle`,
      { status: "signed", settledCents: 0 }, idem());
    expect(zero.status, JSON.stringify(zero.body)).toBe(201);
    /* **0 不是欠账** —— 它从未覆盖工作量里出去了 */
    expect(zero.body.data.settledCents).toBe(0);
    expect("uncoveredCents" in zero.body.data).toBe(false);
  });

  it("未获批要当场把「白做多少」说出来", async () => {
    const created = await boss.post("/v1/contract-changes", {
      studyId: (await boss.get("/v1/studies?limit=1")).body.items[0].id,
      kind: "visit_add", raisedOn: "2026-08-01",
      what: "新增 EOT 后 30 天安全随访访视 1 次",
      personDaysImpact: 0.8, perSubject: true
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const r = await boss.post(`/v1/contract-changes/${created.body.id}:settle`,
      { status: "rejected", note: "申办方认为属安全性义务，不追加费用" }, idem());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.sideEffects.map((s: { type: string }) => s.type))
      .toContain("ScopeCreepRecorded");
    expect(r.body.sideEffects[0].summary).toContain("下次报价");
    /* 未获批**仍然算白做** —— 那正是它该留在系统里的理由 */
    expect(r.body.data.uncoveredCents).toBeGreaterThan(0);
  });

  it("了结之后不能再动", async () => {
    const signed = (await boss.get("/v1/contract-changes?limit=50&status=signed"))
      .body.items[0];
    const again = await boss.post(`/v1/contract-changes/${signed.id}:settle`,
      { status: "rejected" }, idem());
    expect(again.status).toBe(422);
    expect(again.body.detail).toContain("已经了结");
  });

  it("**中心必须属于这个项目** —— 挂错会算进别人的未覆盖工作量", async () => {
    const studies = await boss.get("/v1/studies?limit=10");
    const sites = await boss.get("/v1/study-sites?limit=100");
    const a = studies.body.items[0];
    const wrong = sites.body.items.find(
      (s: { study: { id: string } }) => s.study.id !== a.id);
    expect(wrong).toBeDefined();

    const r = await boss.post("/v1/contract-changes", {
      studyId: a.id, studySiteId: wrong.id, kind: "extend",
      raisedOn: "2026-08-01", what: "挂错项目的变更单",
      personDaysImpact: 10, perSubject: false
    });
    expect(r.status).toBe(422);
    expect(r.body.detail).toContain("不属于该项目");
  });
});
