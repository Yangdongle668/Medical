import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { boot, resetDb, as, type Caller } from "./harness.js";
import { randomUUID } from "node:crypto";
import { POOL } from "../src/infra/db.js";
import type { Pool } from "pg";

/* ════════════════════════════════════════════════════════════════════
   并发实测（欠账 C2：「没有并发负载实测（连接池上限、锁等待）」）。

   ── 这里量的**不是**吞吐 ──────────────────────────────────────────
   耗时依赖机器，放进 CI 必然变成 flaky —— 与执行计划守卫同一条道理
   （见 db/scripts/check-plans.mjs 开头）。

   量的是**并发下的正确性**，而那正是会真的出事的部分：
     · 请求数超过连接池上限时，是排队还是 500；
     · 一阵并发之后，连接有没有还回去（泄漏是慢慢发作的）；
     · 同一个幂等键并发打进来，会不会做两次；
     · 同一行并发改，会不会死锁或者两个都成功。
   ════════════════════════════════════════════════════════════════════ */

let app: INestApplication, boss: Caller, crc: Caller;
/** 连接池上限（infra/db.ts）。下面**故意**打超过它。 */
const POOL_MAX = 10;

/* 并发请求走**一个真的端口**，不走 supertest。
   supertest 每次调用都新起一个临时监听器 —— 三十个并发就是三十个
   监听器，那时 ECONNRESET 量的是它，不是这个系统。 */
let origin = "", bossToken = "", crcToken = "";

beforeAll(async () => {
  resetDb(); app = await boot();
  boss = await as(app, "lingyuan");
  crc = await as(app, "wutong");
  bossToken = boss.token; crcToken = crc.token;
  await app.listen(0, "127.0.0.1");
  const addr = app.getHttpServer().address() as { port: number };
  origin = `http://127.0.0.1:${addr.port}`;
}, 120_000);
afterAll(async () => { await app?.close(); });

const pool = () => app.get<Pool>(POOL);
const K = () => ({ "Idempotency-Key": randomUUID() });

/** 打一发并发请求。返回状态码，不返回 body —— 这里量的是并发行为。 */
const hit = (path: string, token = bossToken) =>
  fetch(origin + path, { headers: { Authorization: `Bearer ${token}` } })
    .then(r => r.status);

describe("并发：连接池与锁", () => {
  it("并发数是连接池上限的三倍 —— 应当排队，而不是报错", async () => {
    /* 池子满了之后 pg 会把请求排进队列。如果哪天有人给 connect()
       加了超时或者 `if (busy) throw`，这条用例会当场变红 ——
       而在生产上，那种改动的表现是"高峰期偶发 500"，查不出来源。 */
    const rs = await Promise.all(
      Array.from({ length: POOL_MAX * 3 }, () => hit("/v1/study-sites?limit=20")));
    expect(rs).toEqual(Array(POOL_MAX * 3).fill(200));
  });

  it("一阵并发之后连接全部还回去了 —— 泄漏是慢慢发作的", async () => {
    await Promise.all(Array.from({ length: POOL_MAX * 2 },
      () => hit("/v1/subjects?limit=10")));
    /* 事件循环转一圈，让 release 落地 */
    await new Promise(r => setTimeout(r, 100));
    const p = pool();
    expect(p.idleCount + p.waitingCount, "有连接没还回去").toBeGreaterThan(0);
    expect(p.waitingCount, "还有请求在等连接").toBe(0);
    /* totalCount 不该超过上限 —— 超了说明有人绕过池子自己连 */
    expect(p.totalCount).toBeLessThanOrEqual(POOL_MAX);
  });

  it("**同一个幂等键并发打进来，只做一次**", async () => {
    /* 这是离线重放最真实的形状：CRC 恢复网络的那一刻，
       发件箱里同一条命令可能被重发多次，而它们几乎同时到达。 */
    const s = await siteWithOpenItem();
    const key = { "Idempotency-Key": randomUUID() };
    const rs = await Promise.all(Array.from({ length: 5 },
      () => boss.post(`/v1/startup-items/${s.itemId}:complete`, { note: "并发重放" }, key)));

    /* 允许的结果只有两种：成功，或者"这个键正在处理中"。
       **不允许**的是两次都真的执行了。 */
    const ok = rs.filter(r => r.status === 201);
    expect(ok.length, `响应：${rs.map(r => r.status).join(",")}`).toBeGreaterThan(0);
    for (const r of rs)
      expect([201, 409, 422], `意外的状态 ${r.status}`).toContain(r.status);

    /* 真正的判据在库里：这一项只能被完成一次，而且只有一个完成时间。 */
    const after = await boss.get(`/v1/study-sites/${s.siteId}/startup-items`);
    const done = after.body.items.filter((i: { id: string; doneAt: string | null }) =>
      i.id === s.itemId && i.doneAt);
    expect(done.length).toBe(1);
  });

  it("同一行并发改 —— 第二个拿到冲突，不是死锁也不是两个都成功", async () => {
    const s = await siteWithOpenItem();
    const rs = await Promise.all([
      boss.post(`/v1/startup-items/${s.itemId}:complete`, { note: "甲" }, K()),
      boss.post(`/v1/startup-items/${s.itemId}:complete`, { note: "乙" }, K())
    ]);
    const ok = rs.filter(r => r.status === 201);
    const conflict = rs.filter(r => r.status === 409);
    expect(ok.length, `响应：${rs.map(r => r.status).join(",")}`).toBe(1);
    expect(conflict.length).toBe(1);
  });

  it("并发写审计不会互相挡住 —— 审计表只增不改，本来就不该有锁竞争", async () => {
    /* 每次读受试者明细都写一条审计（I10）。如果那条写入拿了什么
       宽范围的锁，整个系统的读路径都会互相排队。 */
    const rs = await Promise.all(Array.from({ length: POOL_MAX * 2 },
      () => hit("/v1/subjects?limit=5", crcToken)));
    expect(rs.every(s => s === 200)).toBe(true);
  });
});

/** 找一个还有未完成清单项的中心 */
async function siteWithOpenItem(): Promise<{ siteId: string; itemId: string }> {
  const sites = (await boss.get("/v1/study-sites?limit=200")).body.items;
  for (const s of sites) {
    const cl = await boss.get(`/v1/study-sites/${s.id}/startup-items`);
    const open = cl.body.items?.find((i: { doneAt: string | null }) => !i.doneAt);
    if (open) return { siteId: s.id, itemId: open.id };
  }
  throw new Error("种子里没有未完成的启动清单项 —— 这一组用例需要一个");
}
