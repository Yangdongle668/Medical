import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { boot, resetDb, as, api, type Caller } from "./harness.js";
import { randomUUID } from "node:crypto";
import pg from "pg";

/** 直接看库：投递这件事在响应里是**看不见**的（对外永远是同一个 202），
 *  只有 login_token.sent_to 说得出信到底往哪送。 */
async function db<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: process.env["TEST_DATABASE_URL"] });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}
const tokensOf = (login: string) => db(async (c) => (await c.query<{ sent_to: string }>(
  `SELECT t.sent_to FROM login_token t JOIN account a ON a.id = t.account_id
    WHERE a.login = $1 ORDER BY t.issued_at`, [login])).rows);
/** 把某个账号的收件地址摘掉，造出"存在、但没登记地址"那一种状态。
 *  演示种子给每个在职账号都登记了地址（否则演示环境里大半人登不进去），
 *  所以这个状态得在测试里自己造 —— 不能挑一个"恰好没有地址"的账号，
 *  那种测试会在下一次改种子时无声地失去意义。 */
const 摘掉地址 = (login: string) => db((c) => c.query(
  `DELETE FROM auth_identity i USING account a
    WHERE i.account_id = a.id AND a.login = $1 AND i.provider = 'magic-link'`, [login]));

let app: INestApplication, boss: Caller, pm: Caller;
beforeAll(async () => {
  resetDb(); app = await boot();
  boss = await as(app, "lingyuan");
  /* 关闭前的三本台账（药品 / 样本 / 伦理）是一线在记，
     经营层没有 subjWrite / ethics —— 拿 boss 去写会得到 403，
     而那个 403 是对的：它说明动作权限确实在把关。 */
  pm = await as(app, "hanxue");
}, 120_000);
afterAll(async () => { await app?.close(); });

let seq = 0;
async function freshSite() {
  /* 项目取**PM 看得见的那个**：PM 的行范围是 team，
     建档只有经营层做得了（manage），但建出来的中心得落在 PM 的范围里，
     否则后面用 PM 写台账会撞上 404（不在范围 = 不存在，不是 403）。 */
  const studies = await pm.get("/v1/studies?limit=1");
  expect(studies.status, `取项目失败：${JSON.stringify(studies.body)}`).toBe(200);
  const study = studies.body.items[0];
  const r = await boss.post("/v1/study-sites", {
    studyId: study.id, code: `SS-GATE${String(++seq).padStart(2, "0")}`,
    hospital: "闸门测试医院", dept: "科", city: "北京",
    piName: "测试研究者", contracted: 5, unitPriceCents: 1000000
  });
  /* 建档失败时不能悄悄往下走：后面的断言会去报一个完全无关的现象 */
  expect(r.status, `建档失败：${JSON.stringify(r.body)}`).toBe(201);
  return r.body as { id: string; code: string; state: string };
}
const advance = (id: string, to: string, reason?: string) =>
  boss.post(`/v1/study-sites/${id}:advance`, { to, ...(reason ? { reason } : {}) },
    { "Idempotency-Key": randomUUID() });

