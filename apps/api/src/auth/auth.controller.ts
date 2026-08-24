import { Body, Controller, Get, Headers, HttpCode, Post } from "@nestjs/common";
import { z } from "zod";
import { AuthService } from "./auth.service.js";
import { Public, Operation } from "./guards.js";
import { ZodPipe } from "../infra/zod.pipe.js";
import { ProblemException } from "../infra/problem.js";
import { ctx } from "../infra/ctx.js";

const LinkBody   = z.object({ login: z.string().min(1).max(64), sentTo: z.string().max(128).optional() });
const RedeemBody = z.object({ token: z.string().min(16).max(256) });

/** 仅开发与测试可用。生产环境未设 SITEDESK_DEV_LOGIN 时这两个端点直接 404。 */
const devEnabled = () => process.env.SITEDESK_DEV_LOGIN === "1";

@Controller("/v1/auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("/magic-link") @Public() @Operation("requestMagicLink") @HttpCode(202)
  async link(@Body(new ZodPipe(LinkBody)) b: z.infer<typeof LinkBody>) {
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
  ) { return this.auth.redeem(b.token, ua ?? null); }

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
