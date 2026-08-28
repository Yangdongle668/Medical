import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { boot, resetDb, as, api, type Caller } from "./harness.js";
import { randomUUID } from "node:crypto";
import pg from "pg";

/* ════════════════════════════════════════════════════════════════════
   「组织与权限」那一页背后的五个新端点。

   这一组盯的是**建出来的人能不能真的开始用**：
   在此之前管理员建得出账号，然后就没有别的了 ——
   改不了角色、看不到分组、停用之后启用不回来、
   而且新账号没有任何进得去的办法。

   最要紧的两条断言不是"接口返回 200"：
     · 改角色**当场生效**，不需要谁重新登录；
     · 改成 hospital 规则却没给 orgRef 的账号被拦下 ——
       那种账号登得进来、一行数据都看不到，而且没有任何提示。
   ════════════════════════════════════════════════════════════════════ */

async function db<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: process.env["TEST_DATABASE_URL"] });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

let app: INestApplication, admin: Caller, crc: Caller;
let roles: { id: string; code: string; name: string; rowRule: string;
             visibleFields: string[]; allowedActions: string[]; modules: string[] }[];

beforeAll(async () => {
  resetDb(); app = await boot();
  admin = await as(app, "admin");
  crc = await as(app, "wutong");
  roles = (await admin.get("/v1/roles")).body.items;
}, 180_000);
afterAll(async () => { await app?.close(); });

const roleOf = (code: string) => roles.find(r => r.code === code)!;
let seq = 0;
const freshLogin = () => `t${Date.now().toString(36)}${++seq}`;

async function newAccount(over: Record<string, unknown> = {}) {
  const login = freshLogin();
  const r = await admin.post("/v1/accounts", {
    login, displayName: "测试人员", roleId: roleOf("cra").id, ...over });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; login: string; role: { code: string } };
}

describe("manage 是这一整页的门", () => {
  it("CRC 建不了账号、改不了角色、开不了分组", async () => {
    for (const [what, r] of [
      ["建账号", await crc.post("/v1/accounts",
        { login: freshLogin(), displayName: "x", roleId: roleOf("cra").id })],
      ["建分组", await crc.post("/v1/teams", { code: "G-X1", name: "x" })]
    ] as [string, { status: number }][])
      expect(r.status, what).toBe(403);
  });

  it("但读得到 —— 台账和角色不是秘密，能不能改才是", async () => {
    expect((await crc.get("/v1/roles")).status).toBe(200);
    expect((await crc.get("/v1/teams")).status).toBe(200);
  });
});