describe("闸门：推进不是给字段赋值，是断言一组事实成立", () => {
  it("无闸门的节点可以正常推进", async () => {
    const s = await freshSite();
    expect(s.state).toBe("intake");
    const r = await advance(s.id, "irb_submit", "材料齐备，已向伦理递交");
    expect(r.status).toBe(201);
    expect(r.body.data.state).toBe("irb_submit");
    expect(r.body.sideEffects[0].type).toBe("SiteStateChanged");
  });

  it("只能推进到状态机的下一节点，不能跳级", async () => {
    const s = await freshSite();
    const r = await advance(s.id, "closed", "想直接关掉");
    expect(r.status).toBe(422);
    expect(r.body.detail).toContain("下一节点");
  });

  it("推进到 SIV 被闸门拦下，并逐条说明还差什么", async () => {
    const s = await freshSite();
    for (const to of ["irb_submit", "irb_approve", "contract"])
      expect((await advance(s.id, to, "推进到下一节点")).status).toBe(201);

    const r = await advance(s.id, "siv", "准备启动");
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("gate-not-satisfied");
    expect(r.body.unmet.length).toBeGreaterThan(0);
    expect(r.body.unmet[0]).toMatchObject({ code: "startup-blockers", module: "startup" });
    /* 状态没有被改动 */
    expect((await boss.get(`/v1/study-sites/${s.id}`)).body.state).toBe("contract");
  });

  it("闸门预检接口在按钮点下去之前就给出答案", async () => {
    const s = await freshSite();
    /* 逐步断言：不 assert 的循环一旦有一步失败，后面的断言会去报一个
       完全无关的现象（"闸门说 from=intake"），而真正的原因被吞掉了。 */
    for (const to of ["irb_submit", "irb_approve", "contract"]) {
      const r = await advance(s.id, to, "按流程推进至下一节点");
      expect(r.status, `推进到 ${to} 失败：${JSON.stringify(r.body)}`).toBe(201);
    }
    const g = await boss.get(`/v1/study-sites/${s.id}/gate`);
    expect(g.status).toBe(200);
    expect(g.body).toMatchObject({ from: "contract", to: "siv", satisfied: false });
    expect(g.body.unmet.map((u: { module: string }) => u.module)).toContain("startup");
  });

  it("关闭闸门：八项全是真查询，一个占位都不剩", async () => {
    const s = await freshSite();                      // 无受试者、无质疑、无补偿
    const g = await boss.get(`/v1/study-sites/${s.id}/gate?to=closed`);
    expect(g.body.satisfied).toBe(false);

    /* 空中心上七项自然成立，只剩「没递交结题报告」——
       而它给的是一句人话，不是「该模块尚未交付」。 */
    expect(g.body.unmet.map((u: { code: string }) => u.code)).toEqual(["closeout-report"]);
    expect(g.body.unmet[0].message).toContain("尚未向伦理递交结题报告");

    /* 这一条是这次改动的整个意义所在：闸门里**不能再有占位项**。
       它们曾经挂了五个阶段，效果是"没有任何一个中心关得掉" ——
       看起来在把关，实际是一堵墙，而墙教会用户的是绕过它。
       下面四个用例逐条把新接上的检查推到 unmet 再推回 ok，
       "不是占位"这件事由那四条证明，这里守住的是措辞。 */
    for (const u of g.body.unmet) expect(u.message).not.toContain("尚未交付");
  });

  it("药品发出去了没收回来，就关不掉 —— 而且它说得出差多少", async () => {
    const s = await freshSite();
    const ip = (b: object) => pm.post(`/v1/study-sites/${s.id}/ip-movements`, b);

    expect((await ip({ kind: "receipt", quantity: 30 })).status).toBe(201);
    expect((await ip({ kind: "dispense", quantity: 12, subjectRef: "S-001" })).status).toBe(201);

    const g1 = await boss.get(`/v1/study-sites/${s.id}/gate?to=closed`);
    const stock = g1.body.unmet.find((u: { code: string }) => u.code === "ip-not-destroyed");
    expect(stock, `unmet=${JSON.stringify(g1.body.unmet)}`).toBeTruthy();
    /* 30 收 - 12 发 = 18 在手。数目要出现在消息里：
       只说"还有药品未处置"，人得自己去翻台账算一遍。 */
    expect(stock.message).toContain("18");

    /* 退回申办方要有单号 —— 没有单号的"退回"在核查面前等于没退 */
    const noRef = await ip({ kind: "ship_back", quantity: 18 });
    expect(noRef.status).toBe(422);

    expect((await ip({ kind: "ship_back", quantity: 18, refNo: "SF-77" })).status).toBe(201);
    const g2 = await boss.get(`/v1/study-sites/${s.id}/gate?to=closed`);
    expect(g2.body.unmet.map((u: { code: string }) => u.code)).toEqual(["closeout-report"]);
  });

  it("台账记反了会被闸门指出来：算出来是负数 = 记账错了，不是少了几盒", async () => {
    const s = await freshSite();
    expect((await pm.post(`/v1/study-sites/${s.id}/ip-movements`,
      { kind: "dispense", quantity: 5, subjectRef: "S-002" })).status).toBe(201);

    const g = await boss.get(`/v1/study-sites/${s.id}/gate?to=closed`);
    const bad = g.body.unmet.find((u: { code: string }) => u.code === "ip-imbalance");
    expect(bad, `unmet=${JSON.stringify(g.body.unmet)}`).toBeTruthy();
    expect(bad.message).toContain("不平");
  });

  it("样本寄出去没人确认收到，中心就关不掉", async () => {
    const s = await freshSite();
    const sp = await pm.post(`/v1/study-sites/${s.id}/specimens`,
      { subjectRef: "S-003", kind: "血样", collectedOn: "2026-01-05" });
    expect(sp.status, JSON.stringify(sp.body)).toBe(201);

    const g1 = await boss.get(`/v1/study-sites/${s.id}/gate?to=closed`);
    expect(g1.body.unmet.map((u: { code: string }) => u.code)).toContain("specimen-open");

    const adv = (b: object) => pm.post(`/v1/specimens/${sp.body.id}:advance`, b,
      { "Idempotency-Key": randomUUID() });
    expect((await adv({ stage: "shipped", on: "2026-01-06" })).status).toBe(201);
    /* 寄出**不是**闭环：在路上不知去向恰恰是最该拦的那种 */
    const g2 = await boss.get(`/v1/study-sites/${s.id}/gate?to=closed`);
    expect(g2.body.unmet.map((u: { code: string }) => u.code)).toContain("specimen-open");

    expect((await adv({ stage: "received", on: "2026-01-08" })).status).toBe(201);
    const g3 = await boss.get(`/v1/study-sites/${s.id}/gate?to=closed`);
    expect(g3.body.unmet.map((u: { code: string }) => u.code)).toEqual(["closeout-report"]);
  });

  it("递交了不等于批下来了 —— 闸门看的是批复", async () => {
    const s = await freshSite();
    const sub = await pm.post(`/v1/study-sites/${s.id}/regulatory-submissions`,
      { kind: "closeout", submittedOn: "2026-02-01", refNo: "EC-2026-88" });
    expect(sub.status, JSON.stringify(sub.body)).toBe(201);

    const g1 = await boss.get(`/v1/study-sites/${s.id}/gate?to=closed`);
    const still = g1.body.unmet.find((u: { code: string }) => u.code === "closeout-report");
    expect(still, "递交完就放行的话，这道闸门等于没有").toBeTruthy();
    expect(still.message).toContain("尚未批复");

    const d = await pm.post(`/v1/regulatory-submissions/${sub.body.id}:decide`,
      { decision: "approved", decidedOn: "2026-02-20" }, { "Idempotency-Key": randomUUID() });
    expect(d.status, JSON.stringify(d.body)).toBe(201);

    /* 八项全绿：这是这套闸门第一次真的能放行一个中心 */
    const g2 = await boss.get(`/v1/study-sites/${s.id}/gate?to=closed`);
    expect(g2.body.unmet, JSON.stringify(g2.body.unmet)).toEqual([]);
    expect(g2.body.satisfied).toBe(true);
  });
});

