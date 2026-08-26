import { describe, it, expect } from "vitest";
import { FixedWindow, RateLimiter, bucketOf } from "../src/infra/rate-limit.js";
import type { SharedCounter, Verdict } from "../src/infra/rate-limit.js";

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

/* ════════════════════════════════════════════════════════════════════
   两级限流 —— 进程内挡洪水，共享计数定阈值。

   这一组要证明的是那个**静默**的问题真的被修掉了：
   限流阈值原来会随副本数被放大，而没有任何一处会说出来。

   共享那一级用一个假实现注入，因为"多个实例共用一个预算"这件事
   只有能造出第二个实例才验得了 —— 真数据库那一侧由
   db/test/rate-limit.test.js 单独验。
   ════════════════════════════════════════════════════════════════════ */

/** 一个进程外的计数器：几个 RateLimiter 共用它，就相当于几个副本共用一个库。 */
class FakeShared implements SharedCounter {
  readonly seen: string[] = [];
  private counts = new Map<string, number>();
  hit(bucket: string, limit: number): Promise<Verdict> {
    this.seen.push(bucket);
    const n = (this.counts.get(bucket) ?? 0) + 1;
    this.counts.set(bucket, n);
    return Promise.resolve(n <= limit
      ? { allowed: true, retryAfterSec: 0, remaining: limit - n }
      : { allowed: false, retryAfterSec: 42, remaining: 0 });
  }
}

class DeadShared implements SharedCounter {
  hit(): Promise<Verdict> { return Promise.reject(new Error("connection refused")); }
}

describe("多副本下阈值不再被放大", () => {
  it("三个实例共用一个预算 —— 加起来到上限就拦", async () => {
    /* 这正是原来那条已知问题：三个副本 = 三份配额，
       "10 分钟 5 次"变成 15 次，而配置、日志、监控全都没有变化。 */
    const shared = new FakeShared();
    const 副本 = [1, 2, 3].map(() => new RateLimiter("auth:magic-link", 3, 60_000, shared));

    const 判定 = [];
    for (let i = 0; i < 4; i++) 判定.push((await 副本[i % 3]!.hit("lingyuan")).allowed);
    expect(判定).toEqual([true, true, true, false]);
  });

  it("单实例下和原来一模一样", async () => {
    const w = new RateLimiter("auth:magic-link", 2, 60_000, new FakeShared());
    expect((await w.hit("a")).allowed).toBe(true);
    expect((await w.hit("a")).allowed).toBe(true);
    expect((await w.hit("a")).allowed).toBe(false);
  });

  it("不同的 key 各算各的", async () => {
    const shared = new FakeShared();
    const w = new RateLimiter("auth:magic-link", 1, 60_000, shared);
    expect((await w.hit("a")).allowed).toBe(true);
    expect((await w.hit("b")).allowed).toBe(true);
  });

  it("两个端点的同名 key 不撞车 —— scope 进了 bucket", async () => {
    const shared = new FakeShared();
    const link = new RateLimiter("auth:magic-link", 1, 60_000, shared);
    const redeem = new RateLimiter("auth:redeem", 1, 60_000, shared);
    expect((await link.hit("同一个值")).allowed).toBe(true);
    expect((await redeem.hit("同一个值")).allowed).toBe(true);
    expect(new Set(shared.seen).size).toBe(2);
  });
});

describe("送出去的是哈希，不是登录名和令牌", () => {
  it("bucket 里看不出原文", async () => {
    /* 令牌前缀明文落库会推翻整套认证的前提（库里只有哈希，见迁移 0007）。
       登录名同理：那是个人信息，而限流表的留存周期没人管。 */
    const shared = new FakeShared();
    const w = new RateLimiter("auth:redeem", 5, 60_000, shared);
    await w.hit("Ab3xToKeNpReFiX");
    expect(shared.seen[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(shared.seen[0]).not.toContain("Ab3xToKeNpReFiX");
  });

  it("同一个 key 每次算出同一个 bucket，否则计数根本累加不起来", () => {
    expect(bucketOf("s", "k")).toBe(bucketOf("s", "k"));
    expect(bucketOf("s", "k")).not.toBe(bucketOf("s2", "k"));
  });
});

describe("本地那一级仍然是第一道", () => {
  it("**没过本地就不碰数据库** —— 那正是当初不敢把限流放进库的理由", async () => {
    const shared = new FakeShared();
    const w = new RateLimiter("auth:magic-link", 2, 60_000, shared);
    for (let i = 0; i < 50; i++) await w.hit("刷子");
    /* 50 次请求，最多只有 limit 次能到达共享计数：
       未认证流量的写库路径宽度，由限流器自己规定。 */
    expect(shared.seen.length).toBeLessThanOrEqual(2);
  });

  it("共享计数挂了就退回本地判定，并且留下声音", async () => {
    /* 库不可用时这两个端点本来也办不成事，把它们再变成 500 只是放大故障。
       但静默降级是不行的：多副本下退回本地就是阈值被放大。 */
    const warned: string[] = [];
    const w = new RateLimiter("auth:magic-link", 2, 60_000, new DeadShared(),
      (m) => warned.push(m));
    expect((await w.hit("a")).allowed).toBe(true);
    expect((await w.hit("a")).allowed).toBe(true);
    expect((await w.hit("a")).allowed).toBe(false);
    expect(warned.join()).toMatch(/退回进程内判定/);
  });

  it("没有共享计数时就是单实例语义", async () => {
    const w = new RateLimiter("auth:magic-link", 1, 60_000, null);
    expect((await w.hit("a")).allowed).toBe(true);
    expect((await w.hit("a")).allowed).toBe(false);
  });
});
