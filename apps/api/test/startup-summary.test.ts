import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { boot, resetDb, as, type Caller } from "./harness.js";

/* ════════════════════════════════════════════════════════════════════
   启动清单的汇总形态。

   和 listEnrollment / listPnl 是同一条规矩：**汇总与详情必须同口径**。
   这一条上最容易差的是「逾期」—— 当天到期算不算逾期。
   详情页在 JS 里判（daysBetween > 0），汇总在 SQL 里判
   （due_on < CURRENT_DATE）。两处写法不同，结论必须相同。
   ════════════════════════════════════════════════════════════════════ */

let app: INestApplication, boss: Caller, crc: Caller;
beforeAll(async () => {
  resetDb(); app = await boot();
  boss = await as(app, "lingyuan");
  crc = await as(app, "wutong");
}, 180_000);
afterAll(async () => { await app?.close(); });

describe("和 getStartupChecklist 同口径", () => {
  it("每个中心的四个计数逐一相等 —— 尤其是「逾期」", async () => {
    const list = await boss.get("/v1/startup-checklists?limit=100");
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.items.length).toBe(15);

    for (const row of list.body.items) {
      const one = await boss.get(`/v1/study-sites/${row.studySiteId}/startup-items`);
      expect(one.status).toBe(200);
      const { items: _items, ...summary } = one.body;
      expect(summary, `${row.siteCode} 两处对不上`).toEqual(row);
    }
  });

  it("汇总不下发逐项明细 —— 15 × 16 项这一页一项都不画", async () => {
    const r = await boss.get("/v1/startup-checklists?limit=100");
    for (const row of r.body.items) expect("items" in row).toBe(false);
  });
});

describe("行范围", () => {
  it("CRC 只看得到被指派的那几个", async () => {
    const r = await crc.get("/v1/startup-checklists?limit=100");
    const sites = await crc.get("/v1/study-sites?limit=100");
    expect(r.body.items.map((x: { siteCode: string }) => x.siteCode).sort())
      .toEqual(sites.body.items.map((x: { code: string }) => x.code).sort());
  });
});

describe("筛与分页", () => {
  it("blockedOnly 只留还有阻塞项没清的", async () => {
    const all = await boss.get("/v1/startup-checklists?limit=100");
    const blocked = await boss.get("/v1/startup-checklists?blockedOnly=true&limit=100");
    const expected = all.body.items.filter((x: { blockingOpen: number }) => x.blockingOpen > 0);
    expect(blocked.body.items.length).toBe(expected.length);
    for (const x of blocked.body.items) expect(x.blockingOpen).toBeGreaterThan(0);
  });

  it("blockedOnly=false 是 false", async () => {
    const off = await boss.get("/v1/startup-checklists?blockedOnly=false&limit=100");
    expect(off.body.items.length).toBe(15);
  });

  it("游标翻页不重不漏", async () => {
    const p1 = await boss.get("/v1/startup-checklists?limit=6");
    expect(p1.body.items.length).toBe(6);
    const p2 = await boss.get(`/v1/startup-checklists?limit=100&cursor=${p1.body.nextCursor}`);
    const codes = [...p1.body.items, ...p2.body.items]
      .map((x: { siteCode: string }) => x.siteCode);
    expect(new Set(codes).size).toBe(15);
  });
});

describe("一个中心一行", () => {
  it("16 项清单不会把它撑成 16 行", async () => {
    const r = await boss.get("/v1/startup-checklists?limit=100");
    const codes = r.body.items.map((x: { siteCode: string }) => x.siteCode);
    expect(new Set(codes).size).toBe(codes.length);

    /* 计数确实聚合出来了。**不能断言"每个中心都 > 1"** ——
       种子里只有还在启动期的三个中心有清单行，
       十二个已入组的中心一行都没有（它们早就过了启动期）。
       断言"每个都有"会红在一件完全正常的事上。 */
    const withItems = r.body.items.filter((x: { total: number }) => x.total > 1);
    expect(withItems.length, "一个有清单的中心都没有？种子变了").toBeGreaterThan(0);
  });

  it("没有清单行的中心也在列表里，不是被 JOIN 丢掉", async () => {
    /* LEFT JOIN 写成 JOIN 的话，这十二个中心会整个消失 ——
       而"这个中心没有启动清单"恰恰是页面上要说的一件事
       （它不是卡住了，是早就过了启动期）。 */
    const r = await boss.get("/v1/startup-checklists?limit=100");
    const empty = r.body.items.filter((x: { total: number }) => x.total === 0);
    expect(empty.length).toBeGreaterThan(0);
    for (const x of empty) {
      expect(x.done).toBe(0);
      expect(x.blockingOpen).toBe(0);
      expect(x.overdue).toBe(0);
    }
  });
});
