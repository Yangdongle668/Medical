import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { boot, resetDb, as, type Caller } from "./harness.js";

const idem = () => ({ "Idempotency-Key": randomUUID() });

/* ════════════════════════════════════════════════════════════════════
   监查访视。

   这一组盯的是**四个日期为什么不能压成一个状态**：
     · 排了期没确认 —— 中心那边不知道我们要去；
     · 确认了没去   —— 出门这件事没发生；
     · 去了没交报告 —— 最常见的欠账，而原型里连一个状态都没有；
     · 跟进项没关就交报告 —— 报告和台账互相打脸。
   ════════════════════════════════════════════════════════════════════ */

let app: INestApplication;
let cra: Caller, pm: Caller, crc: Caller, qa: Caller, boss: Caller, inst: Caller;

beforeAll(async () => {
  resetDb(); app = await boot();
  cra  = await as(app, "linmin");
  pm   = await as(app, "hanxue");
  crc  = await as(app, "wutong");
  qa   = await as(app, "weilan");
  boss = await as(app, "lingyuan");
  inst = await as(app, "zhanghm");
}, 180_000);
afterAll(async () => { await app?.close(); });

const list = async (c: Caller, qs = "") =>
  (await c.get(`/v1/monitor-visits?limit=200${qs}`)).body.items as any[];

describe("排期台账", () => {
  it("PM 看得到范围内的排期，每一条都答得出「谁去、去几天」", async () => {
    const items = await list(pm);
    expect(items.length).toBeGreaterThan(5);
    for (const v of items) {
      expect(v.monitorName, `${v.code} 监查员`).toBeTruthy();
      expect(v.days).toBeGreaterThan(0);
      expect(["siv", "imv", "cov"]).toContain(v.kind);
    }
  });

  it("**外部方一条都看不到** —— 监查策略不能交给被监查的一方", async () => {
    expect(await list(inst)).toHaveLength(0);
    const board = await inst.get("/v1/monitor-visits/board");
    expect(board.status).toBe(200);
    expect(board.body.sites).toHaveLength(0);
  });

  it("按计划日排 —— 这一页是「接下来去哪」", async () => {
    const items = await list(pm);
    const days = items.map(v => v.plannedOn);
    expect([...days].sort()).toEqual(days);
  });

  it("**「计划日过了还没去」和「去了没交报告」是两个数**", async () => {
    const items = await list(pm);
    const notThere = items.filter(v => v.visitOverdueDays !== null);
    const noReport = items.filter(v => v.state === "done" && v.reportSubmittedOn === null);
    expect(notThere.length, "种子里有过了计划日还没去的").toBeGreaterThan(0);
    expect(noReport.length, "种子里有去过但没交报告的").toBeGreaterThan(0);
    /* 两组不重叠：没出门的不可能同时欠报告 */
    for (const v of noReport) expect(v.visitOverdueDays).toBeNull();
    for (const v of notThere) expect(v.mvrLagDays).toBeNull();
  });

  it("mine 只给排给我的", async () => {
    const mine = await list(cra, "&mine=true");
    expect(mine.length).toBeGreaterThan(0);
    for (const v of mine) expect(v.monitorName).toBe("林敏");
  });
});

describe("计划与欠账（board）", () => {
  it("**建议间隔与抽样比例一定带理由**", async () => {
    const b = (await pm.get("/v1/monitor-visits/board")).body;
    expect(b.sites.length).toBeGreaterThan(0);
    for (const s of b.sites) {
      expect(["low", "normal", "high"]).toContain(s.band);
      expect(s.reasons.length, `${s.siteCode} 没给理由`).toBeGreaterThan(0);
      expect(s.intervalDays).toBeGreaterThan(0);
      expect(s.sdvSamplePct).toBeGreaterThan(0);
    }
    expect(b.calcVersion).toBeTruthy();
  });

  it("**一次都没监查过的 daysSince 是 null，且排在逾期之后**", async () => {
    /* 用经营层看：PM 的行范围是 team，还没启动的那两个中心不一定在他名下。
       这条断言要的是"没监查过"这条分支本身，不是行范围。 */
    const b = (await boss.get("/v1/monitor-visits/board")).body;
    const never = b.sites.filter((s: any) => s.neverVisited);
    expect(never.length, "种子里有还没启动、因而没监查过的中心").toBeGreaterThan(0);
    for (const s of never) {
      expect(s.daysSince).toBeNull();
      expect(s.overdueDays).toBeNull();
    }
    /* 逾期的都排在从没去过的前面 —— 后者没有天数，不该冲到榜首 */
    const firstNever = b.sites.findIndex((s: any) => s.neverVisited);
    const overdueAfter = b.sites.slice(firstNever)
      .filter((s: any) => (s.overdueDays ?? 0) > 0);
    expect(overdueAfter).toHaveLength(0);
  });

  it("MVR 负荷把没交的报告也算进平均", async () => {
    const b = (await pm.get("/v1/monitor-visits/board")).body;
    expect(b.load.performed).toBeGreaterThan(0);
    expect(b.load.outstanding).toBeGreaterThan(0);
    expect(b.load.meanLagDays).toBeGreaterThan(0);
    expect(b.load.worstLagDays).toBeGreaterThanOrEqual(b.load.meanLagDays);
  });

  it("**差旅估算受 cost 列权限管辖** —— CRA 排自己的班，看不到它值多少钱", async () => {
    const mine = (await cra.get("/v1/monitor-visits/board")).body;
    expect("travelEstimateCents" in mine, "CRA 没有 cost 列权限").toBe(false);
    expect(mine.upcomingVisits).toBeGreaterThanOrEqual(0);

    const rich = (await boss.get("/v1/monitor-visits/board")).body;
    expect(rich.travelEstimateCents).toBeGreaterThanOrEqual(0);
  });
});

