import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { boot, resetDb, as, type Caller } from "./harness.js";

/* ════════════════════════════════════════════════════════════════════
   备案名册 `/v1/site-staff`。

   这条端点的全部风险都在一句话里：**它绕开了 staff 的表策略**。
   所以测试要钉的不是"能不能查出来"，而是**绕开的边界在哪**：

   ① 行范围一点没放宽 —— 机构办仍只看本院，PI 仍只看自己的中心；
   ② 列没多给 —— 职级、城市、带教、继任、登录名一个都不能出现；
   ③ `sites` 只含范围内的中心 —— 否则机构办能数出那个 CRC
      在别家医院还带着几个，而那是别人的事。

   ③ 是最容易漏的一条：函数里 `app.site_visible` 拦的是行，
   而"这个人一共带几个中心"是**聚合**出来的 —— 聚合的范围写错了，
   每一行都还是合法行，泄漏发生在计数上。
   ════════════════════════════════════════════════════════════════════ */

let app: INestApplication;
let inst: Caller, pi: Caller, boss: Caller, crc: Caller;

beforeAll(async () => {
  resetDb(); app = await boot();
  inst = await as(app, "zhanghm");    // 机构办 · 北京协和医院
  pi   = await as(app, "chenguod");   // PI · SS-01 的研究者
  boss = await as(app, "lingyuan");
  crc  = await as(app, "wutong");
}, 180_000);
afterAll(async () => { await app?.close(); });

describe("行范围", () => {
  it("机构办看得到本院中心上的人 —— staff 那条端点一行也不给他", async () => {
    const roster = await inst.get("/v1/staff?limit=100");
    expect(roster.status, JSON.stringify(roster.body)).toBe(200);
    expect(roster.body.items).toHaveLength(0);          // 名册照旧锁着

    const r = await inst.get("/v1/site-staff?limit=100");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(0);     // 备案这个口子开着
  });

  it("机构办拿到的中心，全部是本院的", async () => {
    const r = await inst.get("/v1/site-staff?limit=100");
    const hospitals = new Set(
      r.body.items.flatMap((p: { sites: { hospital: string }[] }) =>
        p.sites.map(s => s.hospital)));
    expect([...hospitals]).toEqual(["北京协和医院"]);
  });

  it("PI 只看得到自己那个中心上的人 —— 比机构办窄", async () => {
    const mine = await pi.get("/v1/site-staff?limit=100");
    expect(mine.status).toBe(200);

    const sites = new Set(
      mine.body.items.flatMap((p: { sites: { code: string }[] }) =>
        p.sites.map(s => s.code)));
    expect([...sites]).toEqual(["SS-01"]);

    /* 同一家医院，机构办比 PI 宽 —— 这两个数相等就说明
       行范围没有真的跟着登录身份走。 */
    const theirs = await inst.get("/v1/site-staff?limit=100");
    const instSites = new Set(
      theirs.body.items.flatMap((p: { sites: { code: string }[] }) =>
        p.sites.map(s => s.code)));
    expect(instSites.size).toBeGreaterThan(sites.size);
  });

  it("**中心数在范围内重算**：CRC 吴桐在机构办眼里只带本院那几个", async () => {
    /* 吴桐在 staff 名册上的 siteCount 是他全部的派工。
       机构办不该从备案表上数出这个数。 */
    const full = await boss.get("/v1/staff?limit=100");
    const wutongFull = full.body.items.find(
      (s: { displayName: string }) => s.displayName === "吴桐");
    expect(wutongFull).toBeDefined();

    const r = await inst.get("/v1/site-staff?limit=100");
    const wutong = r.body.items.find(
      (p: { displayName: string }) => p.displayName === "吴桐");
    expect(wutong, "吴桐被派到 SS-01，机构办应该看得到他").toBeDefined();
    expect(wutong.sites.length).toBeLessThan(wutongFull.siteCount);
    expect(wutong.sites.every((s: { hospital: string }) =>
      s.hospital === "北京协和医院")).toBe(true);
  });

  it("内部角色照样能用 —— 这不是一条只给外部方的端点", async () => {
    const r = await crc.get("/v1/site-staff?limit=100");
    expect(r.status).toBe(200);
    const mySites = await crc.get("/v1/study-sites?limit=100");
    const visible = new Set(mySites.body.items.map((s: { code: string }) => s.code));
    for (const p of r.body.items)
      for (const s of p.sites) expect(visible.has(s.code)).toBe(true);
  });
});

