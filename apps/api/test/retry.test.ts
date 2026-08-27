import { describe, it, expect, vi } from "vitest";
import {
  isTransient, withRetry, loginLinkPlan, noticePlan, type RetryPlan
} from "../src/infra/retry.js";

/* 投递重试（欠账 G6）。
   在此之前一次失败就只剩一条日志 —— 而最常见的失败是一次性的：
   网关正在重启、DNS 抖了一下、短信厂商限流了三秒。 */

const plan = (over: Partial<RetryPlan> = {}): RetryPlan => ({
  attempts: 3, backoffMs: [1, 1], deadline: Date.now() + 60_000, ...over
});
const noSleep = () => Promise.resolve();

describe("哪些失败值得再试一次", () => {
  it("SMTP 4xx 值得，5xx 不值得 —— 后者是确定的拒绝", () => {
    /* 重试三次只是把同一条错误日志推迟三十秒，
       同时让人以为系统还在努力。 */
    expect(isTransient(new Error("SMTP 期望 250，收到：451 4.3.0 try again later"))).toBe(true);
    expect(isTransient(new Error("SMTP 期望 250，收到：550 5.1.1 no such user"))).toBe(false);
    expect(isTransient(new Error("SMTP 期望 250，收到：554 5.7.1 relay denied"))).toBe(false);
  });

  it("网关 429 与 5xx 值得，其余 4xx 不值得 —— 那是我们把请求发错了", () => {
    expect(isTransient(new Error("短信网关返回 429 Too Many Requests"))).toBe(true);
    expect(isTransient(new Error("短信网关返回 503 Service Unavailable"))).toBe(true);
    expect(isTransient(new Error("短信网关返回 400 Bad Request"))).toBe(false);
    expect(isTransient(new Error("短信网关返回 401 Unauthorized"))).toBe(false);
  });

  it("认证失败与非法地址不值得 —— 重试一万次也是同一个结果", () => {
    expect(isTransient(new Error("SMTP 服务器没有提供 PLAIN / LOGIN 认证，无法登录"))).toBe(false);
    expect(isTransient(new Error("收件人 含有换行符，拒绝发送"))).toBe(false);
  });

  it("连接层面的失败值得 —— 那正是这套重试要盖住的那种", () => {
    expect(isTransient(new Error("connect ECONNREFUSED 10.0.0.5:25"))).toBe(true);
    expect(isTransient(new Error("SMTP 等待 250 应答超时（10000ms）"))).toBe(true);
    expect(isTransient(new Error("getaddrinfo EAI_AGAIN smtp.example.com"))).toBe(true);
  });
});

describe("重试本身", () => {
  it("第一次就成功 → 只跑一次", async () => {
    const run = vi.fn().mockResolvedValue("ok");
    expect(await withRetry(run, plan(), () => {}, noSleep)).toBe("ok");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("抖一下就好了 → 第二次成功", async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
      .mockResolvedValue("ok");
    expect(await withRetry(run, plan(), () => {}, noSleep)).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("**确定的拒绝不重试** —— 一次就抛", async () => {
    const run = vi.fn().mockRejectedValue(
      new Error("SMTP 期望 250，收到：550 5.1.1 no such user"));
    await expect(withRetry(run, plan(), () => {}, noSleep)).rejects.toThrow("550");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("试满次数仍然失败 → **照样抛**：重试是多试几次，不是吞掉错误", async () => {
    const run = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));
    await expect(withRetry(run, plan(), () => {}, noSleep)).rejects.toThrow("ECONNREFUSED");
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("过了截止时刻就不再试 —— 送到一条已经过期的链接比彻底失败更糟", async () => {
    /* 用户点开它，看到"链接无效"，然后不知道该怪谁。 */
    const run = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));
    await expect(withRetry(run, plan({ deadline: Date.now() - 1 }), () => {}, noSleep))
      .rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("逐次回调，且说得出还会不会再试", async () => {
    /* 一条"第 2 次也失败了"的日志，比一条"发送失败"更能说明
       是网关在抖还是配置错了 —— 而那两件事的处置完全不同。 */
    const seen: { n: number; willRetry: boolean }[] = [];
    const run = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));
    await expect(withRetry(run, plan(), a => seen.push({ n: a.n, willRetry: a.willRetry }),
      noSleep)).rejects.toThrow();
    expect(seen).toEqual([
      { n: 1, willRetry: true }, { n: 2, willRetry: true }, { n: 3, willRetry: false }
    ]);
  });

  it("退避是真的等了 —— 不等的话三次重试挤在同一毫秒里，等于只试了一次", async () => {
    const waited: number[] = [];
    const run = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));
    await expect(withRetry(run, plan({ backoffMs: [7, 13] }), () => {},
      ms => { waited.push(ms); return Promise.resolve(); })).rejects.toThrow();
    expect(waited).toEqual([7, 13]);
  });
});

describe("两种计划的窗口", () => {
  it("登录链接的重试窗口不超过有效期的三分之一", () => {
    /* 剩下的时间是留给收信人的 —— 他还得点开它。 */
    const p = loginLinkPlan(15);
    expect(p.deadline - Date.now()).toBeLessThanOrEqual(15 * 60_000 / 3 + 50);
    expect(p.deadline - Date.now()).toBeGreaterThan(60_000);
  });

  it("有效期极短时仍留一个下限 —— 否则等于没有重试", () => {
    const p = loginLinkPlan(0);
    expect(p.deadline - Date.now()).toBeGreaterThanOrEqual(9_000);
  });

  it("业务通知没有有效期，但也不该无限期占着钩子", () => {
    const p = noticePlan();
    expect(p.deadline - Date.now()).toBeLessThanOrEqual(60_050);
  });
});
