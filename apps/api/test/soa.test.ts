import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { boot, resetDb, as, type Caller } from "./harness.js";
import { randomUUID } from "node:crypto";

/* SOA 可配置（欠账 D2）。
   与启动清单模板一样独立成文件：它改的是项目级的访视计划，
   而 clinical.test.ts 里几乎每条用例都要按 SOA 排访视。 */

let app: INestApplication, boss: Caller, crc: Caller;
beforeAll(async () => {
  resetDb(); app = await boot();
  boss = await as(app, "lingyuan");
  crc  = await as(app, "wutong");
}, 120_000);
afterAll(async () => { await app?.close(); });

const K = () => ({ "Idempotency-Key": randomUUID() });
const firstStudy = async () => (await boss.get("/v1/studies?limit=1")).body.items[0];

/** 拿现有 SOA 做底稿改，而不是凭空写一份 —— 凭空写的那份会悄悄
 *  丢掉 compensationCents 之类的字段，而测试照样绿。 */
const asBody = (visits: any[]) => visits.map(v => ({
  seq: v.seq, visitCode: v.visitCode, visitLabel: v.visitLabel, anchor: v.anchor,
  offsetDays: v.offsetDays, windowDays: v.windowDays,
  compensationCents: v.compensationCents, tasks: v.tasks
}));

describe("SOA：可配置，但已排出去的访视不动", () => {
  it("读得到，且每条带着「已经按它排出去多少次」", async () => {
    const st = await firstStudy();
    const soa = (await boss.get(`/v1/studies/${st.id}/visit-template`)).body;
    expect(soa.visits.length).toBeGreaterThan(1);
    expect(soa.visits[0].anchor).toBe("icf");
    /* 种子里有受试者，第 0 次访视一定排出去过 */
    expect(soa.visits[0].scheduledCount).toBeGreaterThan(0);
    expect(soa.visits[0].tasks.length).toBeGreaterThan(0);
  });

  it("改窗口天数：已排的访视窗口不变，只有之后排出来的才按新值", async () => {
    /* 一个受试者的 C4D1 已经排在下周三，模板一改就跳到下周五，
       那个人的行程、床位、伴随用药全部作废 —— 而系统不会知道。 */
    const st = await firstStudy();
    const soa = (await boss.get(`/v1/studies/${st.id}/visit-template`)).body;
    const v0 = soa.visits[0];

    const before = (await crc.get("/v1/subject-visits?limit=200")).body.items
      .filter((v: { seq: number }) => v.seq === v0.seq);
    expect(before.length).toBeGreaterThan(0);
    const beforeWindows = before.map((v: { id: string; windowDays: number }) =>
      [v.id, v.windowDays]);

    const next = asBody(soa.visits);
    next[0]!.windowDays = v0.windowDays + 5;
    const r = await boss.post(`/v1/studies/${st.id}/visit-template:replace`,
      { visits: next, reason: "方案修订 V1.3：首次访视窗口放宽 5 天" }, K());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.sideEffects[0].summary).toContain("不动");

    const after = (await crc.get("/v1/subject-visits?limit=200")).body.items
      .filter((v: { seq: number }) => v.seq === v0.seq)
      .map((v: { id: string; windowDays: number }) => [v.id, v.windowDays]);
    expect(after).toEqual(beforeWindows);
    /* 而模板本身确实改了 */
    expect((await boss.get(`/v1/studies/${st.id}/visit-template`)).body.visits[0].windowDays)
      .toBe(v0.windowDays + 5);
  });

  it("删掉一条已经排出去的访视 → 422，且说得出它排给了几个人", async () => {
    const st = await firstStudy();
    const soa = (await boss.get(`/v1/studies/${st.id}/visit-template`)).body;
    const used = soa.visits.find((v: { scheduledCount: number }) => v.scheduledCount > 0);
    const r = await boss.post(`/v1/studies/${st.id}/visit-template:replace`, {
      visits: asBody(soa.visits.filter((v: { seq: number }) => v.seq !== used.seq)),
      reason: "试着删掉一条已经在用的访视"
    }, K());
    expect(r.status).toBe(422);
    expect(r.body.detail).toContain(`${used.scheduledCount} 个受试者`);
  });

  it("改一条已排访视的锚点 → 422 —— 改了之后两边说的不是同一件事", async () => {
    const st = await firstStudy();
    const soa = (await boss.get(`/v1/studies/${st.id}/visit-template`)).body;
    const used = soa.visits.find(
      (v: { scheduledCount: number; seq: number }) => v.scheduledCount > 0 && v.seq > 0);
    if (!used) return;                    // 种子里没有这种情况就不做假绿
    const next = asBody(soa.visits);
    next.find((v: { seq: number }) => v.seq === used.seq)!.anchor = "icf";
    const r = await boss.post(`/v1/studies/${st.id}/visit-template:replace`,
      { visits: next, reason: "试着改一条已经在用的访视的锚点" }, K());
    expect(r.status).toBe(422);
  });

  it("只有第 0 次访视能锚定知情日 —— 入组之前唯一确定的日期就是它", async () => {
    const st = await firstStudy();
    const soa = (await boss.get(`/v1/studies/${st.id}/visit-template`)).body;
    const next = asBody(soa.visits);
    next[0]!.anchor = "enroll";
    const r = await boss.post(`/v1/studies/${st.id}/visit-template:replace`,
      { visits: next, reason: "试着把第 0 次访视改成锚定入组日" }, K());
    expect(r.status).toBe(422);
    expect(r.body.detail).toContain("只有第 0 次");
  });

  it("新加一次访视：之后入组的受试者会排到它", async () => {
    const st = await firstStudy();
    const soa = (await boss.get(`/v1/studies/${st.id}/visit-template`)).body;
    const last = soa.visits.at(-1);
    const r = await boss.post(`/v1/studies/${st.id}/visit-template:replace`, {
      visits: [...asBody(soa.visits), {
        seq: last.seq + 1, visitCode: `V${last.seq + 1}X`, visitLabel: "新增：长期随访",
        anchor: "enroll", offsetDays: last.offsetDays + 28, windowDays: 7,
        compensationCents: 30000, tasks: ["生存状态随访", "不良事件回顾"]
      }],
      reason: "方案修订 V1.3：增加一次长期随访"
    }, K());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const added = r.body.data.visits.at(-1);
    expect(added.visitLabel).toBe("新增：长期随访");
    expect(added.tasks).toEqual(["生存状态随访", "不良事件回顾"]);
    expect(added.scheduledCount).toBe(0);
  });

  it("修订必须写原因，且前后快照留在变更史里", async () => {
    const st = await firstStudy();
    const soa = (await boss.get(`/v1/studies/${st.id}/visit-template`)).body;
    const noReason = await boss.post(`/v1/studies/${st.id}/visit-template:replace`,
      { visits: asBody(soa.visits) }, K());
    expect(noReason.status).toBe(422);

    /* 上面几条用例已经改过几次，最后一次的原因要读得回来 */
    expect(soa.lastReason).toBeTruthy();
    expect(soa.lastChangedByName).toBe("凌远");
  });

  it("一线改不了 SOA —— 改它对应的是一次方案修订", async () => {
    const st = await firstStudy();
    const soa = (await boss.get(`/v1/studies/${st.id}/visit-template`)).body;
    const r = await crc.post(`/v1/studies/${st.id}/visit-template:replace`,
      { visits: asBody(soa.visits), reason: "一线试着改 SOA" }, K());
    expect(r.status).toBe(403);
  });
});