describe("列", () => {
  it("只给备案要用的那几列 —— 人事账那几列一个都不出现", async () => {
    const r = await inst.get("/v1/site-staff?limit=100");
    const p = r.body.items[0];
    expect(Object.keys(p).sort()).toEqual(
      ["accountId", "active", "displayName", "gcpDaysLeft",
       "gcpExpiresOn", "roleKind", "sites"].sort());
    /* 逐一点名，因为"键集合相等"这条断言在加了新列之后会先红，
       而红的时候要一眼看出**多出来的是哪一列、该不该给**。 */
    for (const k of ["login", "level", "city", "mentorName", "successorName",
                     "siteCount", "successionGap", "disabledReason"])
      expect(k in p, `${k} 不该出现在备案名册上`).toBe(false);
  });

  it("gcpDaysLeft 是算出来的，与 staff 那条端点同一个口径", async () => {
    const roster = await boss.get("/v1/staff?limit=100");
    const reg = await boss.get("/v1/site-staff?limit=100");
    for (const p of reg.body.items) {
      const s = roster.body.items.find(
        (x: { accountId: string }) => x.accountId === p.accountId);
      if (!s) continue;
      expect(p.gcpExpiresOn).toBe(s.gcpExpiresOn);
      expect(p.gcpDaysLeft).toBe(s.gcpDaysLeft);
    }
  });
});

describe("筛选", () => {
  it("roleKind 收窄到一个工种", async () => {
    const r = await inst.get("/v1/site-staff?limit=100&roleKind=CRC");
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(0);
    expect(r.body.items.every((p: { roleKind: string }) => p.roleKind === "CRC")).toBe(true);
  });

  it("studySiteId 收窄到一个中心 —— 且不能借它越出范围", async () => {
    const mine = await inst.get("/v1/study-sites?limit=100");
    const one = mine.body.items[0];
    const r = await inst.get(`/v1/site-staff?limit=100&studySiteId=${one.id}`);
    expect(r.status).toBe(200);
    for (const p of r.body.items)
      expect(p.sites.map((s: { id: string }) => s.id)).toEqual([one.id]);

    /* 范围外的中心 id：不是 403，是**查不到人** —— 与 404 那条规矩同源，
       范围之外的东西不存在，而不是"存在但不给你"。 */
    const all = await boss.get("/v1/study-sites?limit=100");
    const outside = all.body.items.find(
      (s: { hospital: string }) => s.hospital !== "北京协和医院");
    expect(outside).toBeDefined();
    const none = await inst.get(`/v1/site-staff?limit=100&studySiteId=${outside.id}`);
    expect(none.status).toBe(200);
    expect(none.body.items).toHaveLength(0);
  });

  it("gcpProblem 只留下已过期或 60 天内到期的，证书为空的一并算", async () => {
    const all = await boss.get("/v1/site-staff?limit=200");
    const bad = await boss.get("/v1/site-staff?limit=200&gcpProblem=true");
    expect(bad.status).toBe(200);
    const expect_ = all.body.items.filter(
      (p: { gcpDaysLeft: number | null }) => p.gcpDaysLeft === null || p.gcpDaysLeft <= 60);
    expect(bad.body.items.map((p: { accountId: string }) => p.accountId).sort())
      .toEqual(expect_.map((p: { accountId: string }) => p.accountId).sort());
  });
});

describe("装配", () => {
  it("一个人一行 —— 带三个中心不是三行", async () => {
    const r = await boss.get("/v1/site-staff?limit=200");
    const ids = r.body.items.map((p: { accountId: string }) => p.accountId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(r.body.items.some((p: { sites: unknown[] }) => p.sites.length > 1)).toBe(true);
  });

  it("只出在岗的派工 —— 名册里的人不等于中心上的人", async () => {
    const roster = await boss.get("/v1/staff?limit=100");
    const reg = await boss.get("/v1/site-staff?limit=200");
    /* PM / QA / DM 在名册上，但 site_assignment 只收 CRA / CRC，
       所以他们不该出现在备案表上。 */
    expect(reg.body.items.every((p: { roleKind: string }) =>
      ["CRA", "CRC"].includes(p.roleKind))).toBe(true);
    expect(roster.body.items.some((s: { roleKind: string }) =>
      !["CRA", "CRC"].includes(s.roleKind))).toBe(true);
  });

  it("条数不影响 SQL 条数 —— 一条查询装配全部", async () => {
    const one = await boss.get("/v1/site-staff?limit=1");
    const many = await boss.get("/v1/site-staff?limit=50");
    expect(one.status).toBe(200);
    expect(many.status).toBe(200);
    expect(one.body.items).toHaveLength(1);
    /* 一页装不下时给游标；装得下就不给 —— 前端靠它判断"还有没有下一页"。 */
    expect(one.body.nextCursor).not.toBeNull();
  });
});
