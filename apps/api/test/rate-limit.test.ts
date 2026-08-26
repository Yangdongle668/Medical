import { describe, it, expect } from "vitest";
import { FixedWindow } from "../src/infra/rate-limit.js";

/* ════════════════════════════════════════════════════════════════════
   限流器本体 —— 纯逻辑，不碰数据库也不起应用。

   用注入的 `now` 推进时间，不用真的 sleep：
   靠 sleep 的时间相关测试要么慢，要么在 CI 上偶尔红，
   而"偶尔红"会让人把它标成 skip。
   ════════════════════════════════════════════════════════════════════ */

describe("固定窗口计数", () => {
  it("窗口内放行到上限，第 N+1 次拦下", () => {
    const w = new FixedWindow(3, 60_000);
    expect(w.hit("a", 0).allowed).toBe(true);
    expect(w.hit("a", 1).allowed).toBe(true);
    expect(w.hit("a", 2).allowed).toBe(true);
    expect(w.hit("a", 3).allowed).toBe(false);
  });

  it("拦下时给得出还要等多久", () => {
    const w = new FixedWindow(1, 60_000);
    w.hit("a", 0);
    const v = w.hit("a", 10_000);
    expect(v.allowed).toBe(false);
    expect(v.retryAfterSec).toBe(50);          // 还剩 50 秒
  });

  it("窗口过去之后重新开始", () => {
    const w = new FixedWindow(1, 60_000);
    expect(w.hit("a", 0).allowed).toBe(true);
    expect(w.hit("a", 30_000).allowed).toBe(false);
    expect(w.hit("a", 60_000).allowed).toBe(true);
  });

  it("不同的 key 各算各的 —— 一个人被限流不该殃及别人", () => {
    const w = new FixedWindow(1, 60_000);
    expect(w.hit("a", 0).allowed).toBe(true);
    expect(w.hit("a", 1).allowed).toBe(false);
    expect(w.hit("b", 1).allowed).toBe(true);
  });
});

describe("key 的数量必须有上限", () => {
  it("超出容量后不会无限增长 —— 否则限流器自己就是内存泄漏", () => {
    /* 未认证的流量决定了 key 的多少。没有上限的话，
       "限流"反而给了攻击者一条撑爆内存的路。 */
    const w = new FixedWindow(5, 60_000, 100);
    for (let i = 0; i < 1000; i++) w.hit(`k${i}`, 0);
    expect(w.size).toBeLessThanOrEqual(100);
  });

  it("先清过期的，再谈丢弃", () => {
    const w = new FixedWindow(5, 1000, 10);
    for (let i = 0; i < 10; i++) w.hit(`old${i}`, 0);
    expect(w.size).toBe(10);
    /* 时间推过窗口之后再来一个：过期的应当被清掉，而不是丢掉新的 */
    w.hit("fresh", 5000);
    expect(w.size).toBeLessThan(10);
  });
});
