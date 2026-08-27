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
    "「存在但没登记收件地址」也返回同样的 202 —— 那是第三种状态，同样不能被区分出来。\n" +
    "链接由邮件 / 短信通道直接发给本人，绝不回显给调用方。",
  body: z.object({
    login: z.string().min(1).max(64),
    sentTo: z.string().max(128).optional()
      .describe(
        "调用方声称的收件地址，**仅用于审计留痕，不决定投递到哪里**。" +
        "实际收件地址由服务端从已登记的身份解析（auth_identity, provider=magic-link）——" +
        "拿这个字段当收件地址的话，这个公开端点就是一键账号接管。")
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

/* ════════════════════════════════════════════════════════════════════
   口令。

   上面那段注释说「外部方不用密码」——那句话现在仍然成立，
   这里加的不是给机构老师用的第二条路，是**开机的那把钥匙**：
   一次干净的部署跑完，库里零个账号，而建账号要求先登录。
   要登录得先有账号，要有账号得先登录 —— 装完了打不开门。

   所以口令的定位是"内部账号可选、出厂管理员必需"，
   不是"所有人都改用密码"。`hasPassword` 为 false 是正常状态。
   ════════════════════════════════════════════════════════════════════ */

define({
  id: "passwordLogin", method: "post", path: "/v1/auth/password-session",
  layer: "L1", context: CTX,
  summary: "口令登录",
  description:
    "**账号不存在、账号没设口令、口令不对，返回的是同一个 401，且耗时相同。**\n" +
    "三者任一被区分出来，这个接口就成了账号枚举器；\n" +
    "耗时不同也一样能读出来 —— 所以验证失败时服务端照样烧掉一次 scrypt。\n\n" +
    "连续失败会锁定，锁定时长随失败次数指数增长（封顶 15 分钟）。\n" +
    "固定阈值对撞库没用而对本人很痛：打错三次的人被关半小时，脚本换个账号继续跑。",
  body: z.object({
    login: z.string().min(1).max(64),
    password: z.string().min(1).max(200)
  }),
  response: SessionGranted,
  errors: ["unauthenticated", "rate-limited"]
});

define({
  id: "changePassword", method: "post", path: "/v1/auth/password",
  layer: "L1", context: CTX, status: 204,
  summary: "改自己的口令",
  description:
    "要验旧口令 —— 会话被偷走时，改密是攻击者第一件想做的事。\n" +
    "没有旧口令的账号（只用一次性链接登录的人）传空串即可：\n" +
    "他是靠一个真实会话进来的，那本身就是身份证明。\n\n" +
    "改完**撤销本人其余会话**，只留当前这一个：改密的常见理由就是「号可能被人拿了」，\n" +
    "而改完不踢掉别的会话，等于把这件事做了一半。",
  body: z.object({
    currentPassword: z.string().max(200),
    newPassword: z.string().min(8).max(200)
  }),
  errors: ["unauthenticated", "validation-failed"]
});
