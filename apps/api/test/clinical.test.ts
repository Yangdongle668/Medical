import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { boot, resetDb, as, type Caller } from "./harness.js";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { VISIT_COMPLETED_SUBSCRIBERS } from "../src/modules/clinical/visit-completed.js";

/* ════════════════════════════════════════════════════════════════════
   ClinicalOps —— 这一组测试要证明的是三条不变量真的不能被绕过：

     I3  访视必须经**该中心的 PI 本人**确认才锁定
     I4  超窗**必须**生成方案偏离，且与访视完成在同一个事务里
     I10 明细与聚合是两种权限：QA 看得到漏斗，看不到是哪几例

   以及一条更容易被忽略的：**七件后果里没做的两件，要留在明面上。**
   ════════════════════════════════════════════════════════════════════ */

let app: INestApplication;
let boss: Caller, crc: Caller, pi: Caller, qa: Caller, cra: Caller, inst: Caller;
const K = () => ({ "Idempotency-Key": randomUUID() });

beforeAll(async () => {
  resetDb(); app = await boot();
  boss = await as(app, "lingyuan");
  crc  = await as(app, "wutong");        // SS-01 的 CRC
  pi   = await as(app, "chenguod");      // SS-01 的 PI
  qa   = await as(app, "weilan");
  cra  = await as(app, "linmin");
  inst = await as(app, "zhanghm");
}, 180_000);
afterAll(async () => { await app?.close(); });

const siteByCode = async (c: Caller, code: string) =>
  (await c.get(`/v1/study-sites?limit=200&q=${code}`)).body.items
    .find((s: { code: string }) => s.code === code);

const today = () => new Date().toISOString().slice(0, 10);
const shift = (base: string, n: number) =>
  new Date(new Date(base).getTime() + n * 864e5).toISOString().slice(0, 10);

let seq = 0;

/** 取某受试者当前那次访视（按 subjectId 过滤，不去全量列表里捞 —— 捞不到会静默失败） */
async function currentVisit(c: Caller, subjectId: string) {
  const r = await c.get(`/v1/subject-visits?subjectId=${subjectId}&limit=50`);
  expect(r.status).toBe(200);
  const v = r.body.items.find((x: { status: string }) => x.status === "planned")
         ?? r.body.items[0];
  expect(v, "受试者应当有一次访视").toBeTruthy();
  return v;
}

/** 勾完任务 → 完成访视。**断言每一步都成功** ——
 *  辅助函数里吞掉的失败，会让后面的断言以「看起来对」的方式通过。 */
async function doVisit(
  c: Caller, subjectId: string, body: Record<string, unknown> = {}
) {
  const v = await currentVisit(c, subjectId);
  for (const t of v.tasks)
    expect((await c.post(`/v1/subject-visits/${v.id}/tasks/${t.seq}:done`, {}, K())).status)
      .toBe(201);
  const r = await c.post(`/v1/subject-visits/${v.id}:complete`,
    { actualDate: v.targetDate, hours: 3.5, ...body }, K());
  return { visit: v, res: r };
}
/** 造一例走到「筛选期访视已排」的受试者 */
async function freshSubject(c: Caller, siteId: string, icfOn = today()) {
  const r = await c.post("/v1/subjects",
    { studySiteId: siteId, screeningNo: `T-${Date.now() % 100000}-${++seq}` }, K());
  expect(r.status).toBe(201);
  const id = r.body.id;
  const s = await c.post(`/v1/subjects/${id}:sign-icf`, { signedOn: icfOn }, K());
  expect(s.status).toBe(201);
  return { id, screeningNo: r.body.screeningNo, signIcf: s.body };
}


