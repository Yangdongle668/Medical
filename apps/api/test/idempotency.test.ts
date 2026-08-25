import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { boot, resetDb, as, type Caller } from "./harness.js";
import { randomUUID } from "node:crypto";

let app: INestApplication, boss: Caller;

beforeAll(async () => {
  resetDb(); app = await boot(); boss = await as(app, "lingyuan");
}, 120_000);
afterAll(async () => { await app?.close(); });

/** 每个用例自建一个新中心 —— 依赖种子里的某个特定状态，第一个用例跑完后面就没得用了。
 *  新建的中心处在 intake，推进到 irb_submit 不经过闸门。 */
let seq = 0;
async function freshSite() {
  const study = (await boss.get("/v1/studies?limit=1")).body.items[0];
  const code = `SS-IDEM${String(++seq).padStart(2, "0")}`;
  const r = await boss.post("/v1/study-sites", {
    studyId: study.id, code, hospital: "幂等测试医院", dept: "科", city: "北京",
    piName: "测试研究者", contracted: 5, unitPriceCents: 1000000
  });
  expect(r.status).toBe(201);
  return r.body as { id: string; code: string };
}
const NEXT = "irb_submit";

describe("幂等 —— CRC 在地下室重发请求，不能记两笔", () => {
  it("缺 Idempotency-Key 的 L2 命令 → 422", async () => {
    const site = await freshSite();
    const r = await boss.post(`/v1/study-sites/${site.id}:advance`, { to: NEXT });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body.issues)).toContain("idempotency-key");
  });

  it("同键 + 同请求体重放 → 返回首次的结果，不产生第二次副作用", async () => {
    const site = await freshSite();
    const key = randomUUID();
    const body = { to: NEXT, reason: "材料齐备，已向伦理递交初始审查" };

    const first = await boss.post(`/v1/study-sites/${site.id}:advance`, body,
      { "Idempotency-Key": key });
    expect(first.status).toBe(201);
    expect(first.body.data.state).toBe(NEXT);
    expect(first.body.sideEffects).toHaveLength(1);

    const again = await boss.post(`/v1/study-sites/${site.id}:advance`, body,
      { "Idempotency-Key": key });
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);

    /* 只留下一条轨迹 —— 重放没有再推进一次 */
    const trail = await boss.get(
      `/v1/audit-entries?targetType=study_site&targetId=${site.code}&limit=50`);
    const advances = trail.body.items.filter((x: { action: string }) => x.action === "推进中心阶段");
    expect(advances).toHaveLength(1);
  });

  it("同键 + 不同请求体 → 409，而不是静默返回上次结果", async () => {
    const site = await freshSite();
    const key = randomUUID();
    await boss.post(`/v1/study-sites/${site.id}:advance`,
      { to: NEXT, reason: "材料齐备，已递交伦理" }, { "Idempotency-Key": key });
    const r = await boss.post(`/v1/study-sites/${site.id}:advance`,
      { to: NEXT, reason: "换了一个完全不同的理由" }, { "Idempotency-Key": key });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("idempotency-key-reused");
    expect(r.body.detail).toContain("不同的请求体");
  });

  it("幂等键按账号隔离 —— 别人用过的键不影响我", async () => {
    const pm = await as(app, "hanxue");
    const site = await freshSite();
    const key = randomUUID();
    await boss.post(`/v1/study-sites/${site.id}:advance`,
      { to: NEXT, reason: "经营层推进本中心" }, { "Idempotency-Key": key });
    /* 同一把键，换个人用 —— 应当被当作全新请求处理（此处因阶段已变而报 422，
       但关键是它没有返回上一个人的结果） */
    const r = await pm.post(`/v1/study-sites/${site.id}:advance`,
      { to: NEXT, reason: "PM 推进本中心" }, { "Idempotency-Key": key });
    expect(r.body).not.toEqual(expect.objectContaining({ sideEffects: expect.anything() }));
  });
});
