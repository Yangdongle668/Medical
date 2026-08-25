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
    /* 请求体必须是**完整合法**的，否则这条断言其实在验别的东西：
       body 的 schema 校验跑在处理函数之前，少一个 reason 就会先报 reason，
       于是"缺幂等键"这条规则从未被真正执行过，而测试照样绿。 */
    const site = await freshSite();
    const r = await boss.post(`/v1/study-sites/${site.id}:advance`,
      { to: NEXT, reason: "材料齐备，已向伦理递交" });
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

/* ════════════════════════════════════════════════════════════════════
   同一把钥匙，开另一扇门。

   `idempotency_key` 的表注释写着：
   「request_hash 用于识别『同一把钥匙开不同的门』」。
   但 request_hash 比的是**请求体**，而 begin() 查行只用 (key, account_id) ——
   `endpoint` 这一列**记下来了，却从来没有被比对过**。

   于是只要两个端点碰巧哈希出同样的载荷，一把钥匙就真的能开另一扇门：

     completeStartupItem  载荷 { id }        动作权限：无
     completeHandover     载荷 { id }        动作权限：无

   两个都不需要动作权限，同一个 CRC 都调得动。把启动清单项的 id 拿去
   调交接完成，载荷同样是 { id: <那个 uuid> } —— 哈希一致、已完成，
   于是 begin() **在处理器跑起来之前**就返回了上一次的响应体。

   本该 404 的请求，变成了一个假的成功。
   ════════════════════════════════════════════════════════════════════ */
describe("幂等键不能跨端点复用", () => {
  it("拿启动清单项的键去调交接完成 → 必须被拦下，而不是返回上一次的结果", async () => {
    const site = await freshSite();
    const items = (await boss.get(`/v1/study-sites/${site.id}/startup-items`)).body.items;
    const item = items.find((i: { doneAt: string | null }) => !i.doneAt);
    expect(item, "新中心应当铺开了标准启动清单").toBeTruthy();

    const key = randomUUID();
    const first = await boss.post(
      `/v1/startup-items/${item.id}:complete`, {}, { "Idempotency-Key": key });
    expect(first.status).toBe(201);          // Nest 对 POST 的缺省状态码

    /* 同一把键、同一个 id，换一扇门。
       没有这道防线的话，下面拿到的是 200 + 上面那条清单项的响应体。 */
    const second = await boss.post(
      `/v1/handovers/${item.id}:complete`, {}, { "Idempotency-Key": key });

    expect(second.status, `不该成功：${JSON.stringify(second.body).slice(0, 200)}`)
      .toBeGreaterThanOrEqual(400);
    expect(second.body.code).toBe("idempotency-key-reused");
    expect(second.body.detail).toMatch(/端点|门/);
  });

  it("同一把键、同一个端点、同样的请求体 → 仍然正常重放", async () => {
    /* 上一条不能把正常的重放也一起挡掉 —— 那才是幂等键存在的理由。 */
    const site = await freshSite();
    const items = (await boss.get(`/v1/study-sites/${site.id}/startup-items`)).body.items;
    const item = items.find((i: { doneAt: string | null }) => !i.doneAt);

    const key = randomUUID();
    const a = await boss.post(
      `/v1/startup-items/${item.id}:complete`, {}, { "Idempotency-Key": key });
    const b = await boss.post(
      `/v1/startup-items/${item.id}:complete`, {}, { "Idempotency-Key": key });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body).toEqual(a.body);
  });
});
