/* 限流 —— 两级固定窗口：进程内挡洪水，数据库定阈值。
 *
 *  契约里 `rate-limited` (429) 早就在 COMMON_ERRORS 里了：
 *  **每个端点都声明过自己可能返回 429，只是从来没有实现过。**
 *  Phase 8c 把它兑现在最需要的地方 —— 那两个 @Public() 的登录端点。
 *
 *  ── 那一版留下的代价，与它当时的理由 ──────────────────────────────
 *  当时选了进程内的 Map，理由写在明面上，而且是对的：
 *
 *    数据库版本天然跨实例、也扛得住重启，但它有个要命的副作用：
 *    **未认证的流量就此获得了一条写库的路径**。限流本身成了打库的手段。
 *
 *  代价也写在明面上：
 *
 *    多实例部署时每个实例各算各的，实际配额 = limit × 实例数。
 *
 *  也就是说，**扩容会静默放大限流阈值**。扩到 3 个副本，"10 分钟 5 次"
 *  变成 15 次 —— 配置没变、日志没变、监控没变，只有被刷的那个邮箱知道。
 *  这是那种"运行得好好的"故障：没有任何一处会报错。
 *
 *  ── 现在的做法：不反驳那个顾虑，把它挡在门外 ──────────────────────
 *  两级，分工不同：
 *
 *    ① **进程内**（FixedWindow）：每个请求都过。它挡住"随手刷"，
 *       更要紧的是 —— 它把下一级的写入量**限死了**：
 *       每实例每窗口每 key 最多 limit 次。于是"未认证流量获得写库路径"
 *       这件事仍然成立，但那条路径的宽度由限流器自己规定。
 *
 *    ② **数据库**（app.rate_limit_hit）：只有过了第一级的请求才走到这里。
 *       它是唯一说了算的那个 —— 阈值不再随副本数漂移。
 *
 *  ── 两个刻意的选择 ────────────────────────────────────────────────
 *  · **key 先哈希再送过去。** key 是登录名和登录令牌前缀；令牌前缀明文
 *    落库会推翻整套认证的前提（库里只有哈希，见迁移 0007）。
 *  · **共享那一级出错就退回本地判定，不是拒绝服务。** 库不可用时这两个
 *    端点本来也办不成事，把它们再变成 500 只是把一次故障放大。
 *    退回时打一条 warn —— 静默降级才是真正要避免的。
 */

import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { emit } from "./log.js";

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


/* ════════════════════════════════════════════════════════════════════
   第二级：跨实例共享的计数。
   ════════════════════════════════════════════════════════════════════ */

/** 共享计数的存储。抽成接口是为了能在测试里注入一个可控的实现 ——
 *  "多个实例共用一个预算"这件事，只有能造出第二个实例才验得了。 */
export interface SharedCounter {
  hit(bucket: string, limit: number, windowMs: number): Promise<Verdict>;
}

/** key → bucket。**哈希之后才出门。**
 *
 *  bucket 会落到数据库里，而 key 是登录名或登录令牌的前缀：
 *  前者是个人信息，后者是**秘密**。整套认证的前提是"库里只有哈希"，
 *  限流不该是那个例外。scope 混进去，是为了两个端点的同名 key 不撞车。 */
export const bucketOf = (scope: string, key: string) =>
  createHash("sha256").update(`${scope}:${key}`).digest("hex");

/** PostgreSQL 实现。 */
export class PgSharedCounter implements SharedCounter {
  constructor(private readonly pool: Pool) {}

  async hit(bucket: string, limit: number, windowMs: number): Promise<Verdict> {
    /* **走池子，不走请求那条连接。**
       请求的连接在一个事务里，而这两个端点里有一个（兑换）在令牌不对时
       会抛错 —— 抛错就回滚，计数跟着一起没了。也就是说：
       猜错的每一次都不算数，暴力猜令牌于是完全不受限。
       限流的计数必须活过业务的回滚。 */
    const { rows } = await this.pool.query<{
      allowed: boolean; retry_after_sec: number; remaining: number;
    }>("SELECT allowed, retry_after_sec, remaining FROM app.rate_limit_hit($1,$2,$3)",
      [bucket, limit, windowMs]);
    const r = rows[0]!;
    return { allowed: r.allowed, retryAfterSec: r.retry_after_sec, remaining: r.remaining };
  }
}

/** 两级限流器。用它，不要直接用 FixedWindow。 */
export class RateLimiter {
  private readonly local: FixedWindow;

  /**
   * @param scope   端点标识，进 bucket 以免两个端点的同名 key 撞车
   * @param limit   一个窗口内允许多少次
   * @param windowMs 窗口长度
   * @param shared  共享计数。null = 退回单实例语义（本地开发、或显式关掉）
   */
  constructor(
    readonly scope: string,
    readonly limit: number,
    readonly windowMs: number,
    private readonly shared: SharedCounter | null,
    private readonly warn: (msg: string, fields: Record<string, unknown>) => void =
      (msg, fields) => emit("warn", "rate-limit", msg, fields)
  ) {
    this.local = new FixedWindow(limit, windowMs);
  }

  async hit(key: string): Promise<Verdict> {
    /* 顺序不能反。先本地，是为了让**没过本地这一关**的请求根本碰不到数据库 ——
       那正是当初不敢把限流放进数据库的理由。 */
    const local = this.local.hit(key);
    if (!local.allowed || !this.shared) return local;
    try {
      return await this.shared.hit(bucketOf(this.scope, key), this.limit, this.windowMs);
    } catch (err) {
      /* 退回本地判定：单实例下它和共享判定一致，多实例下它偏松。
         偏松好过把登录端点直接打成 500 —— 但必须留下声音。 */
      this.warn("共享计数不可用，本次退回进程内判定（多实例下阈值会被放大）",
        { scope: this.scope, err: err instanceof Error ? err.message : String(err) });
      return local;
    }
  }

  /** 仅供测试与诊断 */
  get localSize() { return this.local.size; }
}
