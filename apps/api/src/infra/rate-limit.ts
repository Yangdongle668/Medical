/* 限流 —— 固定窗口计数器。
 *
 *  契约里 `rate-limited` (429) 早就在 COMMON_ERRORS 里了：
 *  **每个端点都声明过自己可能返回 429，只是从来没有实现过。**
 *  这一版把它兑现在最需要的地方：那两个 @Public() 的登录端点。
 *
 *  ── 为什么放在进程内，而不是数据库 ──────────────────────────────
 *  数据库版本天然跨实例、也扛得住重启，但它有个要命的副作用：
 *  **未认证的流量就此获得了一条写库的路径**。限流本身成了打库的手段。
 *  auth 端点的量级很小，进程内的计数器足够挡住"随手刷"，
 *  而挡不住的那种（分布式）本来也不是单实例计数器的对手。
 *
 *  代价写在明面上：多实例部署时每个实例各算各的，
 *  实际配额 = limit × 实例数。要真正跨实例，得换共享存储 ——
 *  那是有了负载均衡之后再做的事，现在没有。
 */

export interface Verdict { allowed: boolean; retryAfterSec: number; remaining: number }

export class FixedWindow {
  /** key → [窗口起点, 本窗口内的次数] */
  private hits = new Map<string, [number, number]>();

  /**
   * @param limit     一个窗口内允许多少次
   * @param windowMs  窗口长度
   * @param capacity  最多记多少个 key。**必须有上限** ——
   *                  否则每来一个新 IP 就多一条记录，
   *                  限流器自己就成了内存泄漏。
   */
  constructor(
    readonly limit: number,
    readonly windowMs: number,
    readonly capacity = 10_000
  ) {}

  hit(key: string, now = Date.now()): Verdict {
    const cur = this.hits.get(key);
    if (!cur || now - cur[0] >= this.windowMs) {
      this.evictIfFull();
      this.hits.set(key, [now, 1]);
      return { allowed: true, retryAfterSec: 0, remaining: this.limit - 1 };
    }
    cur[1]++;
    if (cur[1] > this.limit)
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil((cur[0] + this.windowMs - now) / 1000)),
        remaining: 0
      };
    return { allowed: true, retryAfterSec: 0, remaining: this.limit - cur[1] };
  }

  /** 满了就先清过期的；还是满就丢最旧的那批（Map 保持插入序）。 */
  private evictIfFull(now = Date.now()) {
    if (this.hits.size < this.capacity) return;
    for (const [k, [start]] of this.hits)
      if (now - start >= this.windowMs) this.hits.delete(k);
    if (this.hits.size < this.capacity) return;
    let drop = Math.ceil(this.capacity / 10);
    for (const k of this.hits.keys()) {
      this.hits.delete(k);
      if (--drop <= 0) break;
    }
  }

  /** 仅供测试与诊断 */
  get size() { return this.hits.size; }
}