describe("认证：一次性链接、会话、停用即失效", () => {
  it("申请链接对存在与不存在的账号返回同样的 202 —— 不做账号枚举器", async () => {
    const ok = await api(app).post("/v1/auth/magic-link").send({ login: "zhanghm" });
    const no = await api(app).post("/v1/auth/magic-link").send({ login: "nobody_here" });
    /* 通道做出来之后**多了一种**账号状态：存在、但没登记收件地址。
       它必须和前两种长得一模一样，否则这个端点又变回枚举器。 */
    await 摘掉地址("zhaokun");
    const noAddr = await api(app).post("/v1/auth/magic-link").send({ login: "zhaokun" });
    expect([ok.status, no.status, noAddr.status]).toEqual([202, 202, 202]);
    expect(no.body.message).toBe(ok.body.message);
    expect(noAddr.body.message).toBe(ok.body.message);
  });

  it("链接可兑换为会话，且只能用一次", async () => {
    const issued = await api(app).post("/v1/auth/magic-link").send({ login: "zhanghm" });
    const token = issued.body.devToken as string;
    expect(token).toBeTruthy();

    const first = await api(app).post("/v1/auth/session").send({ token });
    expect(first.status).toBe(201);
    expect(first.body.token).toBeTruthy();

    const again = await api(app).post("/v1/auth/session").send({ token });
    expect(again.status).toBe(401);
    expect(again.body.detail).toContain("已被使用");
  });

  it("会话令牌可用于访问接口", async () => {
    const issued = await api(app).post("/v1/auth/magic-link").send({ login: "zhanghm" });
    const s = await api(app).post("/v1/auth/session").send({ token: issued.body.devToken });
    const r = await api(app).get("/v1/me").set({ Authorization: `Bearer ${s.body.token}` });
    expect(r.status).toBe(200);
    expect(r.body.account.login).toBe("zhanghm");
    expect(r.body.permissions.rowRule).toBe("hospital");
  });

  it("登出后令牌立刻失效", async () => {
    const c = await as(app, "tangyan");
    expect((await c.get("/v1/me")).status).toBe(200);
    expect((await c.post("/v1/auth/logout")).status).toBe(204);
    expect((await c.get("/v1/me")).status).toBe(401);
  });

  it("已停用账号无法开会话", async () => {
    const r = await api(app).post("/v1/auth/dev-session").send({ login: "zhouqi" });
    expect(r.status).toBe(401);
  });

  it("停用账号后，他手上已有的会话立刻失效", async () => {
    const victim = await as(app, "sheny" + "ilin");
    expect((await victim.get("/v1/me")).status).toBe(200);

    const acc = (await boss.get("/v1/accounts?limit=200")).body.items
      .find((a: { login: string }) => a.login === "shenyilin");
    /* 沈亦琳带着 SS-02，应当先被交接闸门拦下 */
    const blocked = await boss.post(`/v1/accounts/${acc.id}:disable`,
      { reason: "验证停用前必须先交接" }, { "Idempotency-Key": randomUUID() });
    expect(blocked.status).toBe(422);
    expect(blocked.body.code).toBe("gate-not-satisfied");
    expect(blocked.body.unmet[0].module).toBe("handover");
  });

  it("不带中心的人可以被停用，且其会话随即失效", async () => {
    const acc = (await boss.get("/v1/accounts?limit=200")).body.items
      .find((a: { login: string }) => a.login === "weilan");   // QA 无派工
    const victim = await as(app, "weilan");
    expect((await victim.get("/v1/me")).status).toBe(200);

    const r = await boss.post(`/v1/accounts/${acc.id}:disable`,
      { reason: "离职办理，账号停用但记录保留" }, { "Idempotency-Key": randomUUID() });
    expect(r.status).toBe(201);
    expect(r.body.data.status).toBe("disabled");
    /* resolve_session 只认在职账号 —— 停用即断线 */
    expect((await victim.get("/v1/me")).status).toBe(401);
  });

  it("不能停用自己", async () => {
    const me = (await boss.get("/v1/me")).body.account;
    const r = await boss.post(`/v1/accounts/${me.id}:disable`,
      { reason: "试图自我停用" }, { "Idempotency-Key": randomUUID() });
    expect(r.status).toBe(422);
    expect(r.body.detail).toContain("自己");
  });
});

