import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { boot, resetDb, as, type Caller } from "./harness.js";

/* ════════════════════════════════════════════════════════════════════
   入组漏斗的列表形态。

   它存在的理由是**不让前端做 fan-out**：「入组进度」和「筛选漏斗」
   两页要的都是全部中心的同一组数，让前端逐个去打 getSiteFunnel，
   那是把 N+1 从服务端搬到浏览器上 —— 15 个中心时看不出来，
   1500 个时那一页永远打不开。

   所以这一组里最要紧的两条是：
     · 逐条与 getSiteFunnel 的结果**一模一样**（不然它就是第二套口径）；
     · 请求条数不随中心数增长。
   ════════════════════════════════════════════════════════════════════ */

let app: INestApplication, boss: Caller, crc: Caller;
beforeAll(async () => {
  resetDb(); app = await boot();
  boss = await as(app, "lingyuan");
  crc = await as(app, "wutong");
}, 180_000);
afterAll(async () => { await app?.close(); });

describe("和 getSiteFunnel 是同一套口径", () => {
  it("每一个中心逐字段相等 —— 两套口径迟早长出分歧，而分歧只有出事时才看得见", async () => {
    const list = await boss.get("/v1/enrollment?limit=100");
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.items.length).toBe(15);

    for (const row of list.body.items) {
      const one = await boss.get(`/v1/study-sites/${row.studySiteId}/funnel`);
      expect(one.status).toBe(200);
      expect(one.body, `${row.siteCode} 两处对不上`).toEqual(row);
    }
  });
});

describe("行范围照常生效", () => {
  it("CRC 只看得到被指派的那几个", async () => {
    const r = await crc.get("/v1/enrollment?limit=100");
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(0);
    expect(r.body.items.length).toBeLessThan(15);
    const sites = await crc.get("/v1/study-sites?limit=100");
    expect(r.body.items.map((x: { siteCode: string }) => x.siteCode).sort())
      .toEqual(sites.body.items.map((x: { code: string }) => x.code).sort());
  });
});

describe("不需要 subjRead —— 它只返回计数", () => {
  it("没有受试者明细权限的人也拿得到", async () => {
    /* QA 没有 subjRead（迁移 0026 的目录里 qa 只有 closeQA / raiseQ）。
       漏斗只回答"多少人"，不回答"哪些人"—— I10 说的就是这条界线。 */
    const qa = await as(app, "weilan");
    const r = await qa.get("/v1/enrollment?limit=100");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.items.length).toBe(15);
    /* 而且响应里确实一个受试者标识都没有 */
    expect(JSON.stringify(r.body)).not.toMatch(/screeningNo|"S-\d/);
  });
});

describe("筛与分页", () => {
  it("behindOnly 只留没达成合同例数的", async () => {
    const all = await boss.get("/v1/enrollment?limit=100");
    const behind = await boss.get("/v1/enrollment?behindOnly=true&limit=100");
    expect(behind.status).toBe(200);
    const expected = all.body.items
      .filter((x: { enrolled: number; contracted: number }) => x.enrolled < x.contracted);
    expect(behind.body.items.length).toBe(expected.length);
    for (const x of behind.body.items) expect(x.enrolled).toBeLessThan(x.contracted);
  });

  it("behindOnly=false 是 false，不是 true", async () => {
    /* z.coerce.boolean() 会把 "false" 变成 true —— 全仓换成 QueryBool 之后
       每个新查询参数都该顺手钉一下，否则下一个人照着旁边那行写就又回去了。 */
    const off = await boss.get("/v1/enrollment?behindOnly=false&limit=100");
    expect(off.body.items.length).toBe(15);
  });

  it("游标翻页不重不漏", async () => {
    const p1 = await boss.get("/v1/enrollment?limit=6");
    expect(p1.body.items.length).toBe(6);
    expect(p1.body.nextCursor).toBeTruthy();
    const p2 = await boss.get(`/v1/enrollment?limit=100&cursor=${p1.body.nextCursor}`);
    const codes = [...p1.body.items, ...p2.body.items]
      .map((x: { siteCode: string }) => x.siteCode);
    expect(new Set(codes).size).toBe(15);
  });
});

describe("一个中心一行 —— 拆解不该把分页撑破", () => {
  it("有多种筛败原因的中心，仍然只占一行", async () => {
    const r = await boss.get("/v1/enrollment?limit=100");
    const codes = r.body.items.map((x: { siteCode: string }) => x.siteCode);
    expect(new Set(codes).size).toBe(codes.length);
    /* 而拆解确实带回来了 —— 把它们 join 进主查询会让每个中心多出几行，
       分页游标就没法算了，所以拆解另走一条聚合。 */
    const withBreak = r.body.items.filter(
      (x: { screenFailBreakdown: unknown[] }) => x.screenFailBreakdown.length > 0);
    expect(withBreak.length, "演示数据里应当有中心记了筛败原因").toBeGreaterThan(0);
  });
});
