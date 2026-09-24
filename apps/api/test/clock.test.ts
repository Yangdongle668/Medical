import { describe, it, expect, afterEach } from "vitest";
import pg from "pg";
import { EventEmitter } from "node:events";
import type { Pool } from "pg";
import "./harness.js";
import { localDate, todayLocal, plusDays, todayDate, bizTz, validTz, DEFAULT_TZ } from "../src/infra/clock.js";
import { RequestMiddleware } from "../src/infra/request.middleware.js";
import { preflight } from "../src/infra/preflight.js";

/* ════════════════════════════════════════════════════════════════════
   「今天」是业务时区的今天。原来 JS 用 toISOString()、SQL 用会话默认 UTC 的
   CURRENT_DATE —— 北京每天 0–8 点，服务端的「今天」都是昨天。
   这里钉三件事：JS 那边算得对；每个事务都把 SQL 会话切到同一个时区；
   两边对同一个时区名给出同一天（Postgres 与 Node 各带一份时区库）。
   ════════════════════════════════════════════════════════════════════ */

const saved = process.env["SITEDESK_TZ"];
afterEach(() => {
  if (saved === undefined) delete process.env["SITEDESK_TZ"];
  else process.env["SITEDESK_TZ"] = saved;
});

describe("clock", () => {
  /* 北京 2026-09-28 07:00 = UTC 09-27 23:00 */
  const early = new Date("2026-09-27T23:00:00Z");

  it("北京早上七点，今天是北京的今天，不是 UTC 的昨天", () => {
    expect(localDate(early, "Asia/Shanghai")).toBe("2026-09-28");
    expect(localDate(early, "UTC")).toBe("2026-09-27");
  });

  it("不配 SITEDESK_TZ 时按默认的北京时间；配了就跟着走，且每次现读", () => {
    delete process.env["SITEDESK_TZ"];
    expect(bizTz()).toBe(DEFAULT_TZ);
    expect(todayLocal(early)).toBe("2026-09-28");
    process.env["SITEDESK_TZ"] = "UTC";
    expect(todayLocal(early)).toBe("2026-09-27");
    expect(todayDate(early).toISOString()).toBe("2026-09-27T00:00:00.000Z");
  });

  it("日期加减跨月跨年", () => {
    expect(plusDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(plusDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("时区名认不认得；认不得的 SITEDESK_TZ 拒绝启动", () => {
    expect(validTz("Asia/Shanghai")).toBe(true);
    expect(validTz("Asia/Beijing")).toBe(false);
    expect(preflight({ SITEDESK_TZ: "Asia/Beijing" }).fatal.join()).toMatch(/SITEDESK_TZ/);
    expect(preflight({ SITEDESK_TZ: "Asia/Shanghai" }).fatal.join()).not.toMatch(/SITEDESK_TZ/);
  });
});

describe("SQL 的今天", () => {
  it("每个请求事务都把会话时区设成业务时区，且在 BEGIN 之后", async () => {
    process.env["SITEDESK_TZ"] = "Pacific/Kiritimati";
    const seen: { q: string; p?: unknown[] }[] = [];
    const client = {
      query: async (q: unknown, p?: unknown[]) => { seen.push({ q: String(q), p }); return { rows: [] }; },
      release: () => {}
    };
    const pool = { connect: async () => client } as unknown as Pool;
    const req = { headers: {}, originalUrl: "/v1/study-sites", path: "/v1/study-sites" } as
      unknown as Parameters<RequestMiddleware["use"]>[0];
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200, writableEnded: true, setHeader() { return this; }, getHeader() { return undefined; }
    });
    await new RequestMiddleware(pool).use(
      req, res as unknown as Parameters<RequestMiddleware["use"]>[1], () => {});
    const i = seen.findIndex(s => s.q.includes("'TimeZone'"));
    expect(i).toBeGreaterThan(seen.findIndex(s => s.q === "BEGIN"));
    expect(seen[i]!.p).toEqual(["Pacific/Kiritimati"]);
  });

  it("Postgres 与 Node 对同一个时区名给出同一天（两个相差 26 小时的时区）", async () => {
    const c = new pg.Client({ connectionString: process.env["TEST_DATABASE_URL"] });
    await c.connect();
    try {
      const days: string[] = [];
      for (const tz of ["Pacific/Kiritimati", "Etc/GMT+12"]) {
        await c.query("BEGIN");
        await c.query("SELECT set_config('TimeZone', $1, true)", [tz]);
        const { rows } = await c.query<{ d: string }>("SELECT CURRENT_DATE::text AS d");
        await c.query("COMMIT");
        expect(rows[0]!.d, tz).toBe(localDate(new Date(), tz));
        days.push(rows[0]!.d);
      }
      expect(days[0]).not.toBe(days[1]);          // 真的切过去了，不是碰巧同一天
      /* 事务结束就复原 —— 连接还回池里不带着别人的时区 */
      const { rows } = await c.query<{ tz: string }>("SELECT current_setting('TimeZone') AS tz");
      expect(rows[0]!.tz).not.toBe("Etc/GMT+12");
    } finally { await c.end(); }
  });
});
