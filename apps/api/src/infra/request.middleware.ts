import { Injectable, NestMiddleware, Inject } from "@nestjs/common";
import type { Request, Response, NextFunction } from "express";
import { createHash, randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
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

/** 一个请求发多少条 SQL 算可疑。
 *
 *  N+1 的特征不是"慢"，是**条数随数据量线性增长** —— 在开发库上
 *  15 个中心跑得飞快，上线之后 1500 个中心就是 1500 条查询。
 *  它不会自己报错，也不会在任何测试里变红，所以这里给它装一个响铃：
 *  超过阈值就打一条 warn，并把 operationId 一起写出来。 */
const QUERY_WARN_AT = Number(process.env["SITEDESK_QUERY_WARN_AT"] ?? 30);
/** 打开后每个响应带 X-Query-Count —— 测试据此断言"这个端点不许超过 N 条"。
 *
 *  **按次读取，不做成模块级常量。** 常量在 import 那一刻就定死了，
 *  而测试是在 `beforeAll` 里设这个变量的 —— 那时模块早就加载完了。
 *  于是那条测试只有在命令行上预先设了变量时才绿，
 *  跑 `npm test` 就变成 `expected NaN to be +0`：
 *  **它一直是靠外部条件通过的，不是靠被测代码。** */
const stats = () => !!process.env["SITEDESK_QUERY_STATS"];
const LOG = new Logger("QueryCount");

/** 不开事务的路由（存活 / 就绪探针）。就绪探针要用库，
 *  但它自己从池子里取连接、自己还（见 HealthController）——
 *  和请求事务是两回事。 */
const DBLESS = new Set(["/v1/health", "/v1/health/ready"]);

/** dbless 请求拿到的"连接"：碰一下就炸。
 *  给 null 的话，误用会得到一句 "Cannot read properties of null"，
 *  指不出是哪里错了；这样至少它自己说得清。 */
function noDb(): PoolClient {
  const boom = () => {
    throw new Error(
      "这条路由被声明为不开事务（DBLESS），不该使用请求事务的连接。" +
      "确实需要数据库的话，像就绪探针那样自己从池子里取。");
  };
  return new Proxy({} as PoolClient, { get: boom, apply: boom });
}

/** 只数数的代理。除 query 外一律转发给真连接（并绑定 this）。 */
function countingClient(raw: PoolClient, c: RequestCtx): PoolClient {
  return new Proxy(raw, {
    get(t, prop, recv) {
      if (prop === "query")
        return (...args: unknown[]) => {
          c.queryCount++;
          return (t.query as (...a: unknown[]) => unknown)(...args);
        };
      const v = Reflect.get(t, prop, recv);
      return typeof v === "function" ? v.bind(t) : v;
    }
  }) as PoolClient;
}

/** 单条语句的上限。够慢查询跑完，又不至于让一次锁等待拖住一条连接一整天。 */
const STATEMENT_TIMEOUT_MS = Number(process.env["SITEDESK_STATEMENT_TIMEOUT_MS"] ?? 30_000);
/** 事务开着却没人动它的上限 —— 比语句上限宽一点，免得误伤慢查询之间的间隙。 */
const IDLE_TX_TIMEOUT_MS = Number(process.env["SITEDESK_IDLE_TX_TIMEOUT_MS"] ?? 60_000);

@Injectable()
export class RequestMiddleware implements NestMiddleware {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  async use(req: Request & { ctx?: RequestCtx }, res: Response, next: NextFunction) {
    /* ── 健康探针：建上下文，但**不取连接、不开事务** ────────────────
       不能干脆把中间件从这些路由上摘掉：全局守卫与拦截器都依赖
       这个上下文存在（`ctx()` 会直接抛「有代码绕过了请求中间件」——
       第一版就是这么撞上的，而那句话说得完全正确）。
       要避免的是**依赖数据库**，不是避免上下文。 */
    /* 用 originalUrl，不用 req.path：中间件经 MiddlewareConsumer 挂载之后，
       `req.path` 是相对挂载点的那一段，匹配不上完整路径 ——
       第一版就是这么漏过去的，探针照样连了库（库停掉时 ECONNREFUSED）。
       originalUrl 永远是客户端请求的原样，去掉查询串即可。 */
    /* 统计钩子挂在最前面，**dbless 的路由也要带上** ——
       "存活探针发了 0 条 SQL" 正是要断言的那件事，
       没有这个头就没法把"不碰库"写成一条测试。 */
    const withStats = (c: RequestCtx) => {
      if (!stats()) return;
      const writeHead = res.writeHead.bind(res);
      res.writeHead = ((...args: Parameters<typeof writeHead>) => {
        res.setHeader("X-Query-Count", String(c.queryCount));
        return writeHead(...args);
      }) as typeof res.writeHead;
    };

    if (DBLESS.has(req.originalUrl.split("?")[0]!.replace(/\/+$/, ""))) {
      const c: RequestCtx = {
        requestId: randomUUID(), client: noDb(), principal: null,
        scope: { assignedSiteIds: new Set(), teamStudyIds: new Set() },
        operationId: null, finalized: true, inFlight: false,
        queryCount: 0, dbless: true
      };
      (req as Request & { requestId?: string }).requestId = c.requestId;
      req.ctx = c;
      withStats(c);
      runInCtx(c, () => next());
      return;
    }

    const client = await this.pool.connect();
    const c: RequestCtx = {
      requestId: randomUUID(), client, principal: null,
      scope: { assignedSiteIds: new Set(), teamStudyIds: new Set() },
      operationId: null, finalized: false, inFlight: false,
      queryCount: 0, dbless: false
    };
    /* 业务代码拿到的是一个**代理**：除了数数，什么都不做。
       为什么不直接改 client.query —— 连接会还回池子里给下一个请求用，
       打过补丁的方法会跟着一起回去，把这一个请求的计数器泄漏给下一个。
       代理只活在这个请求的上下文里，池子从头到尾看到的都是原始连接。 */
    c.client = countingClient(client, c);
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
      /* 响应头必须在**头发出去之前**写，所以挂在 writeHead 上。
         第一版挂的是 res.on("finish") —— 那时头早发完了，
         setHeader 抛 ERR_HTTP_HEADERS_SENT，而且抛在一个没人接的回调里。 */
      withStats(c);
      /* 告警可以晚一点：日志不受"头已经发了"的限制。 */
      res.on("finish", () => {
        if (c.queryCount > QUERY_WARN_AT)
          LOG.warn(`${c.operationId ?? req.path} 发了 ${c.queryCount} 条 SQL ` +
            `（阈值 ${QUERY_WARN_AT}）—— 这通常意味着循环里在查库（N+1）`);
      });

      runInCtx(c, () => next());
    } catch (e) {
      release();
      next(e);
    }
  }
}