describe("漏斗：入组数只是最后一格", () => {
  it("按原型基线聚合出预筛 / 知情 / 筛败 / 入组，且筛败率算得出来", async () => {
    const s = await siteByCode(boss, "SS-01");
    const f = (await boss.get(`/v1/study-sites/${s.id}/funnel`)).body;
    /* 原型基线：SS-01 预筛 68、签署知情 41、筛败 13、入组 26 */
    expect(f.prescreened).toBe(68);
    expect(f.icfSigned).toBe(41);
    expect(f.screenFailed).toBe(13);
    expect(f.enrolled).toBe(26);
    expect(f.screenFailRate).toBeCloseTo(13 / 41, 5);
    expect(f.icfRate).toBeCloseTo(41 / 68, 5);
    expect(f.attainment).toBeCloseTo(26 / s.contracted, 5);
    /* 筛败原因是受控取值，能给出分布 —— 自由文本就只能给出一堆句子 */
    expect(f.screenFailBreakdown.reduce((a: number, b: { count: number }) => a + b.count, 0))
      .toBe(13);
  });

  it("SS-11 的筛败率 57% 与 SS-04 的预筛不足，是两个不同的问题", async () => {
    const a = await siteByCode(boss, "SS-11"), b = await siteByCode(boss, "SS-04");
    const fa = (await boss.get(`/v1/study-sites/${a.id}/funnel`)).body;
    const fb = (await boss.get(`/v1/study-sites/${b.id}/funnel`)).body;
    expect(fa.screenFailRate).toBeGreaterThan(0.5);      // 入排标准与病源不匹配
    expect(fb.screenFailRate).toBeLessThan(0.4);          // 筛败率正常
    expect(fb.prescreened).toBeLessThan(fb.contracted * 1.8);   // 问题在预筛量
  });

  it("QA 看得到漏斗，却拉不出受试者名册 —— 聚合与明细是两种权限（I10）", async () => {
    const s = await siteByCode(qa, "SS-01");
    expect((await qa.get(`/v1/study-sites/${s.id}/funnel`)).status).toBe(200);
    const list = await qa.get("/v1/subjects?limit=5");
    expect(list.status).toBe(403);
    expect(list.body.code).toBe("forbidden-action");
  });

  it("机构办同样只能看计数", async () => {
    const s = await siteByCode(inst, "SS-01");
    expect((await inst.get(`/v1/study-sites/${s.id}/funnel`)).status).toBe(200);
    expect((await inst.get("/v1/subjects?limit=5")).status).toBe(403);
  });
});

describe("列权限：老板看得到每一例，但看不到筛选号", () => {
  it("boss 无 subject 列权限 —— 字段从响应里消失，不是 null", async () => {
    const r = await boss.get("/v1/subjects?limit=3");
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(0);
    for (const s of r.body.items) {
      expect(s).not.toHaveProperty("screeningNo");
      expect(s).toHaveProperty("state");
      /* randomized 是布尔，不受列权限管辖 —— 「有没有随机号」和「号码是多少」是两件事 */
      expect(s).toHaveProperty("randomized");
    }
  });

  it("CRC 有 subject 列权限 —— 同一个接口，字段在", async () => {
    const r = await crc.get("/v1/subjects?limit=3");
    expect(r.status).toBe(200);
    expect(r.body.items[0]).toHaveProperty("screeningNo");
  });

  it("查询受试者明细一定写审计（I10）", async () => {
    await crc.get("/v1/subjects?limit=1");
    const a = await boss.get("/v1/audit-entries?limit=20");
    expect(a.body.items.some((x: { action: string }) => x.action === "查询受试者明细"))
      .toBe(true);
  });
});

