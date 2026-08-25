import { Injectable, NestMiddleware, Inject } from "@nestjs/common";
import type { Request, Response, NextFunction } from "express";
import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { POOL } from "./db.js";
import { runInCtx, type RequestCtx } from "./ctx.js";
import { loadPrincipal } from "../auth/principal.loader.js";

/* ════════════════════════════════════════════════════════════════════
   每个请求：取连接 → BEGIN → 认证 → SET LOCAL app.account_id → 装载主体。

   为什么整个请求跑在一个事务里：
   RLS 靠 `SET LOCAL app.account_id` 生效，而 SET LOCAL 的作用域就是事务。
   用连接级 set_config 在连接池下是灾难 —— 一个请求设的身份会漏给下一个请求。

   为什么认证放在中间件而不是 Guard：
   Guard 在中间件之后运行，而装载主体本身就需要一个已经设好身份的连接。
   ════════════════════════════════════════════════════════════════════ */

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** 单条语句的上限。够慢查询跑完，又不至于让一次锁等待拖住一条连接一整天。 */
const STATEMENT_TIMEOUT_MS = Number(process.env["SITEDESK_STATEMENT_TIMEOUT_MS"] ?? 30_000);
/** 事务开着却没人动它的上限 —— 比语句上限宽一点，免得误伤慢查询之间的间隙。 */
const IDLE_TX_TIMEOUT_MS = Number(process.env["SITEDESK_IDLE_TX_TIMEOUT_MS"] ?? 60_000);

@Injectable()
export class RequestMiddleware implements NestMiddleware {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  async use(req: Request & { ctx?: RequestCtx }, res: Response, next: NextFunction) {
    const client = await this.pool.connect();
    const c: RequestCtx = {
      requestId: randomUUID(), client, principal: null,
      scope: { assignedSiteIds: new Set(), teamStudyIds: new Set() },
      operationId: null, finalized: false, inFlight: false
    };
    (req as Request & { requestId?: string }).requestId = c.requestId;
    req.ctx = c;

    /* 兜底：Guard 抛异常时拦截器不会运行，连接不能就这么泄漏出去。
       正常结束时也会走到这里，但那时 finalized 已经是 true，什么也不做。

       ── 为什么要看 inFlight ────────────────────────────────────────
       `res` 的 close 事件不只在响应发完时触发，**客户端中途断开也触发**。
       原来这里不分青红皂白就 ROLLBACK + release，于是断线时会发生：
       处理器还在跑，它脚下的连接已经回滚、并且**还回了连接池**。
       接下来它的每一条 SQL 都打在一个没有 `app.account_id` 的连接上
       （SET LOCAL 随事务一起没了），更糟的是那条连接可能已经被
       下一个请求领走 —— 两个请求在同一条连接上交错。

       这不是假想：Phase 7 的离线测试就把它撞出来了 ——
       重放的请求发到一半上下文被关掉，服务端留下一条
       「audit_entry 违反行级安全策略」。审计写不进去还算响了；
       真正危险的是业务 UPDATE 在回滚之后的**自动提交**模式下落了库，
       而它的审计条目没有 —— 那正是「业务成功、轨迹丢了」。

       所以：处理器在跑就什么都不做，交给拦截器按处理结果收尾。
       断线**不回滚**：请求已经被授权、活也是真做了，
       响应丢在回来的路上是常态 —— 客户端带着同一把幂等键重放，
       服务端认得它。这与 client 那边的假设是同一个假设。 */
    const release = () => {
      if (c.inFlight || c.finalized) return;
      c.finalized = true;
      client.query("ROLLBACK").catch(() => {}).finally(() => client.release());
    };
    res.on("close", release);

    try {
      await client.query("BEGIN");
      /* ── 两道超时，都是 SET LOCAL：作用域就是这个事务 ────────────────
         `statement_timeout`：单条语句跑太久就让它自己报错。
         关键在于**报错的是处理器正在 await 的那条查询** —— 于是处理器
         真的停下来，拦截器按失败收尾。
         用 rxjs 的 timeout() 做这件事是错的：它只让 observable 出错，
         底下那个 promise 照跑，于是又变成"连接已经还回去了，处理器还在用" ——
         正是本轮刚修掉的那个问题。取消一个跑着的请求，只能由**执行它的一方**动手。

         `idle_in_transaction_session_timeout`：事务开着却没人动它，
         说明处理器卡在了数据库之外（死循环、等一个永远不来的 promise）。
         由数据库把这条连接终结掉 —— 连接池会发现它坏了并丢弃，
         这才是"处理器卡死则连接泄漏"那条已知问题的收口。 */
      await client.query(
        `SET LOCAL statement_timeout = ${Number(STATEMENT_TIMEOUT_MS)}`);
      await client.query(
        `SET LOCAL idle_in_transaction_session_timeout = ${Number(IDLE_TX_TIMEOUT_MS)}`);

      const auth = req.headers.authorization;
      const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
      if (token) {
        const { rows } = await client.query<{ id: string | null }>(
          "SELECT app.resolve_session($1) AS id", [sha256(token)]);
        const accountId = rows[0]?.id ?? null;
        if (accountId) {
          await client.query("SELECT set_config('app.account_id', $1, true)", [accountId]);
          const loaded = await loadPrincipal(client, accountId);
          c.principal = loaded.principal;
          c.scope = loaded.scope;
        }
      }
      runInCtx(c, () => next());
    } catch (e) {
      release();
      next(e);
    }
  }
}
