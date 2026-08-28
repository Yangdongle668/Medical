import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { boot, resetDb, as, api, type Caller } from "./harness.js";
import pg from "pg";

/* ════════════════════════════════════════════════════════════════════
   口令登录与出厂管理员。

   这一组盯的不是"能不能登进去"（那太容易绿了），而是四件容易漏的事：

     ① 三种失败长得一样吗 —— 账号不存在 / 没设口令 / 口令不对；
     ② 失败计数**活得过回滚**吗 —— 登录失败要抛 401，抛错就回滚，
        记在请求那条连接上的次数会跟着一起没掉，锁定于是永不生效；
     ③ 出厂标记只能从 true 变 false 吗；
     ④ 改完密，别的会话真的断了、当前这个真的还在吗。

   ②③④ 都是"看起来在工作、其实没有"的那一类：
   界面上完全正常，日志里一个字都没有。
   ════════════════════════════════════════════════════════════════════ */

async function db<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: process.env["TEST_DATABASE_URL"] });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

const 口令行 = (login: string) => db(async (c) => {
  const { rows } = await c.query<{
    is_initial: boolean; failed_count: number; locked_until: Date | null; hash: string;
  }>(`SELECT p.is_initial, p.failed_count, p.locked_until, p.hash
        FROM auth_password p JOIN account a ON a.id = p.account_id
       WHERE a.login = $1`, [login]);
  /* 没有这一行就直接读 rows[0] 的话，"这个人根本没设过口令"会以
     `Cannot read property of undefined` 的样子失败 —— 指向完全错的方向。 */
  if (!rows[0]) throw new Error(`账号 ${login} 没有 auth_password 行`);
  return rows[0];
});

const 设口令 = async (login: string, hash: string) => {
  const r = await db((c) => c.query(
    `SELECT app.set_password(a.id, $2, false) FROM account a WHERE a.login = $1`,
    [login, hash]));
  /* 登录名打错时这句 SELECT 会安静地跑 0 行 —— set_password 根本没被调到，
     而它自己那句"账号不存在"也就永远不会响。断言行数，
     否则下面的测试会以「没有 auth_password 行」的样子失败，
     指向"口令功能坏了"，而真正的原因是种子里没有这个人。 */
  if (!r.rowCount) throw new Error(`种子里没有账号 ${login}`);
};

const 活着的会话数 = (login: string) => db(async (c) => Number((await c.query<{ n: string }>(
  `SELECT count(*) AS n FROM auth_session s JOIN account a ON a.id = s.account_id
    WHERE a.login = $1 AND s.revoked_at IS NULL`, [login])).rows[0]!.n));

const login = (body: { login: string; password: string }) =>
  api(app).post("/v1/auth/password-session").send(body);

let app: INestApplication;
beforeAll(async () => { resetDb(); app = await boot(); }, 180_000);
afterAll(async () => { await app?.close(); });

