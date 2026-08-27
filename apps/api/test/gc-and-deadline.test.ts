import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import pg from "pg";
import { boot, resetDb, as, api, type Caller } from "./harness.js";
import { randomUUID } from "node:crypto";

/* ════════════════════════════════════════════════════════════════════
   两件「写了一半」的事，各自的收口。

   ── 一、清理任务（欠账 B2） ──────────────────────────────────────
   idempotency_key 的表注释从 Phase 3 起就写着「24 小时保留，之后由
   清理任务删除」，而那个任务从来不存在。这一组验它现在真的会删，
   而且**删对了东西** —— 未完成的幂等键不能删：删掉等于允许同一把键
   被重放两次。

   ── 二、请求截止时间（欠账 B12） ─────────────────────────────────
   处理器卡在数据库之外时，那条连接原来要等 idle_in_transaction 的
   60 秒才回得来，而客户端那头是无限期地挂着。
   这里用一把表锁造一个真的卡住的请求，看它是不是在截止时间上被收尾。
   ════════════════════════════════════════════════════════════════════ */

let app: INestApplication, boss: Caller;
beforeAll(async () => {
  /* 截止时间必须在 boot 之前设 —— 但中间件是**按次读**的，
     所以这里设了就一定生效（做成模块级常量的话这条测试会假绿）。 */
  process.env["SITEDESK_REQUEST_TIMEOUT_MS"] = "800";
  resetDb(); app = await boot(); boss = await as(app, "lingyuan");
}, 120_000);
afterAll(async () => {
  await app?.close();
  delete process.env["SITEDESK_REQUEST_TIMEOUT_MS"];
});

const owner = async () => {
  const c = new pg.Client({ connectionString: process.env["TEST_DATABASE_URL"] });
  await c.connect();
  return c;
};

describe("过期数据的清理", () => {
  it("已完成且过了保留期的幂等键会被删掉", async () => {
    const c = await owner();
    try {
      const key = randomUUID();
      const acc = (await c.query<{ id: string }>(
        "SELECT id FROM account WHERE login = 'lingyuan'")).rows[0]!.id;
      await c.query(
        `INSERT INTO idempotency_key (key, account_id, endpoint, request_hash,
                                      response_status, response_body, created_at, completed_at)
         VALUES ($1,$2,'t','h',200,'{}'::jsonb, now() - interval '3 days', now() - interval '3 days')`,
        [key, acc]);
      const { rows } = await c.query<{ idem_deleted: string }>(
        "SELECT idem_deleted FROM app.gc_expired()");
      expect(Number(rows[0]!.idem_deleted)).toBeGreaterThanOrEqual(1);
      const left = await c.query("SELECT 1 FROM idempotency_key WHERE key = $1", [key]);
      expect(left.rowCount).toBe(0);
    } finally { await c.end(); }
  });

  it("**未完成的幂等键不删** —— 删掉等于允许同一把键被重放两次", async () => {
    const c = await owner();
    try {
      const key = randomUUID();
      const acc = (await c.query<{ id: string }>(
        "SELECT id FROM account WHERE login = 'lingyuan'")).rows[0]!.id;
      await c.query(
        `INSERT INTO idempotency_key (key, account_id, endpoint, request_hash, created_at)
         VALUES ($1,$2,'t','h', now() - interval '30 days')`, [key, acc]);
      await c.query("SELECT app.gc_expired()");
      const left = await c.query("SELECT 1 FROM idempotency_key WHERE key = $1", [key]);
      expect(left.rowCount).toBe(1);
    } finally { await c.end(); }
  });

  it("没到保留期的不删", async () => {
    const c = await owner();
    try {
      const key = randomUUID();
      const acc = (await c.query<{ id: string }>(
        "SELECT id FROM account WHERE login = 'lingyuan'")).rows[0]!.id;
      await c.query(
        `INSERT INTO idempotency_key (key, account_id, endpoint, request_hash,
                                      response_status, response_body, completed_at)
         VALUES ($1,$2,'t','h',200,'{}'::jsonb, now())`, [key, acc]);
      await c.query("SELECT app.gc_expired()");
      expect((await c.query("SELECT 1 FROM idempotency_key WHERE key = $1", [key])).rowCount).toBe(1);
    } finally { await c.end(); }
  });

  it("应用角色够不着表，只能走这个函数", async () => {
    /* 三张表都带 RLS，而清理任务没有身份可设 —— 用应用角色直接 DELETE
       一行也删不掉，**而且不会报错**（RLS 过滤掉的行就当不存在）。
       那正是一个「跑了但什么也没删」的定时任务能安静跑一年的原因。 */
    /* 用 APP_DATABASE_URL，不是 APP_TEST_DATABASE_URL —— harness 把前者
       指向了本文件独占的那个库，后者还指着基库（那里没跑最新的迁移）。 */
    const c = new pg.Client({ connectionString: process.env["APP_DATABASE_URL"] });
    await c.connect();
    try {
      const r = await c.query("DELETE FROM idempotency_key WHERE created_at < now()");
      expect(r.rowCount).toBe(0);                       // 删不到，也不报错
      const g = await c.query("SELECT * FROM app.gc_expired()");   // 函数则能用
      expect(g.rowCount).toBe(1);
    } finally { await c.end(); }
  });
});

describe("请求截止时间", () => {
  it("卡在数据库之外的请求被收尾成 504，而不是无限期挂着", async () => {
    /* 用一把 ACCESS EXCLUSIVE 表锁造一个真的卡住的请求。
       语句超时是 30 秒、截止时间设成了 0.8 秒，所以先到的一定是截止时间。 */
    const blocker = await owner();
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE study_site IN ACCESS EXCLUSIVE MODE");
      const r = await boss.get("/v1/study-sites?limit=1");
      expect(r.status).toBe(504);
      expect(r.body.code).toBe("request-timeout");
      expect(r.body.traceId).toBeTruthy();              // 报障要用的那个号
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      await blocker.end();
    }
  }, 30_000);

  it("锁放开之后，后面的请求照常", async () => {
    /* 收尾必须干净：连接还回池子、下一个请求拿到的是一条好连接。 */
    const r = await boss.get("/v1/study-sites?limit=1");
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(0);
  }, 30_000);
});
