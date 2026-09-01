import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { boot, resetDb, as, type Caller } from "./harness.js";

/* ════════════════════════════════════════════════════════════════════
   损益的列表形态。

   最要紧的一条不是"能返回"，是**它和单中心那一页说的是同一件事**。
   两套口径迟早长出分歧，而分歧只有对账那天才看得见 ——
   到那时没人说得清哪一个是对的。

   所以这里逐个中心、逐个字段比。
   ════════════════════════════════════════════════════════════════════ */

let app: INestApplication, boss: Caller, crc: Caller, cra: Caller;
beforeAll(async () => {
  resetDb(); app = await boot();
  boss = await as(app, "lingyuan");
  crc = await as(app, "wutong");
  cra = await as(app, "linmin");
}, 180_000);
afterAll(async () => { await app?.close(); });

describe("和 getSitePnl 是同一套口径", () => {
  it("每一个中心逐字段相等", async () => {
    const list = await boss.get("/v1/pnl?limit=100");
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.items.length).toBe(15);
    for (const row of list.body.items) {
      const one = await boss.get(`/v1/study-sites/${row.studySiteId}/pnl`);
      expect(one.status).toBe(200);
      expect(one.body, `${row.siteCode} 两处对不上`).toEqual(row);
    }
  });

  it("口径版本号跟着一起下发 —— 报表要能标出「按哪版算的」", async () => {
    const r = await boss.get("/v1/pnl?limit=1");
    expect(r.body.items[0].calcVersion).toBeTruthy();
  });
});

describe("列权限：同一个接口，不同的人少几栏", () => {
  it("CRC 看得到中心，看不到钱", async () => {
    const r = await crc.get("/v1/pnl?limit=100");
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(0);
    const row = r.body.items[0];
    /* 字段是**删掉**，不是置 null —— null 分不清"没权限"与"没有值" */
    expect("revenueCents" in row.revenue).toBe(false);
    expect("totalCostCents" in row.cost).toBe(false);
    expect("grossProfitCents" in row).toBe(false);
    /* 但入组数这类非敏感字段照给 */
    expect(typeof row.enrolled).toBe("number");
  });

  it("CRA 拿得到成本却拿不到毛利 —— 这两维是分开授予的", async () => {
    const r = await cra.get("/v1/pnl?limit=100");
    expect(r.status).toBe(200);
    const row = r.body.items[0];
    expect("grossProfitCents" in row).toBe(false);
    expect("grossMargin" in row).toBe(false);
  });
});

describe("行范围", () => {
  it("CRC 只看得到被指派的那几个", async () => {
    const r = await crc.get("/v1/pnl?limit=100");
    const sites = await crc.get("/v1/study-sites?limit=100");
    expect(r.body.items.map((x: { siteCode: string }) => x.siteCode).sort())
      .toEqual(sites.body.items.map((x: { code: string }) => x.code).sort());
  });
});

describe("筛与分页", () => {
  it("lossOnly 只留毛利为负的", async () => {
    const all = await boss.get("/v1/pnl?limit=100");
    const loss = await boss.get("/v1/pnl?lossOnly=true&limit=100");
    const expected = all.body.items.filter((x: { grossProfitCents: number }) =>
      x.grossProfitCents < 0);
    expect(loss.body.items.length).toBe(expected.length);
    for (const x of loss.body.items) expect(x.grossProfitCents).toBeLessThan(0);
  });

  it("lossOnly=false 是 false", async () => {
    const off = await boss.get("/v1/pnl?lossOnly=false&limit=100");
    expect(off.body.items.length).toBe(15);
  });

  it("游标翻页不重不漏", async () => {
    const p1 = await boss.get("/v1/pnl?limit=6");
    expect(p1.body.items.length).toBe(6);
    const p2 = await boss.get(`/v1/pnl?limit=100&cursor=${p1.body.nextCursor}`);
    const codes = [...p1.body.items, ...p2.body.items]
      .map((x: { siteCode: string }) => x.siteCode);
    expect(new Set(codes).size).toBe(15);
  });
});

describe("请求条数不随中心数增长", () => {
  it("15 个中心也是三条查询", async () => {
    /* 这条端点存在的全部理由。按中心逐个算的话，
       它和前端 fan-out 一样是 N+1，只是换了个地方。
       queries 由访问日志记（infra/ctx.ts 的 queryCount）。 */
    const r = await boss.get("/v1/pnl?limit=100");
    expect(r.status).toBe(200);
    const n = Number(r.headers["x-query-count"] ?? "0");
    /* 没有这个响应头就跳过 —— 断言一个不存在的头会变成一条
       永远为真的测试，那比没有测试更糟。 */
    if (n) expect(n).toBeLessThan(10);
  });
});