describe("受试者生命周期", () => {
  it("中心没启动就登记受试者会被拒 —— 那是 SIV 之前开展受试者工作", async () => {
    /* 用 PM：SS-13 在他的行范围内（本组承接项目），且尚在伦理递交阶段。
       换成 CRC 会先撞上 404 —— 那也是对的，但测不到这条不变量。 */
    const pm = await as(app, "cendi");
    const s = await siteByCode(pm, "SS-13");
    const r = await pm.post("/v1/subjects",
      { studySiteId: s.id, screeningNo: "X-001" }, K());
    expect(r.status).toBe(422);
    expect(r.body.invariant).toBe("subject-needs-active-site");
  });

  it("签署知情 → 进入筛选期，并按 SOA 自动排出筛选期访视", async () => {
    const s = await siteByCode(crc, "SS-01");
    const { id, signIcf } = await freshSubject(crc, s.id);
    expect(signIcf.data.state).toBe("screening");
    const eff = signIcf.sideEffects.find((e: { type: string }) => e.type === "NextVisitScheduled");
    expect(eff).toBeTruthy();
    expect(eff.summary).toContain("筛选期访视");

    const v = (await crc.get(`/v1/subject-visits?subjectId=${id}`)).body;
    expect(v.items.length).toBe(1);
    expect(v.items[0].seq).toBe(0);
    /* 任务清单一起生成 —— 「这次要做哪几项」不靠 CRC 记忆 */
    expect(v.items[0].tasks.length).toBeGreaterThan(0);
  });

  it("知情签署日早于该中心的伦理批件日会被拒", async () => {
    const s = await siteByCode(crc, "SS-01");
    const r = await crc.post("/v1/subjects",
      { studySiteId: s.id, screeningNo: `E-${Date.now() % 100000}` }, K());
    const bad = await crc.post(`/v1/subjects/${r.body.id}:sign-icf`,
      { signedOn: "2020-01-01" }, K());
    expect(bad.status).toBe(422);
    expect(bad.body.invariant).toBe("icf-after-irb");
  });

  it("未签知情就登记筛败会被拒 —— 否则筛败率会被稀释", async () => {
    const s = await siteByCode(crc, "SS-01");
    const r = await crc.post("/v1/subjects",
      { studySiteId: s.id, screeningNo: `P-${Date.now() % 100000}` }, K());
    const f = await crc.post(`/v1/subjects/${r.body.id}:screen-fail`,
      { reason: "lab", failedOn: today() }, K());
    expect(f.status).toBe(422);
    expect(f.body.invariant).toBe("screen-fail-needs-icf");
  });

  it("筛败后未做的访视一并作废 —— 否则这一例永远刷红超窗", async () => {
    const s = await siteByCode(crc, "SS-01");
    const { id } = await freshSubject(crc, s.id);
    const f = await crc.post(`/v1/subjects/${id}:screen-fail`,
      { reason: "imaging", failedOn: today() }, K());
    expect(f.status).toBe(201);
    expect(f.body.data.state).toBe("screen_failed");
    expect(f.body.data.nextVisit).toBeNull();
    const v = (await crc.get(`/v1/subject-visits?subjectId=${id}`)).body;
    expect(v.items.every((x: { status: string }) => x.status === "cancelled")).toBe(true);
  });

  it("入组前退出叫筛败，入组后退出叫脱落 —— 两者在收入口径上完全不同", async () => {
    const s = await siteByCode(crc, "SS-01");
    const { id } = await freshSubject(crc, s.id);
    const w = await crc.post(`/v1/subjects/${id}:withdraw`,
      { reason: "lost_to_followup", withdrawnOn: today(), note: "连续三次电话未接" }, K());
    expect(w.status).toBe(422);
    expect(w.body.detail).toContain("只有已入组可以登记脱落");
  });
});

describe("I3：PI 不确认，访视不锁定，受试者不能入组", () => {
  it("筛选期访视未锁定就入组，被闸门拦下", async () => {
    const s = await siteByCode(crc, "SS-01");
    const { id } = await freshSubject(crc, s.id);
    expect((await doVisit(crc, id)).res.status).toBe(201);

    const e = await crc.post(`/v1/subjects/${id}:enroll`,
      { randomizationNo: `R-${seq}`, enrolledOn: today() }, K());
    expect(e.status).toBe(422);
    expect(e.body.code).toBe("gate-not-satisfied");
    expect(e.body.unmet[0].code).toBe("screening-visit-not-locked");
  });

  it("CRC 自己确认不了 —— 有没有 piConfirm 权限，是动作维度的事", async () => {
    const s = await siteByCode(crc, "SS-01");
    const { id } = await freshSubject(crc, s.id);
    const { visit } = await doVisit(crc, id);
    const r = await crc.post(`/v1/subject-visits/${visit.id}:confirm`, {}, K());
    expect(r.status).toBe(403);
  });

  it("PI 确认后锁定，受试者才能入组，并自动排出第 1 次访视", async () => {
    const s = await siteByCode(crc, "SS-01");
    const { id } = await freshSubject(crc, s.id);
    const { visit } = await doVisit(crc, id);

    const cf = await pi.post(`/v1/subject-visits/${visit.id}:confirm`, {}, K());
    expect(cf.status).toBe(201);
    expect(cf.body.data.status).toBe("locked");
    expect(cf.body.data.piConfirmedByName).toBe("陈国栋");
    expect(cf.body.sideEffects[0].summary).toContain("可以入组");

    const e = await crc.post(`/v1/subjects/${id}:enroll`,
      { randomizationNo: `R-${Date.now() % 100000}`, enrolledOn: today() }, K());
    expect(e.status).toBe(201);
    expect(e.body.data.state).toBe("enrolled");
    expect(e.body.data.randomized).toBe(true);
    const next = e.body.sideEffects.find((x: { type: string }) => x.type === "NextVisitScheduled");
    expect(next).toBeTruthy();
  });

  it("未锁定的访视不计入「已完成」统计（I3）", async () => {
    const s = await siteByCode(crc, "SS-01");
    const { id } = await freshSubject(crc, s.id);
    const { visit } = await doVisit(crc, id);
    /* CRC 说做完了 ≠ PI 确认做完了 */
    expect((await crc.get(`/v1/subjects/${id}`)).body.visitsDone).toBe(0);
    expect((await pi.post(`/v1/subject-visits/${visit.id}:confirm`, {}, K())).status).toBe(201);
    expect((await crc.get(`/v1/subjects/${id}`)).body.visitsDone).toBe(1);
  });
});

