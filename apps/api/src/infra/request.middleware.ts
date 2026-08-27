import { Injectable, NestMiddleware, Inject } from "@nestjs/common";
import type { Request, Response, NextFunction } from "express";
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { POOL } from "./db.js";
import { runInCtx, type RequestCtx } from "./ctx.js";
import { emit } from "./log.js";
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
const QUERY_WARN_AT = () => Number(process.env["SITEDESK_QUERY_WARN_AT"] ?? 30);
/** 打开后每个响应带 X-Query-Count —— 测试据此断言"这个端点不许超过 N 条"。
 *
 *  **按次读取，不做成模块级常量。** 常量在 import 那一刻就定死了，
 *  而测试是在 `beforeAll` 里设这个变量的 —— 那时模块早就加载完了。
 *  于是那条测试只有在命令行上预先设了变量时才绿，
 *  跑 `npm test` 就变成 `expected NaN to be +0`：
 *  **它一直是靠外部条件通过的，不是靠被测代码。** */
const stats = () => !!process.env["SITEDESK_QUERY_STATS"];

/** 不开事务的路由（存活 / 就绪探针）。就绪探针要用库，
 *  但它自己从池子里取连接、自己还（见 HealthController）——
 *  和请求事务是两回事。 */
const DBLESS = new Set(["/v1/health", "/v1/health/ready"]);

/** 超时之后留给处理器的"连接"：碰一下就炸，并说清它为什么炸。
 *  给它一条真连接（或 null）都不行 —— 前者会让一个已经被放弃的请求
 *  写进别人的事务，后者只会得到一句 "Cannot read properties of null"。 */
function timedOutClient(): PoolClient {
  const boom = () => {
    throw new Error(
      "这个请求已经超过截止时间被收尾，它的数据库连接已经归还。" +
      "处理器还在往下跑说明它卡在了数据库之外 —— 看这条之前的 timeout 日志。");
  };
  return new Proxy({} as PoolClient, { get: boom, apply: boom });
}

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

/** 外来的请求 ID 长什么样才认。
 *
 *  认它，是为了让前端那一跳和 API 这一跳落在**同一条时间线**上 ——
 *  否则同一个请求在两份日志里是两个不相干的号，拼不起来。
 *
 *  校验必须严：这个值会进日志、也会回到响应体的 traceId 里。
 *  长度封顶挡住"用一个 1MB 的头把日志撑爆"，字符集封顶挡住把
 *  控制字符塞进日志（JSON 那边会转义，但 pretty 那边不会）。
 *  形状不对就当没有，重新发一个 —— 绝不半信半疑地用。 */
const TRACE_RE = /^[A-Za-z0-9_-]{8,64}$/;
const traceIdOf = (req: Request): string => {
  const h = req.headers["x-request-id"];
  const v = Array.isArray(h) ? h[0] : h;
  return typeof v === "string" && TRACE_RE.test(v) ? v : randomUUID();
};

/** 单条语句的上限。够慢查询跑完，又不至于让一次锁等待拖住一条连接一整天。 */
const STATEMENT_TIMEOUT_MS = Number(process.env["SITEDESK_STATEMENT_TIMEOUT_MS"] ?? 30_000);
/** 事务开着却没人动它的上限 —— 比语句上限宽一点，免得误伤慢查询之间的间隙。 */
const IDLE_TX_TIMEOUT_MS = Number(process.env["SITEDESK_IDLE_TX_TIMEOUT_MS"] ?? 60_000);
/** 整个请求的截止时间。**必须比语句上限长** —— 卡在数据库上的请求应当由
 *  数据库自己那条超时先报出来（它的报错指得到是哪条 SQL），
 *  这一道只兜住"卡在数据库之外"的那种：处理器 await 了一个永远不来的 promise。
 *
 *  没有这一道的时候，那条连接要等 idle_in_transaction 的 60 秒才回得来，
 *  而客户端那头是无限期地挂着。
 *
 *  **按次读取，不做成模块级常量。** 常量在 import 那一刻就定死了，
 *  而测试是在 beforeAll 里设这个变量的 —— 那时模块早就加载完了，
 *  于是那条测试只有在命令行上预先设了变量时才绿。这个坑
 *  SITEDESK_QUERY_STATS 已经踩过一次，不必再踩第二次。 */
const requestTimeoutMs = () => {
  const raw = process.env["SITEDESK_REQUEST_TIMEOUT_MS"]?.trim();
  if (!raw) return 45_000;
  return /^\d+$/.test(raw) ? Number(raw) : 45_000;
};

@Injectable()
export class RequestMiddleware implements NestMiddleware {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  async use(req: Request & { ctx?: RequestCtx }, res: Response, next: NextFunction) {
    const t0 = process.hrtime.bigint();
    /* 路径去掉查询串再进日志：搜索词、姓名片段都可能在 query 里，
       而日志的留存周期通常比业务数据长得多。低基数的那把键是 operationId。 */
    const path = req.originalUrl.split("?")[0]!;
    const requestId = traceIdOf(req);
    /* 回显出去：浏览器 devtools 里就能读到这个号，报障时直接可用。 */
    res.setHeader("X-Request-Id", requestId);

