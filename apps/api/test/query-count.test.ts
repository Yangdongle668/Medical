import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { boot, resetDb, as, api, type Caller } from "./harness.js";

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
    ["审计轨迹",   "/v1/audit-entries"],
    /* 这一条是补上的：交接台账原来不在这张表里，而它恰恰是唯一一个
       真的在按行查库的端点（每行三条）。守卫没覆盖到的地方，
       "目前没有 N+1"这句话就不成立 —— 而它当时被当成了全局结论。 */
    ["交接台账",   "/v1/handovers"]
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

/* ════════════════════════════════════════════════════════════════════
   存活探针一条 SQL 都不许发。

   这不是性能问题，是可用性问题：存活探针一旦（哪怕间接）依赖数据库，
   数据库抖一下，所有实例的存活探针一起失败，编排器把它们**全部重启** ——
   一次数据库故障就此被放大成一次全站故障，而重启风暴还会让数据库
   恢复得更慢。

   "不碰库"这件事光靠读代码保证不了：请求中间件默认对**每个**请求
   取连接 + BEGIN，只要有人把探针路径写错一个字母，它就悄悄回到了
   依赖数据库的状态 —— 而且在数据库正常时完全看不出来。
   所以把它钉成一个数字。
   ════════════════════════════════════════════════════════════════════ */
describe("健康探针", () => {
  it("存活探针发 0 条 SQL，而普通端点至少 1 条", async () => {
    const live = await boss.get("/v1/health");
    expect(live.status).toBe(200);
    expect(count(live)).toBe(0);

    /* 对照组：没有这一条，上面那个 0 可能只是因为计数器根本没接上 */
    const normal = await boss.get("/v1/study-sites?limit=1");
    expect(count(normal)).toBeGreaterThan(0);
  });

  it("存活探针不需要认证 —— 探针在拿到凭据之前就要能用", async () => {
    const r = await api(app).get("/v1/health");
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("ok");
  });

  it("就绪探针真的探了库（发了 SQL），库在时 200", async () => {
    /* 只回 200 的就绪探针等于没有 —— 它会把连不上库的实例放进负载均衡。
       就绪探针自己从池子取连接，不走请求事务，所以计数是 0；
       这里验的是它的**语义**：库在 → ready，并给出探库耗时。 */
    const r = await api(app).get("/v1/health/ready");
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("ready");
    expect(typeof r.body.checkMs).toBe("number");
  });
});
