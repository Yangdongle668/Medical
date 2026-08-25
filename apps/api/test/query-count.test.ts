import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { boot, resetDb, as, type Caller } from "./harness.js";

/* ════════════════════════════════════════════════════════════════════
   一个请求发多少条 SQL —— 把 N+1 变成看得见的数字。

   N+1 的特征不是"慢"，是**条数随数据量线性增长**：
   开发库上 15 个中心跑得飞快，上线之后 1500 个中心就是 1500 条查询。
   它不报错、不变红、在任何功能测试里都表现正常 ——
   直到数据长起来，然后是一整个下午的排查。

   所以这一组不测"快不快"（那依赖机器，会变成 flaky），
   测的是**条数**，而且是相对条数：
   同一个端点，limit 拉大一倍，SQL 条数不许跟着涨。
   这条判据对机器速度免疫，却正好卡住 N+1 的定义。

   计数器只数**业务查询**：中间件自己的 BEGIN / SET LOCAL / 解析会话 /
   装载主体走的是原始连接，不经过代理。所以列表端点的基线是个位数，
   一眼看得出多出来的是谁。

   验过它不是空的：往中心列表里塞一个按行查库的循环，立刻红成
   `expected 17 to be 3` —— 15 个中心，17 条查询。
   ════════════════════════════════════════════════════════════════════ */

let app: INestApplication, boss: Caller, crc: Caller;

beforeAll(async () => {
  resetDb();
  process.env.SITEDESK_QUERY_STATS = "1";
  app = await boot();
  boss = await as(app, "lingyuan");
  crc  = await as(app, "wutong");
}, 120_000);
afterAll(async () => { await app?.close(); });

const count = (r: { headers: Record<string, string> }) =>
  Number(r.headers["x-query-count"]);

/** 同一个端点取 n 条要发多少 SQL */
async function at(c: Caller, path: string, limit: number) {
  const r = await c.get(`${path}${path.includes("?") ? "&" : "?"}limit=${limit}`);
  expect(r.status, `${path} limit=${limit} → ${JSON.stringify(r.body).slice(0, 200)}`).toBe(200);
  return { n: count(r), rows: (r.body.items ?? []).length };
}

describe("列表端点：SQL 条数不随取回的行数增长", () => {
  /* 每个端点两次：少取一点、多取一点。条数一样 = 没有按行查库。 */
  const cases: [string, string][] = [
    ["中心列表",   "/v1/study-sites"],
    ["账号列表",   "/v1/accounts"],
    ["受试者列表", "/v1/subjects"],
    ["访视列表",   "/v1/subject-visits"],
    ["质量事件",   "/v1/quality-events"],
    ["工时台账",   "/v1/timesheets"],
    ["审计轨迹",   "/v1/audit-entries"]
  ];

  for (const [name, path] of cases)
    it(`${name}：limit 1 与 limit 50 发同样多的 SQL`, async () => {
      const few  = await at(boss, path, 1);
      const many = await at(boss, path, 50);
      expect(many.rows).toBeGreaterThan(few.rows);      // 确实多取了，否则这条测试是空的
      expect(many.n).toBe(few.n);
    });
});

describe("聚合端点：条数是常量", () => {
  it("/v1/me 的 SQL 条数与可见中心数无关", async () => {
    /* boss 看得到全部 15 个，CRC 只看得到被指派的几个。
       条数不同的话，说明它在按中心逐个查。 */
    const b = count(await boss.get("/v1/me"));
    const c = count(await crc.get("/v1/me"));
    expect(b).toBe(c);
  });
});
