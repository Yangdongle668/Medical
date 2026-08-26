import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import { POOL } from "./db.js";
import { PgSharedCounter, RateLimiter } from "./rate-limit.js";
import { emit } from "./log.js";

/* ── 限流：两个 @Public() 入口的配额 ────────────────────────────────
   契约里 rate-limited(429) 早就在 COMMON_ERRORS 里了 —— 每个端点都
   声明过自己可能返回 429。这里是它真正被兑现的地方。

   **按 login 计数，而不是按 IP。**
   这是刻意的：IP 是攻击者能换的东西（代理池、XFF 伪造，尤其在
   `trust proxy` 没配对的时候），login 是他换不掉的 —— 他要刷的就是
   那一个邮箱。挡住"同一个账号被反复发链接"，正是这个端点真正要保护的。
   IP 维度留给网关去做，那一层才有可信的来源地址。

   兑换端点按令牌前缀计数：暴力猜令牌时每次的令牌都不同，
   所以这里限的是"同一把令牌被反复试"，配合一次性消费已经够。

   ── 为什么是一个 provider，不是两个模块级常量 ────────────────────
   共享计数要用连接池，而池子是注入进来的。写成模块级常量的话，
   它在 import 那一刻就得决定自己有没有池子可用 —— 于是只能是"没有"。 */

/** 环境变量里的正整数。
 *
 *  不能写 `Number(env ?? 5)`：`SITEDESK_LINK_LIMIT=五` 会变成 NaN，
 *  而 `次数 > NaN` 恒为 false —— **限流就此完全失效，且没有任何声音**。
 *  和 SITEDESK_DRAIN_MS 那个 NaN 是同一个形状的坑（见 infra/drain.ts）。 */
function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    emit("warn", "rate-limit",
      `${name}=${JSON.stringify(raw)} 不是正整数，改用默认值 ${fallback}`, { name });
    return fallback;
  }
  return Number(raw);
}

/** 两个入口共用的窗口长度。 */
const WINDOW_MS = 10 * 60_000;

@Injectable()
export class RateLimitService {
  readonly link: RateLimiter;
  readonly redeem: RateLimiter;

  constructor(@Inject(POOL) pool: Pool) {
    /* 默认走共享。留一个关掉的开关，是给"只有一台机器、且不希望未认证
       请求碰到数据库"的部署 —— 那种部署下单实例计数本来就是准的。
       关掉要留声音：多副本 + 关掉 = 阈值静默乘以副本数。 */
    const off = process.env["SITEDESK_RATE_LIMIT_SHARED"] === "0";
    if (off)
      emit("warn", "rate-limit",
        "SITEDESK_RATE_LIMIT_SHARED=0：限流退回单实例计数。" +
        "多副本部署下实际配额 = 阈值 × 副本数。");
    const shared = off ? null : new PgSharedCounter(pool);

    this.link   = new RateLimiter("auth:magic-link",
      positiveInt("SITEDESK_LINK_LIMIT", 5), WINDOW_MS, shared);
    this.redeem = new RateLimiter("auth:redeem",
      positiveInt("SITEDESK_REDEEM_LIMIT", 10), WINDOW_MS, shared);
  }
}