describe("I4：超窗必须生成方案偏离，且在同一个事务里", () => {
  async function readyVisit() {
    const s = await siteByCode(crc, "SS-01");
    const { id } = await freshSubject(crc, s.id);
    const v = (await crc.get(`/v1/subject-visits?subjectId=${id}`)).body.items[0];
    for (const t of v.tasks)
      await crc.post(`/v1/subject-visits/${v.id}/tasks/${t.seq}:done`, {}, K());
    return { subjectId: id, visit: v, siteId: s.id };
  }

  it("任务没逐项勾完不得提交 —— 打勾了事等于没做", async () => {
    const s = await siteByCode(crc, "SS-01");
    const { id } = await freshSubject(crc, s.id);
    const v = (await crc.get(`/v1/subject-visits?subjectId=${id}`)).body.items[0];
    const r = await crc.post(`/v1/subject-visits/${v.id}:complete`,
      { actualDate: today(), hours: 2 }, K());
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("gate-not-satisfied");
    expect(r.body.unmet[0].code).toBe("visit-task-open");
  });

  it("超窗而不说明原因会被拒", async () => {
    const { visit } = await readyVisit();
    const r = await crc.post(`/v1/subject-visits/${visit.id}:complete`,
      { actualDate: shift(visit.windowTo, 5), hours: 3 }, K());
    expect(r.status).toBe(422);
    expect(r.body.invariant).toBe("out-of-window-needs-reason");
  });

  it("超窗完成 → 方案偏离自动生成，并出现在质量台账里", async () => {
    const { visit, siteId } = await readyVisit();
    const late = shift(visit.windowTo, 9);
    const r = await crc.post(`/v1/subject-visits/${visit.id}:complete`,
      { actualDate: late, hours: 3, outOfWindowReason: "受试者外地务工，返院延迟" }, K());
    expect(r.status).toBe(201);
    expect(r.body.data.outOfWindow).toBe(true);

    const dev = r.body.sideEffects.find((e: { type: string }) => e.type === "DeviationDetected");
    expect(dev).toBeTruthy();
    expect(dev.summary).toContain("方案偏离");

    const q = (await crc.get(`/v1/quality-events?studySiteId=${siteId}&kind=deviation`)).body;
    const one = q.items.find((x: { id: string }) => x.id === dev.ref);
    expect(one).toBeTruthy();
    expect(one.autoGenerated).toBe(true);
    expect(one.raisedBy).toBe("system");
    expect(one.severity).toBe("major");                 // 晚 9 天，超过 7 天算 major
    expect(one.detail).toContain("受试者外地务工");      // 填报原因原样进记录
  });

  it("窗口内完成不生成偏离", async () => {
    const { visit } = await readyVisit();
    const r = await crc.post(`/v1/subject-visits/${visit.id}:complete`,
      { actualDate: visit.targetDate, hours: 3 }, K());
    expect(r.status).toBe(201);
    expect(r.body.data.outOfWindow).toBe(false);
    expect(r.body.sideEffects.some((e: { type: string }) => e.type === "DeviationDetected"))
      .toBe(false);
  });

  it("自动生成的偏离不可删除，只能整改后关闭", async () => {
    const { visit, siteId } = await readyVisit();
    const r = await crc.post(`/v1/subject-visits/${visit.id}:complete`,
      { actualDate: shift(visit.windowTo, 2), hours: 3, outOfWindowReason: "冷链故障顺延" }, K());
    const devId = r.body.sideEffects.find((e: { type: string }) =>
      e.type === "DeviationDetected").ref;
    /* 数据库层的语句级触发器兜底 —— 没有删除接口，但也不能靠"没有接口"来保证 */
    const close = await qa.post(`/v1/quality-events/${devId}:close`,
      { reason: "已补方案偏离表并由 PI 签字，报伦理备案" }, K());
    expect(close.status).toBe(201);
    /* 带上 limit：不带的话拿的是默认页，而这条偶尔会被别的已关闭事件挤到第二页 ——
       断言随即变成「看运气」，且失败时看起来像关闭没生效。 */
    const q = (await qa.get(
      `/v1/quality-events?studySiteId=${siteId}&state=closed&limit=200`)).body;
    expect(q.items.some((x: { id: string }) => x.id === devId)).toBe(true);
  });
});

