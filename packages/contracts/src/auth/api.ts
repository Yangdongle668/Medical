import { z } from "zod";
import { define } from "../kernel/registry.js";
import { Uuid, Timestamp } from "../kernel/primitives.js";

/* ════════════════════════════════════════════════════════════════════
   认证（Phase 0 §9.3）
     内部员工 → OIDC（企业微信 / 飞书）
     外部方   → 一次性魔法链接，15 分钟有效、单次使用

   为什么外部方不用密码：机构老师一周登录几次，密码只会被忘记然后走找回流程 ——
   那还不如每次直接发一条链接。
   ════════════════════════════════════════════════════════════════════ */

const CTX = "auth";

export const SessionGranted = z.object({
  token: z.string().describe("会话令牌。服务端只保存它的 SHA-256，明文仅此一次返回。"),
  expiresAt: Timestamp
}).meta({ id: "SessionGranted" });

export const LinkAccepted = z.object({
  accepted: z.literal(true),
  message: z.string(),
  devToken: z.string().optional()
    .describe("仅当 SITEDESK_DEV_LOGIN=1 时出现，供本地与 CI 使用。生产环境永远不返回。")
}).meta({ id: "LinkAccepted" });

define({
  id: "requestMagicLink", method: "post", path: "/v1/auth/magic-link",
  layer: "L1", context: CTX, status: 202,
  summary: "申请一次性登录链接",
  description:
    "**无论账号是否存在都返回同样的 202。** 区别对待会让这个接口变成账号枚举器。\n" +
    "链接由邮件 / 短信通道直接发给本人，绝不回显给调用方。",
  body: z.object({
    login: z.string().min(1).max(64),
    sentTo: z.string().max(128).optional().describe("收件地址，仅用于审计留痕")
  }),
  response: LinkAccepted
});

define({
  id: "redeemMagicLink", method: "post", path: "/v1/auth/session",
  layer: "L1", context: CTX,
  summary: "兑换登录链接，换取会话",
  description:
    "兑换在数据库里原子完成：并发的两次兑换只有一次能成功。\n" +
    "放在应用层做「先查再改」，两个请求同时到达就会双双成功。",
  body: z.object({ token: z.string().min(16).max(256) }),
  response: SessionGranted,
  errors: ["unauthenticated"]
});

define({
  id: "currentSession", method: "get", path: "/v1/auth/session",
  layer: "L1", context: CTX, summary: "当前会话",
  response: z.object({ accountId: Uuid, login: z.string(), roleCode: z.string() })
});

define({
  id: "logout", method: "post", path: "/v1/auth/logout",
  layer: "L1", context: CTX, status: 204,
  summary: "登出（撤销本人全部会话）",
  description: "会话可撤销是外部方场景的硬要求：机构老师离职、PI 换人都要能立刻断开。"
});