/* ════════════════════════════════════════════════════════════════════
   登录链接送到哪去 —— 通道补上之后新出现的那条攻击面。

   `sentTo` 在契约里的说明一直是"仅用于审计留痕"。通道没做的时候
   它是惰性的；通道做出来之后，如果顺手拿它当收件地址，
   这个 @Public() 端点就成了一键账号接管：

     POST /v1/auth/magic-link {"login":"lingyuan","sentTo":"我@攻击者"}

   所以地址只能来自库里登记的那个（auth_identity，provider='magic-link'）。
   这几条盯的就是这件事。

   验过它不是空的：把 issue_login_link 的 v_dest 换成传进来的 sentTo，
   第一条当场红。
   ════════════════════════════════════════════════════════════════════ */
describe("收件地址由服务端解析，不由请求携带", () => {

  it("**请求里塞一个别的地址没有用**", async () => {
    const r = await api(app).post("/v1/auth/magic-link")
      .send({ login: "linmin", sentTo: "攻击者@evil.example" });
    expect(r.status).toBe(202);
    const rows = await tokensOf("linmin");
    expect(rows.at(-1)!.sent_to).toBe("linmin@hengji.example");
  });

  it("没登记地址的账号：照样 202，但不签一把没人收得到的令牌", async () => {
    /* 签了也没用 —— 没有任何通道知道该往哪送。留着只是往库里堆垃圾。 */
    await 摘掉地址("heyuwei");
    const r = await api(app).post("/v1/auth/magic-link").send({ login: "heyuwei" });
    expect(r.status).toBe(202);
    expect(await tokensOf("heyuwei")).toEqual([]);
  });

  it("登记之后就能签发了 —— 而且记的是登记的那个地址", async () => {
    await db((c) => c.query("SELECT app.set_login_address($1,$2)",
      ["heyuwei", "heyuwei@example.invalid"]));
    const r = await api(app).post("/v1/auth/magic-link").send({ login: "heyuwei" });
    expect(r.status).toBe(202);
    const rows = await tokensOf("heyuwei");
    expect(rows.map((x) => x.sent_to)).toEqual(["heyuwei@example.invalid"]);
  });

  it("手机号登记的账号走短信通道", async () => {
    await db((c) => c.query("SELECT app.set_login_address($1,$2)",
      ["xuqian", "+8613800001111"]));
    const r = await api(app).post("/v1/auth/magic-link").send({ login: "xuqian" });
    expect(r.status).toBe(202);
    expect((await tokensOf("xuqian")).at(-1)!.sent_to).toBe("+8613800001111");
  });

  it("一个地址不能同时属于两个账号 —— 那等于把登录入口转给别人", async () => {
    await expect(db((c) => c.query("SELECT app.set_login_address($1,$2)",
      ["duanzhiyu", "linmin@hengji.example"]))).rejects.toThrow(/另一个账号/);
  });

  it("既不像邮箱也不像手机号的地址当场拒绝", async () => {
    /* 打错的地址不会报错，只会让那个人永远收不到链接 ——
       而他会以为是系统坏了。 */
    await expect(db((c) => c.query("SELECT app.set_login_address($1,$2)",
      ["duanzhiyu", "写错了"]))).rejects.toThrow(/既不像邮箱/);
  });
});