describe("四步各拦各的", () => {
  const siteId = async () =>
    (await pm.get("/v1/study-sites?limit=1&state=enrolling")).body.items[0].id;

  const plan = async (c: Caller, over: Record<string, unknown> = {}) => {
    const body = {
      studySiteId: await siteId(), kind: "imv", plannedOn: "2026-09-20",
      days: 2, items: ["SDV 抽样核对本期新增受试者源数据", "试验用药品清点"],
      ...over
    };
    return c.post("/v1/monitor-visits", body, idem());
  };

  it("**CRC 排不了监查** —— 没有 monitor 动作权限", async () => {
    expect((await plan(crc)).status).toBe(403);
  });

  it("**QA 也排不了** —— 稽查和监查是两条线", async () => {
    expect((await plan(qa)).status).toBe(403);
  });

  it("CRA 排期：默认排给自己，落地是「待确认」", async () => {
    const r = await plan(cra);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.state).toBe("proposed");
    expect(r.body.data.monitorName).toBe("林敏");
    expect(r.body.data.items).toHaveLength(2);
    expect(r.body.data.openItems).toBe(2);
    expect(r.body.sideEffects[0].summary).toContain("与中心确认");
  });

  it("**没确认就不能登记到现场**", async () => {
    const v = (await plan(cra)).body.data;
    const r = await cra.post(`/v1/monitor-visits/${v.id}:perform`, {}, idem());
    expect(r.status).toBe(422);
    expect(r.body.invariant).toBe("monitor-not-confirmed");
  });

  it("**没去过就写不出监查报告**", async () => {
    const v = (await plan(cra)).body.data;
    await cra.post(`/v1/monitor-visits/${v.id}:confirm`, {}, idem());
    const r = await cra.post(`/v1/monitor-visits/${v.id}:report`, {}, idem());
    expect(r.status).toBe(422);
    expect(r.body.invariant).toBe("monitor-not-performed");
  });

  it("现场日期不能在将来 —— 还没发生的事不能登记", async () => {
    const v = (await plan(cra)).body.data;
    await cra.post(`/v1/monitor-visits/${v.id}:confirm`, {}, idem());
    const r = await cra.post(`/v1/monitor-visits/${v.id}:perform`,
      { performedOn: "2027-01-01" }, idem());
    expect(r.status).toBe(422);
    expect(r.body.invariant).toBe("monitor-future-visit");
  });

  it("**跟进项没关就交报告：拦下来，并说出拦在哪几项**", async () => {
    const v = (await plan(cra)).body.data;
    await cra.post(`/v1/monitor-visits/${v.id}:confirm`, {}, idem());
    await cra.post(`/v1/monitor-visits/${v.id}:perform`, {}, idem());

    const blocked = await cra.post(`/v1/monitor-visits/${v.id}:report`, {}, idem());
    expect(blocked.status).toBe(422);
    expect(blocked.body.invariant).toBe("monitor-items-open");
    expect(blocked.body.detail, "要说得出拦在哪一项").toContain("SDV 抽样核对");

    for (const it of v.items)
      await cra.post(`/v1/monitor-visits/${v.id}/items/${it.seq}:done`,
        { done: true }, idem());
    const ok = await cra.post(`/v1/monitor-visits/${v.id}:report`, {}, idem());
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data.state).toBe("reported");
    expect(ok.body.sideEffects[0].summary).toContain("距现场");
  });

  it("**报告交上去之后跟进项冻结** —— 否则报告和台账互相打脸", async () => {
    const v = (await plan(cra)).body.data;
    await cra.post(`/v1/monitor-visits/${v.id}:confirm`, {}, idem());
    await cra.post(`/v1/monitor-visits/${v.id}:perform`, {}, idem());
    for (const it of v.items)
      await cra.post(`/v1/monitor-visits/${v.id}/items/${it.seq}:done`,
        { done: true }, idem());
    await cra.post(`/v1/monitor-visits/${v.id}:report`, {}, idem());

    const r = await cra.post(`/v1/monitor-visits/${v.id}/items/0:done`,
      { done: false }, idem());
    expect(r.status).toBe(422);
    expect(r.body.invariant).toBe("monitor-report-frozen");
  });

  it("跟进项可以撤回 —— 提交之前", async () => {
    const v = (await plan(cra)).body.data;
    const on = await cra.post(`/v1/monitor-visits/${v.id}/items/0:done`,
      { done: true }, idem());
    expect(on.body.data.openItems).toBe(1);
    const off = await cra.post(`/v1/monitor-visits/${v.id}/items/0:done`,
      { done: false }, idem());
    expect(off.body.data.openItems).toBe(2);
  });
});
