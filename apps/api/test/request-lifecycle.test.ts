import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { Pool } from "pg";
import { RequestMiddleware } from "../src/infra/request.middleware.js";
import type { RequestCtx } from "../src/infra/ctx.js";

/* ════════════════════════════════════════════════════════════════════
   请求生命周期 —— 连接什么时候可以收回去。

   这一组不碰数据库：要验的是**时序**，不是 SQL。
   用假连接把「谁在什么时候调了 ROLLBACK / release」记下来就够了，
   而且这样它是确定的 —— 真发一个请求再中途掐掉，
   掐早了服务端还没开始处理，掐晚了它已经答完，
   两种都会让测试变成"有时候绿"。

   ── 这条规则是怎么来的 ────────────────────────────────────────────
   `res` 的 close 事件不只在响应发完时触发，**客户端中途断开也触发**。
   原来的兜底不分这两种情况，一律 ROLLBACK + release，于是：
   处理器还在跑，脚下的连接已经回滚并还进了连接池。
   之后它的每条 SQL 都打在一个没有 `app.account_id` 的连接上
   （SET LOCAL 随事务一起没了），而那条连接可能已经被下一个请求领走。

   Phase 7 的离线集成测试把它撞了出来：重放的请求发到一半上下文被关，
   服务端留下一条「违反行级安全策略」。审计写不进去还算响了 ——
   真正危险的是业务 UPDATE 在回滚后的自动提交模式下落了库，
   而它的审计条目没有。那正是「业务成功、轨迹丢了」。
   ════════════════════════════════════════════════════════════════════ */

interface Fake { queries: string[]; released: number }

function fakePool(): { pool: Pool; f: Fake } {
  const f: Fake = { queries: [], released: 0 };
  const client = {
    query: async (q: unknown) => { f.queries.push(String(q)); return { rows: [] }; },
    release: () => { f.released++; }
  };
  return { pool: { connect: async () => client } as unknown as Pool, f };
}

const tick = () => new Promise(r => setImmediate(r));

/** 跑一次中间件，返回它建好的上下文（就是处理器里 `ctx()` 拿到的那个）。 */
async function run(): Promise<{ f: Fake; res: EventEmitter; c: RequestCtx }> {
  const { pool, f } = fakePool();
  const res = new EventEmitter();
  const req = { headers: {} } as unknown as Parameters<RequestMiddleware["use"]>[0];
  await new RequestMiddleware(pool).use(
    req, res as unknown as Parameters<RequestMiddleware["use"]>[1], () => {});
  await tick();
  return { f, res, c: req.ctx! };
}

describe("请求生命周期：断线时连接归谁", () => {
  it("处理器还在跑时客户端断开 —— 连接不许被抽走", async () => {
    const { f, res, c } = await run();
    c.inFlight = true;                       // 拦截器已进入处理器
    f.queries.length = 0;                    // 只看 close 之后发生了什么

    res.emit("close");                       // ← 客户端断了
    await tick();

    expect(f.queries).not.toContain("ROLLBACK");
    expect(f.released).toBe(0);
    expect(c.finalized).toBe(false);         // 收尾仍然归拦截器
  });

  it("处理器压根没跑起来（Guard 抛异常）—— 连接必须收回去", async () => {
    const { f, res, c } = await run();
    expect(c.inFlight).toBe(false);
    f.queries.length = 0;

    res.emit("close");
    await tick();

    expect(f.queries).toContain("ROLLBACK");
    expect(f.released).toBe(1);
    expect(c.finalized).toBe(true);
  });

  it("正常答完之后的 close 是空转 —— 不会把别人的连接回滚掉", async () => {
    const { f, res, c } = await run();
    c.inFlight = false; c.finalized = true;  // 拦截器已经 COMMIT 并 release
    f.queries.length = 0;

    res.emit("close");
    await tick();

    expect(f.queries).toEqual([]);
    expect(f.released).toBe(0);              // 拦截器那次不算在这里
  });
});