describe("出厂管理员：一次干净部署之后，有人打得开门", () => {
  it("admin / admin 登得进去", async () => {
    const r = await login({ login: "admin", password: "admin" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });

  it("它是系统管理员，45 个模块一个不少", async () => {
    const r = await login({ login: "admin", password: "admin" });
    const me = await api(app).get("/v1/me").set({ Authorization: `Bearer ${r.body.token}` });
    expect(me.status).toBe(200);
    expect(me.body.account.role.code).toBe("admin");
    expect(me.body.permissions.modules).toHaveLength(45);
    /* org 是「组织与权限」—— 管理员没有它，这个角色就没有意义 */
    expect(me.body.permissions.modules).toContain("org");
    expect(me.body.permissions.actions).toContain("manage");
  });

  it("默认拿不到 L3 受试者字段 —— 要给，得在组织与权限里显式给，那一下会进审计", async () => {
    const r = await login({ login: "admin", password: "admin" });
    const me = await api(app).get("/v1/me").set({ Authorization: `Bearer ${r.body.token}` });
    expect(me.body.permissions.fields).not.toContain("subject");
  });

  it("/v1/me 说得出「你还在用出厂口令」—— 界面那条红条就挂在它上面", async () => {
    const r = await login({ login: "admin", password: "admin" });
    const me = await api(app).get("/v1/me").set({ Authorization: `Bearer ${r.body.token}` });
    expect(me.body.credentials).toEqual({ hasPassword: true, passwordIsInitial: true });
  });

  it("没设过口令的人，credentials 说的是实话", async () => {
    const crc = await as(app, "wutong");
    const me = await crc.get("/v1/me");
    expect(me.body.credentials).toEqual({ hasPassword: false, passwordIsInitial: false });
  });
});

describe("三种失败长得一模一样 —— 否则这个端点就是账号枚举器", () => {
  const 说法 = async (body: { login: string; password: string }) => {
    const r = await login(body);
    return { status: r.status, code: r.body.code, detail: r.body.detail };
  };

  it("账号不存在 / 没设口令 / 口令不对，返回的是同一句话", async () => {
    const 不存在 = await 说法({ login: "meiyouzhegeren", password: "whatever" });
    const 没口令 = await 说法({ login: "wutong", password: "whatever" });
    const 不对   = await 说法({ login: "admin", password: "not-admin" });
    expect(不存在.status).toBe(401);
    expect(不存在).toEqual(没口令);
    expect(不存在).toEqual(不对);
  });
});

describe("失败计数必须活过回滚 —— 否则锁定永远不会生效", () => {
  it("猜错一次，库里的 failed_count 真的涨了", async () => {
    /* 这条是这一组里最要紧的。登录失败要抛 401，而抛错 = 回滚：
       计数写在请求那条连接上的话，它跟着回滚一起消失，
       failed_count 永远是 0，看上去像"从来没人猜错过"。
       PgSharedCounter 里已经栽过同一个坑（限流的计数必须活过回滚）。 */
    await 设口令("liaomeng", "scrypt$16384$8$1$c2l0ZWRlc2stZmFjdG9yeQ$T3TdlA6M_GhqU-Ska4h5t9w0FjWOOghdeuexb4TgYzI");
    expect((await 口令行("liaomeng")).failed_count).toBe(0);
    await login({ login: "liaomeng", password: "错的" });
    expect((await 口令行("liaomeng")).failed_count).toBe(1);
  });

  it("连续猜到第 4 次，账号被锁 —— 而且锁定说得出还剩多久", async () => {
    await 设口令("shenyilin", "scrypt$16384$8$1$c2l0ZWRlc2stZmFjdG9yeQ$T3TdlA6M_GhqU-Ska4h5t9w0FjWOOghdeuexb4TgYzI");
    for (let i = 0; i < 4; i++) await login({ login: "shenyilin", password: "错的" });
    const row = await 口令行("shenyilin");
    expect(row.failed_count).toBe(4);
    expect(row.locked_until).toBeInstanceOf(Date);

    /* 锁上之后，**连对的口令也进不去** —— 否则锁定只是个装饰 */
    const r = await login({ login: "shenyilin", password: "admin" });
    expect(r.status).toBe(429);
    expect(r.body.detail).toMatch(/锁定/);
  });

  it("登对了就清零", async () => {
    await 设口令("tangyan", "scrypt$16384$8$1$c2l0ZWRlc2stZmFjdG9yeQ$T3TdlA6M_GhqU-Ska4h5t9w0FjWOOghdeuexb4TgYzI");
    await login({ login: "tangyan", password: "错的" });
    expect((await 口令行("tangyan")).failed_count).toBe(1);
    expect((await login({ login: "tangyan", password: "admin" })).status).toBe(201);
    expect((await 口令行("tangyan")).failed_count).toBe(0);
  });
});

describe("改口令", () => {
  let admin: Caller;
  beforeAll(async () => {
    const r = await login({ login: "admin", password: "admin" });
    const h = { Authorization: `Bearer ${r.body.token}` };
    admin = {
      token: r.body.token,
      get: (p: string) => api(app).get(p).set(h),
      post: (p: string, b?: unknown, extra: Record<string, string> = {}) =>
        api(app).post(p).set({ ...h, ...extra }).send(b ?? {}),
      patch: (p: string, b?: unknown) => api(app).patch(p).set(h).send(b ?? {})
    };
  });

  it("弱口令改不了 —— 尤其是 admin 本身", async () => {
    const r = await admin.post("/v1/auth/password",
      { currentPassword: "admin", newPassword: "admin123" });
    expect(r.status).toBe(422);
    expect(r.body.detail).toMatch(/前一百名/);
  });

  it("旧口令不对，改不动 —— 会话被偷走时这是唯一一道门", async () => {
    const r = await admin.post("/v1/auth/password",
      { currentPassword: "不是 admin", newPassword: "a-long-enough-secret" });
    expect(r.status).toBe(401);
  });

  it("改成功：出厂标记灭掉，其余会话断掉，当前这个还在", async () => {
    /* 先另开两个会话，等下要验它们真的被踢了 */
    await login({ login: "admin", password: "admin" });
    await login({ login: "admin", password: "admin" });
    expect(await 活着的会话数("admin")).toBeGreaterThanOrEqual(3);

    const r = await admin.post("/v1/auth/password",
      { currentPassword: "admin", newPassword: "a-long-enough-secret" });
    expect(r.status, JSON.stringify(r.body)).toBe(204);

    /* ① 红条该灭了 */
    expect((await 口令行("admin")).is_initial).toBe(false);
    /* ② 只剩当前这一个 —— 改密的常见理由就是「号可能被人拿了」 */
    expect(await 活着的会话数("admin")).toBe(1);
    /* ③ 当前这个还能用：把自己也踢掉的话，人改完密码就被弹回登录页，
          会以为改失败了 */
    expect((await admin.get("/v1/me")).status).toBe(200);
    /* ④ 新口令登得进去，旧的进不去 */
    expect((await login({ login: "admin", password: "a-long-enough-secret" })).status).toBe(201);
    expect((await login({ login: "admin", password: "admin" })).status).toBe(401);
  });

  it("出厂标记翻不回去 —— 能被重新点亮的报警灯等于没有报警灯", async () => {
    await expect(db((c) => c.query(
      `UPDATE auth_password SET is_initial = true
        WHERE account_id = (SELECT id FROM account WHERE login = 'admin')`)))
      .rejects.toThrow(/报警灯/);
  });
});