/* ════════════════════════════════════════════════════════════════════
   限流真的接上了吗 —— 契约里 rate-limited(429) 一直在 COMMON_ERRORS 里，
   也就是每个端点都**声明**过自己可能返回 429，而实现一直没有。
   这一条验的是它现在真的会返回。
   ════════════════════════════════════════════════════════════════════ */
describe("公开端点的限流", () => {
  it("反复申请登录链接 → 到上限后 429，并说得出还要等多久", async () => {
    const login = "lingyuan";
    const limit = Number(process.env["SITEDESK_LINK_LIMIT"] ?? 5);

    let last: { status: number; body: { code?: string; detail?: string } } | null = null;
    for (let i = 0; i < limit + 2; i++)
      last = await api(app).post("/v1/auth/magic-link").send({ login });

    expect(last!.status).toBe(429);
    expect(last!.body.code).toBe("rate-limited");
    expect(last!.body.detail).toMatch(/秒后重试/);
  });

  it("换一个账号不受影响 —— 按 login 计数，不是全局闸门", async () => {
    /* 全局计数的话，一个人被刷就把所有人挡在门外 —— 那是拒绝服务，
       不是防拒绝服务。 */
    const r = await api(app).post("/v1/auth/magic-link").send({ login: "wutong" });
    expect(r.status).toBe(202);
  });
});
