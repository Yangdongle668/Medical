import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { owner, appConn } from "./helpers.js";

/* ════════════════════════════════════════════════════════════════════
   跨实例限流的数据库那一半。

   应用侧的两级逻辑由 apps/api/test/rate-limit.test.ts 验（用假的共享计数）；
   这里验的是**只有真数据库才回答得了**的三件事：

     · 并发下的原子性 —— "先查再改"会让两个并发请求双双通过，
       而限流器丢掉的那一次正是它存在的理由
     · 应用角色够不着那张表 —— 唯一入口是 SECURITY DEFINER 函数
     · 清理真的会删东西 —— 它在正式路径上只有 1% 的概率执行，
       所以必须能被单独调起来验

   验过它不是空的：把 ON CONFLICT 那条换成"先查再改"，
   "20 个并发只放行 5 个"当场红 —— 实测放行 6 个。
   只多一个，但限流器丢掉的从来就不是"很多次"，而是**恰好那一次**。
   ════════════════════════════════════════════════════════════════════ */

let o, a;
beforeAll(async () => { o = owner(); a = appConn(); await o.connect(); await a.connect(); });
afterAll(async () => { await o.end(); await a.end(); });
beforeEach(async () => { await o.query("DELETE FROM rate_limit_counter"); });

const hit = (client, bucket, limit = 3, windowMs = 60000) =>
  client.query("SELECT * FROM app.rate_limit_hit($1,$2,$3)", [bucket, limit, windowMs])
    .then(r => r.rows[0]);

describe("固定窗口计数", () => {
  it("窗口内放行到上限，之后拦下并说得出还要等多久", async () => {
    expect((await hit(a, "b1")).allowed).toBe(true);
    expect((await hit(a, "b1")).allowed).toBe(true);
    expect((await hit(a, "b1")).remaining).toBe(0);
    const 第四次 = await hit(a, "b1");
    expect(第四次.allowed).toBe(false);
    expect(第四次.retry_after_sec).toBeGreaterThan(0);
    expect(第四次.retry_after_sec).toBeLessThanOrEqual(60);
  });

  it("不同的 bucket 各算各的", async () => {
    for (let i = 0; i < 4; i++) await hit(a, "b1");
    expect((await hit(a, "b2")).allowed).toBe(true);
  });

  it("窗口过去之后重新开始", async () => {
    /* 不 sleep：把窗口起点往前拨。sleep 的时间相关测试要么慢，
       要么在 CI 上偶尔红，而"偶尔红"会让人把它标成 skip。 */
    for (let i = 0; i < 4; i++) await hit(a, "b1");
    expect((await hit(a, "b1")).allowed).toBe(false);
    await o.query("UPDATE rate_limit_counter SET window_start = window_start - interval '2 minutes'");
    expect((await hit(a, "b1")).allowed).toBe(true);
  });

  it("**用的是 clock_timestamp，不是 now()** —— 长事务里窗口也要过得去", async () => {
    /* now() 是**事务开始时间**，在一个事务里它一动不动。
       用 now() 写的话，这三步的第三步仍然会被拦：窗口永远过不去。
       而这件事只在长事务里才看得出来 —— 平时每个请求一个事务，
       两者看起来一模一样。 */
    await a.query("BEGIN");
    try {
      expect((await hit(a, "冻住", 1, 1000)).allowed).toBe(true);
      expect((await hit(a, "冻住", 1, 1000)).allowed).toBe(false);
      await a.query("SELECT pg_sleep(1.1)");
      expect((await hit(a, "冻住", 1, 1000)).allowed).toBe(true);
    } finally { await a.query("ROLLBACK"); }
  });
});

describe("并发", () => {
  it("20 个并发请求，阈值 5，只放行 5 个", async () => {
    /* 一条连接是串行的，所以必须用池子真的并发发出去。
       "先查再改"在这里实测放行 6 个 —— 而限流最该管用的时刻，
       正是有人在并发地刷它。 */
    const pool = new pg.Pool({ connectionString: process.env.APP_TEST_DATABASE_URL, max: 10 });
    try {
      const 结果 = await Promise.all(Array.from({ length: 20 }, () =>
        pool.query("SELECT allowed FROM app.rate_limit_hit($1,5,60000)", ["并发"])));
      expect(结果.filter(r => r.rows[0].allowed).length).toBe(5);
    } finally { await pool.end(); }
  });
});

describe("应用角色只能走函数", () => {
  it("直接读那张表被拒 —— 能读它就等于能看出某个 key 最近有没有被用过", async () => {
    await expect(a.query("SELECT * FROM rate_limit_counter")).rejects.toThrow(/permission denied/i);
  });

  it("直接写那张表也被拒", async () => {
    await expect(a.query("INSERT INTO rate_limit_counter (bucket) VALUES ('x')"))
      .rejects.toThrow(/permission denied/i);
  });

  it("清理函数不对应用角色开放 —— 那会是一个「触发全表清理」的开关", async () => {
    await expect(a.query("SELECT app.rate_limit_gc(interval '1 minute')"))
      .rejects.toThrow(/permission denied/i);
  });
});

describe("参数校验", () => {
  it("阈值必须 ≥ 1", async () => {
    await expect(hit(a, "b1", 0)).rejects.toThrow(/阈值/);
  });

  it("窗口必须在 1 秒到 1 天之间", async () => {
    await expect(hit(a, "b1", 3, 10)).rejects.toThrow(/窗口/);
    await expect(hit(a, "b1", 3, 86400001)).rejects.toThrow(/窗口/);
  });
});

describe("清理", () => {
  it("过期的行会被删掉，没过期的不动", async () => {
    /* 没有清理的话，这张表会按"每个窗口出现过的不同 key 数"一直长下去，
       而 key 的多少由未认证流量决定 —— 那就成了一条写满磁盘的路径。 */
    await hit(a, "新的");
    await hit(a, "旧的");
    await o.query(
      "UPDATE rate_limit_counter SET window_start = window_start - interval '1 hour' WHERE bucket = '旧的'");
    const { rows } = await o.query("SELECT app.rate_limit_gc(interval '10 minutes') AS 删了");
    expect(Number(rows[0].删了)).toBe(1);
    const 剩下 = await o.query("SELECT bucket FROM rate_limit_counter");
    expect(剩下.rows.map(r => r.bucket)).toEqual(["新的"]);
  });
});
