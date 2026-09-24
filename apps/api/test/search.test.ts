import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { boot, resetDb, as, type Caller } from "./harness.js";

/* 全局搜索（GET /v1/search）。与待办一样直接调 service，所以先钉"没给多"：
   行范围、动作、列 —— 然后才是"找得到"。 */

let app: INestApplication;
let boss: Caller, crc: Caller, qa: Caller;

beforeAll(async () => {
  resetDb(); app = await boot();
  boss = await as(app, "lingyuan");
  crc  = await as(app, "wutong");
  qa   = await as(app, "weilan");
}, 180_000);
afterAll(async () => { await app?.close(); });

interface Hit { type: string; id: string; label: string; screeningNo?: string; studySiteId: string }
const find = async (c: Caller, q: string) => {
  const r = await c.get(`/v1/search?q=${encodeURIComponent(q)}`);
  expect(r.status).toBe(200);
  return r.body.items as Hit[];
};

describe("全局搜索", () => {
  it("中心按代号找得到", async () => {
    const hits = await find(boss, "SS-07");
    expect(hits.some(h => h.type === "site" && h.label.startsWith("SS-07"))).toBe(true);
  });

  it("CRC 按筛选号找得到自己中心的受试者，而且只有自己范围里的", async () => {
    const own = (await crc.get("/v1/subjects?limit=1")).body.items[0];
    const hits = await find(crc, own.screeningNo);
    expect(hits.some(h => h.type === "subject" && h.id === own.id)).toBe(true);
    const mine = new Set((await crc.get("/v1/study-sites?limit=200")).body.items
      .map((s: { id: string }) => s.id));
    for (const h of hits) expect(mine.has(h.studySiteId)).toBe(true);
  });

  it("没有受试者列权限的（经营层）不搜受试者 —— 命中数本身就会泄露「有这个筛选号」", async () => {
    const no = (await crc.get("/v1/subjects?limit=1")).body.items[0].screeningNo;
    expect((await find(boss, no)).filter(h => h.type === "subject")).toEqual([]);
  });

  it("没有 subjRead 的（QA）也不搜受试者，而且不是 403", async () => {
    const no = (await crc.get("/v1/subjects?limit=1")).body.items[0].screeningNo;
    expect((await find(qa, no)).filter(h => h.type === "subject")).toEqual([]);
  });

  it("一个字不搜（422）—— 否则每按一个键都是一次受试者名册访问", async () => {
    expect((await crc.get("/v1/search?q=S")).status).toBe(422);
  });
});
