/* 停机的顺序 —— 先摘流量，再关门。
 *
 *  已经实测过的部分：SIGTERM 之后 Nest 会**把在途请求做完**才关
 *  （用一把表锁造了个 8 秒的慢请求，SIGTERM 打在中途，那个请求
 *  照样拿到了 200 和完整 body）。所以"请求被拦腰砍断"不是问题。
 *
 *  ── 还差的那一步 ────────────────────────────────────────────────
 *  问题在**新来的**请求：监听一关，负载均衡还在转发的那些连接
 *  会直接撞上 connection refused。LB 通常要一两个探测周期才会
 *  把实例摘掉，而进程等不了那么久 —— 于是每次发布都会漏掉一小撮请求。
 *
 *  正确的顺序是：
 *    ① 收到 SIGTERM → 就绪探针立刻开始返回 503（存活仍然 200：
 *       这个进程没坏，只是不该再接新活了）
 *    ② 等一小会儿，给 LB 一个探测周期把自己摘掉
 *    ③ 再 app.close()：停止监听 + 把在途请求做完 + 关连接池
 *
 *  ② 的长度必须比 LB 的探测间隔长。默认 5 秒，按部署环境调。
 *  设成 0 就是"立刻关"，本地开发用得上。
 */

import { emit } from "./log.js";

let draining = false;

/** 就绪探针据此立刻转 503。存活探针**不看**这个标志。 */
export const isDraining = () => draining;

export interface Closable { close(): Promise<unknown> }

/**
 * @param app   Nest 应用
 * @param log   打日志（注入便于测试）
 * @param wait  开始拒绝新流量之后、真正关闭之前等多久
 */
export interface ShutdownOpts {
  log?: (msg: string) => void;
  /** 开始拒绝新流量之后、真正关闭之前等多久 */
  wait?: number;
  /** 注入便于测试 —— 否则测试会把自己也退掉 */
  exit?: (code: number) => void;
  on?: (sig: string, fn: () => void) => void;
}

export function installGracefulShutdown(app: Closable, o: ShutdownOpts = {}): void {
  const log = o.log ?? ((m: string) => emit("info", "shutdown", m));
  const wait = o.wait ?? Number(process.env["SITEDESK_DRAIN_MS"] ?? 5000);
  const exit = o.exit ?? ((c: number) => process.exit(c));
  const on = o.on ?? ((sig: string, fn: () => void) => { process.on(sig as "SIGTERM", fn); });
  let closing = false;
  const onSignal = (sig: string) => async () => {
    if (closing) return;          // 连发两次信号不该触发两次关闭
    closing = true;
    draining = true;
    log(`收到 ${sig}：就绪探针开始返回 503，${wait}ms 后关闭。`);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    log("停止监听，等在途请求做完…");
    await app.close();
    log("已关闭。");
    exit(0);
  };
  on("SIGTERM", onSignal("SIGTERM"));
  on("SIGINT", onSignal("SIGINT"));
}

/** 仅供测试重置。 */
export const _resetDraining = () => { draining = false; };
