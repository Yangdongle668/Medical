/* ════════════════════════════════════════════════════════════════════
   投递重试（欠账 G6）。

   在此之前：一次投递失败就只剩一条日志。而**最常见的失败是一次性的**——
   SMTP 网关正在重启、DNS 抖了一下、短信厂商限流了三秒。
   那种失败下，用户看到的是"申请了但没收到"，而系统看起来一切正常。

   ── 为什么这里不是一个持久队列 ────────────────────────────────────
   原来的记录写着"真要重试得有队列与去重，那是另一件事的规模"。
   那句话是对的 —— 但它论证的是**不做持久队列**，不是**不做重试**。

   进程内的有界重试要便宜得多，而且它盖住的正是绝大多数真实故障：
   一次性抖动。进程挂了那几条会丢，但那种情况下用户本来就该重新申请。

   ── 两条边界，缺一条重试就变成有害的 ──────────────────────────────
   ① **只重试暂时性失败。** SMTP 5xx（"查无此人"、"拒绝转发"）
      和网关 4xx 是**确定的拒绝**：重试三次只是把同一条错误日志
      推迟三十秒，同时让人以为系统还在努力。
   ② **不能超过内容自己的有效期。** 登录链接 15 分钟就过期了 ——
      在第 20 分钟成功投递一条已经失效的链接，比彻底失败更糟：
      用户点开它，看到"链接无效"，然后不知道该怪谁。
   ════════════════════════════════════════════════════════════════════ */

/** 这次失败值不值得再试一次。
 *
 *  判据只看错误文本，因为两条通道抛的都是 `Error`：
 *  SMTP 客户端把应答原文带进了 message（"SMTP 期望 250，收到：451 ..."），
 *  webhook 通道带的是 HTTP 状态。**看得见的信息只有这些**，
 *  而按文本判比按类型判诚实 —— 至少它写明了自己在猜什么。 */
export function isTransient(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);

  /* SMTP：4xx 是"暂时不行，晚点再来"，5xx 是"别再来了"。RFC 5321 §4.2.1。 */
  const smtp = /收到：\s*(\d{3})/.exec(m);
  if (smtp) return smtp[1]!.startsWith("4");

  /* 短信网关：429 与 5xx 值得再试；其余 4xx 是我们把请求发错了。 */
  const http = /返回 (\d{3})/.exec(m);
  if (http) {
    const code = Number(http[1]);
    return code === 429 || code >= 500;
  }

  /* 认证失败、地址里有换行 —— 这些重试一万次也是同一个结果。 */
  if (/认证|无法登录|换行符/.test(m)) return false;

  /* 剩下的是连接层面的：超时、ECONNREFUSED、DNS 解析不出来。
     这一类**几乎总是**一次性的，正是这套重试要盖住的那种。 */
  return true;
}

export interface RetryPlan {
  /** 最多尝试几次（含第一次） */
  attempts: number;
  /** 每次退避的毫秒数。长度应当是 attempts - 1。 */
  backoffMs: readonly number[];
  /** 绝对截止时刻（epoch ms）。到点就不再试 —— 见上面的边界②。 */
  deadline: number;
}

/** 登录链接：窗口就是链接自己的有效期，且要留出用户点开的时间。
 *  取 TTL 的三分之一：15 分钟的链接最多重试到第 5 分钟，
 *  剩下 10 分钟是留给收信人的。 */
export const loginLinkPlan = (ttlMin: number): RetryPlan => ({
  attempts: 3,
  backoffMs: [1_000, 5_000],
  deadline: Date.now() + Math.max(10_000, (ttlMin * 60_000) / 3)
});

/** 业务通知没有有效期，但也不该无限期地占着一个 afterCommit 钩子。 */
export const noticePlan = (): RetryPlan => ({
  attempts: 3,
  backoffMs: [2_000, 8_000],
  deadline: Date.now() + 60_000
});

export interface Attempt {
  /** 第几次（从 1 起） */
  n: number;
  err: unknown;
  /** 还会不会再试 */
  willRetry: boolean;
  /** 下一次等多久 */
  waitMs: number;
}

/**
 * 按计划重试。**失败仍然会抛**：重试是"多试几次"，不是"吞掉错误"。
 *
 * `onAttempt` 让调用方逐次记日志 —— 一条"第 2 次也失败了"的日志，
 * 比一条"发送失败"更能说明是网关在抖还是配置错了。
 */
export async function withRetry<T>(
  run: () => Promise<T>,
  plan: RetryPlan,
  onAttempt: (a: Attempt) => void = () => {},
  sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))
): Promise<T> {
  let last: unknown;
  for (let n = 1; n <= plan.attempts; n++) {
    try { return await run(); }
    catch (err) {
      last = err;
      const wait = plan.backoffMs[n - 1] ?? 0;
      /* 三个条件缺一不可：还有次数、这次失败值得重试、退避完还没过截止时刻。
         最后一条是**算出来的**而不是事后判的：在第 20 分钟发一条
         第 15 分钟就过期的链接，比彻底失败更糟。 */
      const willRetry = n < plan.attempts
        && isTransient(err)
        && Date.now() + wait < plan.deadline;
      onAttempt({ n, err, willRetry, waitMs: wait });
      if (!willRetry) break;
      await sleep(wait);
    }
  }
  throw last;
}
