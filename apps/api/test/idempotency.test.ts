import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { boot, resetDb, as, type Caller } from "./harness.js";
import { randomUUID } from "node:crypto";

let app: INestApplication, boss: Caller, admin: Caller;

beforeAll(async () => {
  resetDb(); app = await boot(); boss = await as(app, "lingyuan");
  /* 受理的门是 `accept` —— 经营层没有它。 */
  admin = await as(app, "admin");
}, 120_000);
afterAll(async () => { await app?.close(); });

/** 每个用例自建一个新中心 —— 依赖种子里的某个特定状态，第一个用例跑完后面就没得用了。
 *
 *  **顺带把机构受理办到位**：迁移 0038 之后「伦理递交」也有闸门了
 *  （机构没受理，材料递不到伦理）。这个文件测的是幂等，不是闸门 ——
 *  受理没办的话，下面每一条都会红在一个跟幂等毫无关系的 422 上。 */
let seq = 0;
async function freshSite() {
  const study = (await boss.get("/v1/studies?limit=1")).body.items[0];
  const n = ++seq;
  /* 医院名带序号：受理挂 (study_id, hospital)，同名会撞上
     「一家医院在同一个项目上只有一次立项受理」那条唯一约束。 */
  const hospital = `幂等测试医院${n}`;
  const r = await boss.post("/v1/study-sites", {
    studyId: study.id, code: `SS-IDEM${String(n).padStart(2, "0")}`,
    hospital, dept: "科", city: "北京",
    piName: "测试研究者", contracted: 5, unitPriceCents: 1000000
  });
  expect(r.status).toBe(201);
  await 办完受理(study.id, hospital);
  return r.body as { id: string; code: string };
}

/** 递交立项材料 → 机构勾齐 → 予以受理。
 *  用管理员而不是机构办张慧敏：她的行范围是「北京协和医院」，
 *  而这里建的是「幂等测试医院N」—— 范围之外 = 不存在（404），不是 403。 */
async function 办完受理(studyId: string, hospital: string) {
  const ac = await boss.post("/v1/site-acceptances",
    { studyId, hospital, docs: ["立项申请表", "方案及研究者手册"] });
  expect(ac.status, `递交立项材料失败：${JSON.stringify(ac.body)}`).toBe(201);
  for (const d of ac.body.docs)
    expect((await admin.post(
      `/v1/site-acceptances/${ac.body.id}/docs/${d.seq}:set`, { present: true },
      { "Idempotency-Key": randomUUID() })).status).toBe(201);
  expect((await admin.post(`/v1/site-acceptances/${ac.body.id}:accept`, {},
    { "Idempotency-Key": randomUUID() })).status).toBe(201);
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

/* ════════════════════════════════════════════════════════════════════
   L1 写入的幂等 —— 键可有可无（欠账 B11）

   在此之前只有 L2 命令有这一层，于是 L1 的那几个创建端点在断网时
   进不了发件箱：人在地下室填的那条工时，抛个错就没了。
   要让它们排队，就必须能带幂等键 —— 重放意味着同一个请求可能发两次，
   没有键的话那是**实实在在的两笔工时**。

   用 CRC 填工时，不用经营层：成本要按当日生效的费率卡算，
   而费率卡是挂在员工身上的（经营层没有员工记录，会撞 no-effective-rate-card）。
   ════════════════════════════════════════════════════════════════════ */
describe("L1 创建端点的幂等（键可选）", () => {
  let crc: Caller, siteId: string;
  const today = () => new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    crc = await as(app, "wutong");
    siteId = (await crc.get("/v1/study-sites?limit=1")).body.items[0].id;
  });

  it("带同一把键发两次，只写一笔，第二次返回首次的结果", async () => {
    const key = randomUUID();
    const body = {
      studySiteId: siteId, workDate: today(), workType: "visit_support",
      hours: 3.5, note: "L1 幂等测试"
    };
    const a = await crc.post("/v1/timesheets", body, { "Idempotency-Key": key });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const b = await crc.post("/v1/timesheets", body, { "Idempotency-Key": key });
    expect(b.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);          // 同一条，不是第二条

    const list = await crc.get("/v1/timesheets?limit=200");
    const mine = list.body.items.filter((t: { note?: string }) => t.note === "L1 幂等测试");
    expect(mine).toHaveLength(1);
  });

  it("不带键就照旧执行 —— 旧客户端不带也照发，这不是破坏性变更", async () => {
    const body = {
      studySiteId: siteId, workDate: today(), workType: "training",
      hours: 1, note: "无键两次"
    };
    const a = await crc.post("/v1/timesheets", body);
    const b = await crc.post("/v1/timesheets", body);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.id).not.toBe(a.body.id);      // 没有键，就是两笔 —— 如实如此
  });

  it("同一把键换了请求体 → 拒绝，而不是静默返回上一次的结果", async () => {
    const key = randomUUID();
    const first = await crc.post("/v1/timesheets",
      { studySiteId: siteId, workDate: today(), workType: "training", hours: 2 },
      { "Idempotency-Key": key });
    expect(first.status).toBe(201);
    const second = await crc.post("/v1/timesheets",
      { studySiteId: siteId, workDate: today(), workType: "training", hours: 8 },
      { "Idempotency-Key": key });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("idempotency-key-reused");
  });
});
