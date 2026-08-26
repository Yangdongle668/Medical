import { describe, it, expect, beforeEach } from "vitest";
import { installGracefulShutdown, isDraining, _resetDraining } from "../src/infra/shutdown.js";

/* ════════════════════════════════════════════════════════════════════
   停机顺序 —— 先摘流量，再关门。

   在途请求会不会被拦腰砍断，已经在真产物上量过了（用一把表锁造了个
   8 秒的慢请求，SIGTERM 打在中途，那个请求照样拿到 200 和完整 body）。
   这一组验的是**顺序**：就绪必须在关闭之前就转红，
   否则负载均衡还没来得及摘掉这个实例，门就已经关了。
   ════════════════════════════════════════════════════════════════════ */

function harness(wait: number) {
  const events: string[] = [];
  const handlers: Record<string, () => void> = {};
  const app = { async close() { events.push("close"); } };
  installGracefulShutdown(app, {
    wait,
    log: () => {},
    exit: () => { events.push("exit"); },
    on: (sig, fn) => { handlers[sig] = fn; }
  });
  return { events, handlers, fire: (s: string) => handlers[s]!() };
}

beforeEach(() => _resetDraining());

describe("停机顺序", () => {
  it("默认不在排空状态", () => {
    expect(isDraining()).toBe(false);
  });

  it("SIGTERM 一到，就绪立刻转红 —— **在 close 之前**", async () => {
    const h = harness(50);
    h.fire("SIGTERM");
    /* 同步检查：此刻还没等到 wait 结束，close 也还没发生，
       但就绪必须已经是红的 —— 这正是给 LB 的那个窗口。 */
    expect(isDraining()).toBe(true);
    expect(h.events).toEqual([]);
    await new Promise(r => setTimeout(r, 120));
    expect(h.events).toEqual(["close", "exit"]);
  });

  it("SIGINT 同样处理（本地 Ctrl-C）", async () => {
    const h = harness(0);
    h.fire("SIGINT");
    expect(isDraining()).toBe(true);
    await new Promise(r => setTimeout(r, 20));
    expect(h.events).toEqual(["close", "exit"]);
  });

  it("连发两次信号只关一次", async () => {
    /* 编排器先 SIGTERM、见没退出再补一刀是常见做法。
       关两次会让 app.close() 撞在一起。 */
    const h = harness(0);
    h.fire("SIGTERM");
    h.fire("SIGTERM");
    await new Promise(r => setTimeout(r, 20));
    expect(h.events.filter(e => e === "close")).toHaveLength(1);
  });

  it("wait=0 时立刻关（本地开发）", async () => {
    const h = harness(0);
    h.fire("SIGTERM");
    await new Promise(r => setTimeout(r, 20));
    expect(h.events).toEqual(["close", "exit"]);
  });
});
