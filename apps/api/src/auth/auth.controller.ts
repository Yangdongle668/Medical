import { Body, Controller, Get, Headers, HttpCode, Post } from "@nestjs/common";
import { z } from "zod";
import { AuthService } from "./auth.service.js";
import { Public, Operation } from "./guards.js";
import { ZodPipe } from "../infra/zod.pipe.js";
import { ProblemException } from "../infra/problem.js";
import { ctx } from "../infra/ctx.js";
import { FixedWindow } from "../infra/rate-limit.js";

const LinkBody   = z.object({ login: z.string().min(1).max(64), sentTo: z.string().max(128).optional() });
const RedeemBody = z.object({ token: z.string().min(16).max(256) });

/** 仅开发与测试可用。生产环境未设 SITEDESK_DEV_LOGIN 时这两个端点直接 404。 */
const devEnabled = () => process.env.SITEDESK_DEV_LOGIN === "1";

/* ── 限流：契约里 rate-limited(429) 早就在 COMMON_ERRORS 里了 ──────
   每个端点都声明过自己可能返回 429，只是一直没有实现。这里兑现它，
   落在最需要的地方 —— 两个 @Public() 的入口。

   **按 login 计数，而不是按 IP。**
   这是刻意的：IP 是攻击者能换的东西（代理池、XFF 伪造，尤其在
   `trust proxy` 没配对的时候），login 是他换不掉的 —— 他要刷的就是
   那一个邮箱。挡住"同一个账号被反复发链接"，正是这个端点真正要保护的。
   IP 维度留给网关去做，那一层才有可信的来源地址。

   兑换端点按令牌前缀计数：暴力猜令牌时每次的令牌都不同，
   所以这里限的是"同一把令牌被反复试"，配合一次性消费已经够。 */
const LINK_PER_LOGIN = new FixedWindow(
  Number(process.env["SITEDESK_LINK_LIMIT"] ?? 5), 10 * 60_000);
const REDEEM_PER_TOKEN = new FixedWindow(
  Number(process.env["SITEDESK_REDEEM_LIMIT"] ?? 10), 10 * 60_000);

function gate(w: FixedWindow, key: string, what: string): void {
  const v = w.hit(key);
  if (v.allowed) return;
  throw new ProblemException("rate-limited", {
    detail: `${what}过于频繁，请在 ${v.retryAfterSec} 秒后重试。`
  });
}

@Controller("/v1/auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("/magic-link") @Public() @Operation("requestMagicLink") @HttpCode(202)
  async link(@Body(new ZodPipe(LinkBody)) b: z.infer<typeof LinkBody>) {
    /* 计数在**发送之前** —— 放在后面的话，限流拦住的是"记一笔"，
       而邮件已经发出去了，被刷的那个邮箱一点也没少收。 */
    gate(LINK_PER_LOGIN, b.login.toLowerCase(), "登录链接申请");
    const issued = await this.auth.issueLink(b.login, b.sentTo ?? null);
    /* 无论账号是否存在都返回同样的 202 —— 否则这个接口就是一个账号枚举器。
       链接由邮件/短信通道直接发给本人，绝不回显给调用方。 */
    return {
      accepted: true,
      message: "若该账号存在且在职，登录链接已发送。链接 15 分钟内有效，且只能使用一次。",
      ...(devEnabled() && issued ? { devToken: issued.token } : {})
    };
  }

  @Post("/session") @Public() @Operation("redeemMagicLink")
  redeem(
    @Body(new ZodPipe(RedeemBody)) b: z.infer<typeof RedeemBody>,
    @Headers("user-agent") ua?: string
  ) {
    gate(REDEEM_PER_TOKEN, b.token.slice(0, 32), "登录链接兑换");
    return this.auth.redeem(b.token, ua ?? null);
  }

  @Post("/dev-session") @Public() @Operation("devSession")
  async dev(@Body(new ZodPipe(LinkBody)) b: z.infer<typeof LinkBody>, @Headers("user-agent") ua?: string) {
    if (!devEnabled()) throw new ProblemException("not-found");
    const c = ctx();
    const { rows } = await c.client.query<{ id: string | null }>(
      `SELECT app.resolve_login($1) AS id`, [b.login]);
    const id = rows[0]?.id ?? null;
    if (!id) throw new ProblemException("unauthenticated", { detail: "账号不存在或已停用" });
    return this.auth.openSession(id, ua ?? null);
  }

  @Post("/logout") @Operation("logout") @HttpCode(204)
  async logout() { await this.auth.revoke("用户主动登出"); }

  @Get("/session") @Operation("currentSession")
  current() {
    const p = ctx().principal!;
    return { accountId: p.accountId, login: p.login, roleCode: p.roleCode };
  }
}
