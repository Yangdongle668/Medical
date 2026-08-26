import { AsyncLocalStorage } from "node:async_hooks";
import type { PoolClient } from "pg";
import type { Principal, ScopeContext } from "@sitedesk/policy";

/* ════════════════════════════════════════════════════════════════════
   请求上下文。

   为什么用 AsyncLocalStorage 而不是往每个函数传参：
   审计与脱敏需要在**每一层**都拿得到当前主体。靠传参，迟早有一条路径漏传，
   而漏传审计的那条路径就是核查时说不清的那条。
   ════════════════════════════════════════════════════════════════════ */

export interface RequestCtx {
  requestId: string;
  client: PoolClient;
  /** 未认证时为 null —— 只有 /v1/auth/* 允许在这种状态下继续 */
  principal: Principal | null;
  scope: ScopeContext;
  operationId: string | null;
  /** 事务是否已终结（提交或回滚），用于兜底释放 */
  finalized: boolean;
  /** 拦截器已进入处理器、尚未结束。
   *  客户端中途断开时靠它判断"现在能不能收连接" —— 处理器还在跑的话不能。 */
  inFlight: boolean;
  /** 这个请求发了多少条 SQL。N+1 不会自己响，所以先让它可数。 */
  queryCount: number;
  /** 这个请求**不开事务、不占连接**（目前只有存活/就绪探针）。
   *  存活探针一旦间接依赖数据库，一次数据库抖动就会让编排器重启全部实例。 */
  dbless: boolean;
}

const als = new AsyncLocalStorage<RequestCtx>();

export const runInCtx = <T>(ctx: RequestCtx, fn: () => T): T => als.run(ctx, fn);
/** 拿不到就返回 null。
 *  日志要用它 —— 日志会在请求之外被调用（启动、停机、连接池的 error 事件），
 *  在那里抛「有代码绕过了请求中间件」是错的：绕过的不是代码，是这条日志本来
 *  就不属于任何请求。业务代码仍然该用会抛的 ctx()。 */
export const ctxOrNull = (): RequestCtx | null => als.getStore() ?? null;
export const ctx = (): RequestCtx => {
  const c = als.getStore();
  if (!c) throw new Error("不在请求上下文中 —— 说明有代码绕过了请求中间件");
  return c;
};
export const principal = (): Principal => {
  const p = ctx().principal;
  if (!p) throw new Error("未认证的上下文 —— AuthGuard 应当已经拦下");
  return p;
};