describe("改账号的角色 / 分组", () => {
  it("改完当场生效 —— 不需要他重新登录", async () => {
    const a = await newAccount();
    /* 拿一个**在改之前就开好的**会话。这一条的全部意义在这里：
       权限是每个请求现算的，不是登录那一刻烤进令牌里的 ——
       所以旧会话拿到的必须是新权限。 */
    const his = await as(app, a.login);
    expect((await his.get("/v1/me")).body.account.role.code).toBe("cra");

    const r = await admin.patch(`/v1/accounts/${a.id}`,
      { roleId: roleOf("qa").id, reason: "转岗到质量保证" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    const me = await his.get("/v1/me");
    expect(me.body.account.role.code).toBe("qa");
    /* 行范围也跟着换了：cra 是 assigned（他一个中心都没被指派 → 0 个），
       qa 是 all（15 个）。角色改了而范围没跟着换，等于只改了个标签。 */
    expect(me.body.permissions.rowRule).toBe("all");
  });

  it("改成机构办却不给 orgRef —— 拦下来，并说清为什么", async () => {
    const a = await newAccount();
    const r = await admin.patch(`/v1/accounts/${a.id}`,
      { roleId: roleOf("inst").id, reason: "借调到机构办" });
    expect(r.status).toBe(422);
    expect(r.body.detail).toMatch(/一行数据都看不到/);
  });

  it("给了 orgRef 就过，且 is_external 跟着角色走", async () => {
    const a = await newAccount();
    const r = await admin.patch(`/v1/accounts/${a.id}`,
      { roleId: roleOf("inst").id, orgRef: "北京协和医院", reason: "借调到机构办" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    /* is_external 不由调用方传 —— "外部账号 + 内部角色"这种组合
       库里存得下，而它的意思没有人说得清。 */
    expect(r.body.isExternal).toBe(true);
    expect(r.body.orgRef).toBe("北京协和医院");
  });

  it("改角色进审计，且记得下前后两个角色", async () => {
    const a = await newAccount();
    await admin.patch(`/v1/accounts/${a.id}`,
      { roleId: roleOf("dm").id, reason: "转岗到数据管理" });
    const r = await admin.get(`/v1/audit-entries?targetType=account&targetId=${a.login}&limit=10`);
    const entry = r.body.items.find((x: { action: string }) => x.action === "调整账号角色");
    expect(entry, "改角色没有进审计轨迹").toBeTruthy();
    /* 只记一个 account id 的话，事后读不出发生了什么 */
    expect(entry.before.role).toBe("cra");
    expect(entry.after.role).toBe("dm");
    expect(entry.reason).toBe("转岗到数据管理");
  });
});

describe("停用与启用", () => {
  const idem = () => ({ "Idempotency-Key": randomUUID() });

  it("停用之后登不进去，启用之后又能进", async () => {
    const a = await newAccount();
    /* 201 而不是契约里写的 200 —— L2 命令**全仓都是这样**：
       Nest 对 POST 默认 201，而这些端点都没写 @HttpCode。
       跟着现状断言，不在这条测试里单独改两个端点的状态码，
       那只会让 :enable 和它旁边的 :disable / :advance 不一样。
       （arch:check 只比 operationId 与路径，比不到状态码 —— 所以它一直是绿的。） */
    expect((await admin.post(`/v1/accounts/${a.id}:disable`,
      { reason: "离职交接完成" }, idem())).status).toBe(201);

    /* 停用不只是个标签：resolve_login 只认 active 的账号 */
    const denied = await api(app).post("/v1/auth/dev-session").send({ login: a.login });
    expect(denied.status).toBe(401);

    const on = await admin.post(`/v1/accounts/${a.id}:enable`, { reason: "误停，恢复" }, idem());
    expect(on.status, JSON.stringify(on.body)).toBe(201);
    expect(on.body.data.status).toBe("active");
    expect((await api(app).post("/v1/auth/dev-session").send({ login: a.login })).status).toBe(201);
  });

  it("启用时说出「派工不会自己回来」—— 这正是最容易被误以为已经恢复的那件事", async () => {
    const a = await newAccount();
    await admin.post(`/v1/accounts/${a.id}:disable`, { reason: "离职交接完成" }, idem());
    const on = await admin.post(`/v1/accounts/${a.id}:enable`, { reason: "休假结束返岗" }, idem());
    expect(on.body.sideEffects[0].summary).toMatch(/不会自动回来/);
  });

  it("L2 命令没带幂等键就拒绝", async () => {
    const a = await newAccount();
    const r = await admin.post(`/v1/accounts/${a.id}:enable`, { reason: "缺幂等键的一次调用" });
    expect(r.status).toBe(422);
  });
});

describe("管理员给别人设初始口令", () => {
  it("设完他就登得进来，而且顶上会挂红条", async () => {
    const a = await newAccount();
    const r = await admin.post(`/v1/accounts/${a.id}:set-password`,
      { password: "onboarding-2026", reason: "新人入职，通道尚未配置" });
    expect(r.status, JSON.stringify(r.body)).toBe(204);

    const login = await api(app).post("/v1/auth/password-session")
      .send({ login: a.login, password: "onboarding-2026" });
    expect(login.status).toBe(201);
    const me = await api(app).get("/v1/me")
      .set({ Authorization: `Bearer ${login.body.token}` });
    /* 标成初始口令 —— "管理员知道别人的口令"是个短期状态，
       这个标记是让它保持短期的唯一办法。 */
    expect(me.body.credentials).toEqual({ hasPassword: true, passwordIsInitial: true });
  });

  it("设口令会把他现有的会话全部踢掉", async () => {
    const a = await newAccount();
    const his = await as(app, a.login);
    expect((await his.get("/v1/me")).status).toBe(200);
    await admin.post(`/v1/accounts/${a.id}:set-password`,
      { password: "onboarding-2026", reason: "账号疑似泄漏" });
    expect((await his.get("/v1/me")).status).toBe(401);
  });

  it("不能给自己设 —— 那等于绕过「验旧口令」那道门", async () => {
    const meRow = await admin.get("/v1/me");
    const r = await admin.post(`/v1/accounts/${meRow.body.account.id}:set-password`,
      { password: "a-long-enough-secret", reason: "想给自己换一个" });
    expect(r.status).toBe(422);
    expect(r.body.detail).toMatch(/验当前口令/);
  });

  it("口令本身一个字都不进审计 —— 记的是「谁给谁设过」", async () => {
    const a = await newAccount();
    await admin.post(`/v1/accounts/${a.id}:set-password`,
      { password: "onboarding-2026", reason: "新人入职，当面交付" });
    const r = await admin.get(`/v1/audit-entries?targetType=account&targetId=${a.login}&limit=10`);
    const entry = r.body.items.find((x: { action: string }) => x.action === "重设账号口令");
    expect(entry).toBeTruthy();
    expect(JSON.stringify(entry)).not.toContain("onboarding-2026");
  });
});

describe("分组", () => {
  it("列得出来，并且数得出组员与承接的项目", async () => {
    const r = await admin.get("/v1/teams");
    expect(r.status).toBe(200);
    const g = r.body.items.find((t: { code: string }) => t.code === "G-01");
    expect(g, "演示种子里的 G-01 不见了").toBeTruthy();
    expect(g.memberCount).toBeGreaterThan(0);
    /* 分组不是通讯录：PM 的行范围就是本组承接的项目 */
    expect(g.studyCount).toBeGreaterThan(0);
  });

  it("建得出新组，代号撞了会说清是哪个", async () => {
    const code = `G-${Date.now().toString(36).slice(-4)}`;
    const r = await admin.post("/v1/teams", { code, name: "华中组" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.memberCount).toBe(0);

    const again = await admin.post("/v1/teams", { code, name: "重名" });
    expect(again.status).toBe(422);
    expect(again.body.detail).toContain(code);
  });

  it("把人放进组里，PM 的行范围立刻跟着变", async () => {
    /* 这一条才是分组的意义。建一个 PM，先不分组 —— 他一个中心都看不到；
       放进 G-01 之后，他看得到 G-01 承接项目下的全部中心。 */
    const pm = await newAccount({ roleId: roleOf("pm").id });
    const his = await as(app, pm.login);
    expect((await his.get("/v1/study-sites?limit=100")).body.items.length).toBe(0);

    const g1 = (await admin.get("/v1/teams")).body.items
      .find((t: { code: string }) => t.code === "G-01");
    expect(g1?.studyCount, "G-01 一个项目都不承接，这条测试就证明不了什么").toBeGreaterThan(0);
    const moved = await admin.patch(`/v1/accounts/${pm.id}`,
      { teamId: g1.id, reason: "调入华东华南组" });
    /* 不断言这一步的话，下面那句 0 > 0 会指向"行范围没跟着变"，
       而真正的原因可能只是这次 PATCH 根本没成功。 */
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.team?.code).toBe("G-01");

    const after = await his.get("/v1/study-sites?limit=100");
    expect(after.body.items.length).toBeGreaterThan(0);
  });
});

describe("角色权限：改完立即生效", () => {
  it("给 CRA 加上「报价与合同金额」，他当场就看得到那一列", async () => {
    const cra = await as(app, "linmin");
    const before = await cra.get("/v1/study-sites?limit=1");
    expect("unitPriceCents" in before.body.items[0]).toBe(false);

    const craRole = roleOf("cra");
    const r = await admin.patch(`/v1/roles/${craRole.id}`, {
      visibleFields: [...craRole.visibleFields, "price"],
      reason: "临时授权 CRA 查看报价，用于本季度中心谈判" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    /* **同一个会话**，没有重新登录 */
    const after = await cra.get("/v1/study-sites?limit=1");
    expect("unitPriceCents" in after.body.items[0]).toBe(true);

    /* 收回去，别把后面的测试拖下水 */
    await admin.patch(`/v1/roles/${craRole.id}`,
      { visibleFields: craRole.visibleFields, reason: "谈判结束，收回" });
    const back = await cra.get("/v1/study-sites?limit=1");
    expect("unitPriceCents" in back.body.items[0]).toBe(false);
  });

  it("模块勾掉一个，那个角色的导航当场少一项 —— 但数据一点不少", async () => {
    const dm = roleOf("dm");
    const his = await as(app, "miaoqing");
    expect((await his.get("/v1/me")).body.permissions.modules).toContain("trail");
    const sitesBefore = (await his.get("/v1/study-sites?limit=100")).body.items.length;

    await admin.patch(`/v1/roles/${dm.id}`, {
      modules: dm.modules.filter(m => m !== "trail"),
      reason: "审计轨迹收归 QA" });

    const me = await his.get("/v1/me");
    expect(me.body.permissions.modules).not.toContain("trail");
    /* role_module 只收敛导航 —— 它不是安全边界，数据一行都不该少 */
    expect((await his.get("/v1/study-sites?limit=100")).body.items.length).toBe(sitesBefore);

    await admin.patch(`/v1/roles/${dm.id}`, { modules: dm.modules, reason: "验证完毕，恢复原状" });
  });
});
