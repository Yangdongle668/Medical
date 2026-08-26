import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { Observable, catchError, concatMap, from, throwError } from "rxjs";
import { ctx, runInCtx, type RequestCtx } from "./ctx.js";
import { emit } from "./log.js";

/* ════════════════════════════════════════════════════════════════════
   事务收尾：处理成功则提交，抛错则回滚。
   中间件里的 res.on("close") 是最后一道兜底（且只在处理器没跑起来时动手）。

   ── 为什么必须**等** COMMIT 回来再让响应出去 ──────────────────────
   原来这里写的是 `tap({ next: () => void done(true) })` —— 发了就不管。
   于是 COMMIT 还在路上，Nest 已经把响应序列化发走了。两个后果：

   ① **读不到自己刚写的东西。** 客户端拿到 201，紧接着发一个 GET，
      那个 GET 从连接池里取到**另一条连接**，而刚才那笔还没提交 ——
      读回来的是旧值。写成功了、读不到，这在日志里什么也看不出来。

      这正是 api 测试那条"对负载敏感"的老毛病：
      `POST :edc-entered` 断言 200 通过，紧接着的 GET 读回 `pending`；
      404、交接看不到中心，都是同一个形状。**它从来不是负载，是这一行。**
      平时提交快过一次网络往返，所以大多数时候看起来是对的 ——
      "大多数时候是对的"正是这类 bug 最难被认领的原因。

   ② **提交失败被吞掉。** COMMIT 抛错的话，那个 promise 没人接，
      而客户端已经收到成功了。业务上这是最坏的一种：
      人以为录进去了，系统里没有。

   所以改成 concatMap：**提交完成，值才继续往下走**。
   慢一个 COMMIT 的往返，换"响应说成功就是真成功"。
   ════════════════════════════════════════════════════════════════════ */
@Injectable()
export class TxInterceptor implements NestInterceptor {
  intercept(_: ExecutionContext, next: CallHandler): Observable<unknown> {
    const c = ctx();
    /* 不开事务的路由（健康探针）没有连接可提交 —— 直接放行。 */
    if (c.dbless) return next.handle();
    /* 从这里到 done() 之间，这条连接归处理器所有 ——
       中间件的兜底释放看到 inFlight 就不会来抢。 */
    c.inFlight = true;
    const done = async (ok: boolean) => {
      c.inFlight = false;
      if (c.finalized) return;
      c.finalized = true;
      try { await c.client.query(ok ? "COMMIT" : "ROLLBACK"); }
      finally { c.client.release(); }
      /* 提交成功之后才做的事（目前只有：把登录链接真的发出去）。
         **不 await** —— 这些是对外的动作，慢的是网络，
         让响应等它等于把一次 SMTP 往返算进接口耗时。
         回滚时一件都不做：外部世界不认识回滚。 */
      if (ok) runAfterCommit(c);
    };
    return next.handle().pipe(
      /* 提交失败就让它抛出去 —— 客户端该知道这笔没落库 */
      concatMap(value => from(done(true)).pipe(concatMap(() => [value]))),
      catchError(err => from(done(false)).pipe(concatMap(() => throwError(() => err))))
    );
  }
}

/** 跑提交后的挂钩。**它们自己出错不能影响任何已经发出去的响应** ——
 *  所以这里只记日志，且带上请求上下文（不带的话，这几行在日志里
 *  跟任何一个请求都对不上号，正是最需要对上号的那几行）。 */
function runAfterCommit(c: RequestCtx): void {
  const hooks = c.afterCommit;
  if (!hooks.length) return;
  c.afterCommit = [];
  void (async () => {
    for (const h of hooks)
      try { await h(); }
      catch (err) {
        runInCtx(c, () => emit("error", "after-commit", "提交后的动作失败",
          { err: err instanceof Error ? err.message : String(err) }));
      }
  })();
}