    /* ── 每个请求一行访问日志 ──────────────────────────────────────
       挂 close 而不是 finish：finish 只在响应**发完**时触发，
       客户端中途断开就一条日志都没有 —— 而"请求打到一半没了"
       恰恰是最需要留痕的那一类。close 两种情况都触发，
       用 writableEnded 区分，断开的那条带上 aborted。

       用 runInCtx 包一层，是因为 close 回调**有时**在请求的
       AsyncLocalStorage 之外跑。量过（真 server + 真 fetch）：
         · 正常收尾 → store 还在（close 发自 res.end() 的续体，
           那时仍在 als.run 的作用域内）
         · 客户端断开 → store 没了（事件来自 socket 拆除，
           跟处理器不在一条异步链上）
       也就是说不包的话，**只有断开的那些请求会丢 requestId** ——
       而那恰恰是最需要把它捞出来的一类。这种"大部分情况下能用"的
       依赖不值得留着，显式带上下文就完事了。 */
    const accessLog = (c: RequestCtx) => {
      res.on("close", () => {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        runInCtx(c, () => {
          emit(c.dbless ? "debug" : "info", "access", `${req.method} ${path}`, {
            method: req.method, path, status: res.statusCode,
            ms: Math.round(ms * 10) / 10, queries: c.queryCount,
            ...(res.writableEnded ? {} : { aborted: true })
          });
          const warnAt = QUERY_WARN_AT();
          if (c.queryCount > warnAt)
            emit("warn", "QueryCount",
              `一个请求发了 ${c.queryCount} 条 SQL（阈值 ${warnAt}）` +
              "—— 这通常意味着循环里在查库（N+1）",
              { queries: c.queryCount, warnAt });
        });
      });
    };

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
        requestId, client: noDb(), principal: null,
        scope: { assignedSiteIds: new Set(), teamStudyIds: new Set() },
        operationId: null, finalized: true, inFlight: false,
        queryCount: 0, dbless: true, afterCommit: []
      };
      (req as Request & { requestId?: string }).requestId = c.requestId;
      req.ctx = c;
      withStats(c);
      accessLog(c);
      runInCtx(c, () => next());
      return;
    }

    const client = await this.pool.connect();
    const c: RequestCtx = {
      requestId, client, principal: null,
      scope: { assignedSiteIds: new Set(), teamStudyIds: new Set() },
      operationId: null, finalized: false, inFlight: false,
      queryCount: 0, dbless: false, afterCommit: []
    };
    /* 业务代码拿到的是一个**代理**：除了数数，什么都不做。
       为什么不直接改 client.query —— 连接会还回池子里给下一个请求用，
       打过补丁的方法会跟着一起回去，把这一个请求的计数器泄漏给下一个。
       代理只活在这个请求的上下文里，池子从头到尾看到的都是原始连接。 */
    c.client = countingClient(client, c);
    (req as Request & { requestId?: string }).requestId = c.requestId;
    req.ctx = c;
    accessLog(c);

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

    /* ── 截止时间：处理器卡住时，连接不该陪着一起卡 ────────────────
       Phase 7 学到的那一课在这里仍然成立：**不能把连接从一个还在跑的
       处理器脚下抽走**，否则它接下来的每一条 SQL 都打在一条已经还给
       池子、可能已被下一个请求领走的连接上。

       所以这里不是"抢回来"，是**先下毒再收走**：把 c.client 换成一个
       碰一下就抛的代理。卡住的处理器如果哪天醒过来，它的下一条查询
       会当场炸掉并写进日志 —— 而不是安静地污染别人的事务。 */
    const timeoutMs = requestTimeoutMs();
    const deadline = timeoutMs > 0 ? setTimeout(() => {
      if (c.finalized) return;
      c.finalized = true;
      c.inFlight = false;
      c.client = timedOutClient();
      runInCtx(c, () => emit("error", "timeout",
        `请求超过 ${timeoutMs}ms 未完成，已收回连接并回 504`,
        { method: req.method, path }));
      client.query("ROLLBACK").catch(() => {}).finally(() => client.release());
      if (!res.headersSent)
        res.status(504).type("application/problem+json").json({
          type: "https://sitedesk.dev/problems/request-timeout",
          title: "请求处理超时", status: 504, code: "request-timeout",
          detail: "服务端在截止时间内没有完成这个请求，已经放弃。可以重试。",
          ...(c.requestId ? { traceId: c.requestId } : {})
        });
      else res.destroy();
    }, timeoutMs) : null;
    deadline?.unref?.();
    res.on("close", () => { if (deadline) clearTimeout(deadline); });

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

      runInCtx(c, () => next());
    } catch (e) {
      release();
      next(e);
    }
  }
}