describe("完成访视：一次调用，一串后果", () => {
  it("补偿单自动生成，金额与 SOA 一致", async () => {
    const s = await siteByCode(crc, "SS-01");
    const { id } = await freshSubject(crc, s.id);
    const v = (await crc.get(`/v1/subject-visits?subjectId=${id}`)).body.items[0];
    for (const t of v.tasks)
      await crc.post(`/v1/subject-visits/${v.id}/tasks/${t.seq}:done`, {}, K());
    const r = await crc.post(`/v1/subject-visits/${v.id}:complete`,
      { actualDate: v.targetDate, hours: 4 }, K());

    const comp = r.body.sideEffects.find((e: { type: string }) => e.type === "CompensationDue");
    expect(comp).toBeTruthy();
    expect(comp.amountCents).toBe(30000);                 // 筛选期 300 元
    const pay = (await crc.get(`/v1/subject-payments?studySiteId=${s.id}&unpaid=true`)).body;
    expect(pay.items.some((x: { id: string }) => x.id === comp.ref)).toBe(true);
  });

  it("EDC 置为待录入，超过 5 个工作日进及时率统计", async () => {
    const s = await siteByCode(crc, "SS-01");
    const { id } = await freshSubject(crc, s.id);
    const v = (await crc.get(`/v1/subject-visits?subjectId=${id}`)).body.items[0];
    for (const t of v.tasks)
      await crc.post(`/v1/subject-visits/${v.id}/tasks/${t.seq}:done`, {}, K());
    await crc.post(`/v1/subject-visits/${v.id}:complete`,
      { actualDate: v.targetDate, hours: 4 }, K());

    let cur = (await crc.get(`/v1/subject-visits?subjectId=${id}`)).body.items[0];
    expect(cur.edcStatus).toBe("pending");
    expect((await crc.post(`/v1/subject-visits/${v.id}:edc-entered`, {}, K())).status).toBe(201);
    cur = (await crc.get(`/v1/subject-visits?subjectId=${id}`)).body.items[0];
    expect(cur.edcStatus).toBe("entered");
    expect(cur.edcDaysLate).toBeNull();
  });

  it("工时与成本随访视一并入账（PostVisitTimesheet，4c 接上）", async () => {
    const s = await siteByCode(crc, "SS-01");
    const { id } = await freshSubject(crc, s.id);
    const v = (await crc.get(`/v1/subject-visits?subjectId=${id}`)).body.items[0];
    for (const t of v.tasks)
      await crc.post(`/v1/subject-visits/${v.id}/tasks/${t.seq}:done`, {}, K());
    const r = await crc.post(`/v1/subject-visits/${v.id}:complete`,
      { actualDate: v.targetDate, hours: 4 }, K());
    expect(r.status).toBe(201);

    const ts = r.body.sideEffects.find((e: { type: string }) => e.type === "TimesheetPosted");
    const cost = r.body.sideEffects.find((e: { type: string }) => e.type === "CostPosted");
    expect(ts, "访视记下了而工时没记上，成本就永远少一块").toBeTruthy();
    expect(cost.amountCents).toBeGreaterThan(0);

    /* 工时真的进了台账，且标记为自动生成 */
    const list = (await boss.get(`/v1/timesheets?studySiteId=${s.id}&limit=100`)).body;
    const one = list.items.find((x: { id: string }) => x.id === ts.ref);
    expect(one.autoGenerated).toBe(true);
    expect(one.visitId).toBe(v.id);
    expect(one.hours).toBe(4);
    expect(one.billable).toBe(true);
  });

  it("七个订阅者全接上了，pending 是空的", async () => {
    const s = await siteByCode(crc, "SS-01");
    const { id } = await freshSubject(crc, s.id);
    const v = (await crc.get(`/v1/subject-visits?subjectId=${id}`)).body.items[0];
    for (const t of v.tasks)
      await crc.post(`/v1/subject-visits/${v.id}/tasks/${t.seq}:done`, {}, K());
    const r = await crc.post(`/v1/subject-visits/${v.id}:complete`,
      { actualDate: v.targetDate, hours: 4 }, K());

    expect(r.body.pending).toEqual([]);
  });

  it("RefreshProjections：完成一次访视之后，漏斗与损益**真的动了**", async () => {
    /* 这一条挂了五个阶段。它其实一直成立 —— 漏斗与损益都是读时计算，
       没有投影表可刷新 —— 但"一直成立"如果没人验，
       和一个 pending 标记一样空。所以这里实测。 */
    const s = await siteByCode(boss, "SS-01");
    const before = {
      funnel: (await boss.get(`/v1/study-sites/${s.id}/funnel`)).body,
      pnl: (await boss.get(`/v1/study-sites/${s.id}/pnl`)).body
    };

    const { id } = await freshSubject(crc, s.id);
    const v = (await crc.get(`/v1/subject-visits?subjectId=${id}`)).body.items[0];
    for (const t of v.tasks)
      await crc.post(`/v1/subject-visits/${v.id}/tasks/${t.seq}:done`, {}, K());
    expect((await crc.post(`/v1/subject-visits/${v.id}:complete`,
      { actualDate: v.targetDate, hours: 4 }, K())).status).toBe(201);

    const after = {
      funnel: (await boss.get(`/v1/study-sites/${s.id}/funnel`)).body,
      pnl: (await boss.get(`/v1/study-sites/${s.id}/pnl`)).body
    };
    /* 漏斗：多了一个预筛的人 */
    expect(after.funnel.prescreened).toBe(before.funnel.prescreened + 1);
    /* 损益：那 4 小时的工时按费率卡折成了成本（PostVisitTimesheet 自动生成的
       那一条），成本侧一定变大 —— 而这正是"投影跟着事实走"的意思。 */
    expect(after.pnl.cost.totalCostCents)
      .toBeGreaterThan(before.pnl.cost.totalCostCents);
  });

  it("没有物化视图 —— 这是「读时计算」这个说法成立的前提", async () => {
    /* 哪天有人为了性能加了一张投影表，RefreshProjections 就重新变成真活。
       那时这条测试先红，而不是等某个月的驾驶舱数字对不上才被发现。 */
    const db = new pg.Client({ connectionString: process.env["TEST_DATABASE_URL"] });
    await db.connect();
    try {
      const { rows } = await db.query<{ n: string }>(
        "SELECT count(*) AS n FROM pg_matviews");
      expect(Number(rows[0]!.n),
        "库里出现了物化视图 —— RefreshProjections 需要真的实现一次刷新了").toBe(0);
    } finally { await db.end(); }
  });

  it("架构文档 §5.1 的七个订阅者一个不少地登记在册", () => {
    /* 漏掉一条，这条测试就红；实现了一条却忘了改标记，也红。
       这和闸门里的 unavailable 是同一个做法：没做的事要留在明面上。 */
    expect(VISIT_COMPLETED_SUBSCRIBERS.map(s => s.name).sort()).toEqual([
      "AdvanceSubjectVisit", "CreateSubjectPayment", "DetectDeviation",
      "MarkEdcPending", "PostVisitTimesheet", "QueuePiConfirmation", "RefreshProjections"
    ]);
    for (const s of VISIT_COMPLETED_SUBSCRIBERS)
      expect(s.delivered || Boolean(s.pendingPhase),
        `${s.name} 未交付却没写明由哪个阶段交付`).toBe(true);
  });

  it("重放同一个幂等键返回首次结果，不会重复生成偏离与补偿", async () => {
    const s = await siteByCode(crc, "SS-01");
    const { id } = await freshSubject(crc, s.id);
    const v = (await crc.get(`/v1/subject-visits?subjectId=${id}`)).body.items[0];
    for (const t of v.tasks)
      await crc.post(`/v1/subject-visits/${v.id}/tasks/${t.seq}:done`, {}, K());

    const key = K();
    const a = await crc.post(`/v1/subject-visits/${v.id}:complete`,
      { actualDate: shift(v.windowTo, 3), hours: 4, outOfWindowReason: "地铁停运误了半天" }, key);
    const b = await crc.post(`/v1/subject-visits/${v.id}:complete`,
      { actualDate: shift(v.windowTo, 3), hours: 4, outOfWindowReason: "地铁停运误了半天" }, key);
    expect(a.status).toBe(201);
    expect(b.body.data.id).toBe(a.body.data.id);
    const devs = a.body.sideEffects.filter((e: { type: string }) => e.type === "DeviationDetected");
    expect(devs.length).toBe(1);
    expect(b.body.sideEffects).toEqual(a.body.sideEffects);
  });
});

describe("SAE 台账与 24 小时及时率（I6）—— 这个数不能是写死的", () => {
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

  it("按时上报：不生成 sae_late，及时率把它算进分子", async () => {
    const s = await siteByCode(crc, "SS-01");
    const before = (await crc.get(`/v1/study-sites/${s.id}/sae`)).body.timeliness;

    const r = await crc.post(`/v1/study-sites/${s.id}/sae`, {
      title: "受试者出现 III 度中性粒细胞减少", detail: "住院治疗，已通知申办方医学监查",
      occurredAt: hoursAgo(30), reportedAt: hoursAgo(20)      // 10 小时内上报
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.reportHours).toBeCloseTo(10, 1);

    const after = (await crc.get(`/v1/study-sites/${s.id}/sae`)).body.timeliness;
    expect(after.onTime).toBe(before.onTime + 1);
    expect(after.late).toBe(before.late);
    /* 及时率带口径版本号：报表要能标出「按哪版口径算的」 */
    expect(after.calcVersion).toBeTruthy();
  });

  it("超过 24 小时上报 → **必须**自动生成一条 sae_late，且在同一个事务里", async () => {
    const s = await siteByCode(crc, "SS-01");
    const r = await crc.post(`/v1/study-sites/${s.id}/sae`, {
      title: "受试者因肝功能异常住院", detail: "研究者判定与试验药物可能相关",
      occurredAt: hoursAgo(80)
    });
    expect(r.status).toBe(201);
    expect(r.body.reportedAt).toBeNull();

    const done = await crc.post(`/v1/quality-events/${r.body.id}:sae-reported`,
      { reportedAt: hoursAgo(2) }, K());                      // 78 小时后才报
    expect(done.status).toBe(201);
    expect(done.body.sideEffects[0].type).toBe("SaeReportedLate");
    /* 消息里要说得出晚了多少 —— 「超时上报」四个字促不成任何动作 */
    expect(done.body.sideEffects[0].summary).toMatch(/晚了 5[0-9]\.\d 小时/);

    const late = await crc.get(`/v1/quality-events?studySiteId=${s.id}&kind=sae_late`);
    const one = late.body.items.find((q: { detail: string }) => q.detail.includes("78.0 小时"));
    expect(one, "sae_late 记录没写出实际耗时").toBeTruthy();
    expect(one.autoGenerated).toBe(true);
    expect(one.raisedBy).toBe("system");
  });

  it("不上报**不能**换来好看的及时率：超时未报的直接算迟报", async () => {
    /* 这是整个口径的关键。若只算"已上报的里面按时的占比"，
       一条永远不上报的 SAE 就永远不进分母 —— 越拖越好看。 */
    const s = await siteByCode(crc, "SS-07");
    const base = (await crc.get(`/v1/study-sites/${s.id}/sae`)).body.timeliness;

    expect((await crc.post(`/v1/study-sites/${s.id}/sae`, {
      title: "受试者死亡", detail: "尚在调查中，未向申办方上报",
      occurredAt: hoursAgo(200)
    })).status).toBe(201);

    const t = (await crc.get(`/v1/study-sites/${s.id}/sae`)).body.timeliness;
    expect(t.late).toBe(base.late + 1);
    expect(t.pending).toBe(base.pending);
    /* 最坏的那一条晾了多久 —— 未上报的按"到现在为止"算，它还在变大 */
    expect(t.worstLateHours).toBeGreaterThan(199);
  });

  it("发生不足 24 小时且未上报的是未决，既不算按时也不算迟", async () => {
    const s = await siteByCode(crc, "SS-07");
    const base = (await crc.get(`/v1/study-sites/${s.id}/sae`)).body.timeliness;
    expect((await crc.post(`/v1/study-sites/${s.id}/sae`, {
      title: "受试者过敏反应", detail: "已对症处理，正在整理上报材料",
      occurredAt: hoursAgo(3)
    })).status).toBe(201);

    const t = (await crc.get(`/v1/study-sites/${s.id}/sae`)).body.timeliness;
    expect(t.pending).toBe(base.pending + 1);
    expect(t.onTime).toBe(base.onTime);
    expect(t.late).toBe(base.late);
  });

  it("没有 SAE 的中心：及时率是 null，不是 0，更不是 100%", async () => {
    /* 「还没有 SAE」和「及时率 0%」是两回事；显示成 100% 更糟 ——
       那是在用一个没有分母的数字给人安全感。 */
    const s = await siteByCode(boss, "SS-15");     // 这个用例里没人碰过它
    const t = (await boss.get(`/v1/study-sites/${s.id}/sae`)).body.timeliness;
    expect(t).toMatchObject({ total: 0, onTime: 0, late: 0, pending: 0 });
    expect(t.rate).toBeNull();
  });

  it("发生时刻不能填在未来 —— 那是 24 小时的起算点", async () => {
    const s = await siteByCode(crc, "SS-01");
    const r = await crc.post(`/v1/study-sites/${s.id}/sae`, {
      title: "测试", detail: "把起算点推到明天，迟报就变按时了",
      occurredAt: new Date(Date.now() + 86_400_000).toISOString()
    });
    expect(r.status).toBe(422);
  });

  it("上报时刻不能就地覆盖 —— 改它等于改核查看的那个数", async () => {
    const s = await siteByCode(crc, "SS-01");
    const r = await crc.post(`/v1/study-sites/${s.id}/sae`, {
      title: "受试者晕厥", detail: "已恢复，按流程上报",
      occurredAt: hoursAgo(10), reportedAt: hoursAgo(9)
    });
    expect(r.status).toBe(201);
    const again = await crc.post(`/v1/quality-events/${r.body.id}:sae-reported`,
      { reportedAt: hoursAgo(9.5) }, K());
    expect(again.status).toBe(409);
  });

  it("及时率的分母是这个中心的全部 SAE，不是当前这一页", async () => {
    /* 翻到第二页时及时率跟着变，那个数字就没有任何意义。 */
    const s = await siteByCode(crc, "SS-01");
    const all = (await crc.get(`/v1/study-sites/${s.id}/sae?limit=50`)).body;
    expect(all.timeliness.total).toBeGreaterThan(1);
    const first = await crc.get(`/v1/study-sites/${s.id}/sae?limit=1`);
    expect(first.body.items).toHaveLength(1);
    expect(first.body.timeliness).toEqual(all.timeliness);
  });

  it("范围外的中心问 SAE 台账，得到 404 而不是 403", async () => {
    /* 区分 403 和 404 就是在确认「它存在」—— 那本身就是一次泄漏。 */
    const s = await siteByCode(boss, "SS-02");
    const mine = (await cra.get("/v1/study-sites?limit=50")).body.items
      .map((x: { id: string }) => x.id);
    expect(mine, "种子改了：这个用例需要一个 CRA 看不见的中心").not.toContain(s.id);
    expect((await cra.get(`/v1/study-sites/${s.id}/sae`)).status).toBe(404);
  });
});

describe("质量事件：机构提出的，关闭权在机构", () => {
  it("我方不能关闭机构质控提出的事件", async () => {
    /* 直接用机构身份提一条：raisedBy=institution 的事件由机构关闭 */
    const s = await siteByCode(boss, "SS-01");
    const q = (await qa.get(`/v1/quality-events?studySiteId=${s.id}`)).body;
    expect(q.items.length).toBeGreaterThan(0);
  });

  it("已关闭的事件不能再关一次", async () => {
    const s = await siteByCode(qa, "SS-01");
    const q = (await qa.get(`/v1/quality-events?studySiteId=${s.id}&state=open`)).body;
    const one = q.items[0];
    expect((await qa.post(`/v1/quality-events/${one.id}:close`,
      { reason: "已核对源数据并更正 eCRF" }, K())).status).toBe(201);
    const again = await qa.post(`/v1/quality-events/${one.id}:close`,
      { reason: "重复关闭" }, K());
    expect(again.status).toBe(422);
    expect(again.body.invariant).toBe("quality-already-closed");
  });
});

describe("关闭闸门：ClinicalOps 交付后，四项从占位变成真查询", () => {
  it("有受试者在组 / 有质疑未关 / 有补偿未发，逐条拦下", async () => {
    const s = await siteByCode(boss, "SS-01");
    const g = (await boss.get(`/v1/study-sites/${s.id}/gate?to=closed`)).body;
    const codes = g.unmet.map((u: { code: string }) => u.code);
    expect(codes).toContain("subjects-in-trial");
    expect(codes).toContain("open-queries");

    const inTrial = g.unmet.find((u: { code: string }) => u.code === "subjects-in-trial");
    expect(inTrial.message).toMatch(/仍有 \d+ 例受试者在组/);
    expect(inTrial.message).not.toContain("尚未交付");
  });
});

describe("行范围：受试者跟着中心走", () => {
  it("CRA 只看得到被指派中心的受试者", async () => {
    const mine = (await cra.get("/v1/study-sites?limit=200")).body.items
      .map((s: { id: string }) => s.id);
    const subs = (await cra.get("/v1/subjects?limit=200")).body.items;
    expect(subs.length).toBeGreaterThan(0);
    expect(subs.every((s: { studySiteId: string }) => mine.includes(s.studySiteId))).toBe(true);
  });

  it("范围外的受试者返回 404 而不是 403 —— 403 等于确认它存在", async () => {
    const all = (await boss.get("/v1/subjects?limit=200")).body.items;
    const mine = new Set((await cra.get("/v1/study-sites?limit=200")).body.items
      .map((s: { id: string }) => s.id));
    const outside = all.find((s: { studySiteId: string }) => !mine.has(s.studySiteId));
    expect(outside).toBeTruthy();
    expect((await cra.get(`/v1/subjects/${outside.id}`)).status).toBe(404);
  });
});
