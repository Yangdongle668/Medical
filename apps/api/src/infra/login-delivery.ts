/* 登录链接的投递通道 —— 这套系统上线前必须补的那一件事。
 *
 *  ── 在此之前是什么状况 ──────────────────────────────────────────────
 *  `POST /v1/auth/magic-link` 老老实实签发令牌、写进库，然后**不告诉任何人**。
 *  回显令牌是绝对不行的（那等于把登录接口变成谁都能用的后门），
 *  所以"不回显"是对的 —— 缺的是另一头：**把它送到本人手里**。
 *
 *  结果是一套刚部署好的系统没有任何人能登进去，只能由能进服务器的人
 *  跑 `deploy/login-link.sh` 代发。签发权限因此等同于运维权限。
 *  那是个可用的过渡，不是可以一直留着的状态。
 *
 *  ── 三条不能让步的规矩 ──────────────────────────────────────────────
 *
 *  ① **收件地址由服务端解析，绝不用调用方传的那个。**
 *     契约里 `sentTo` 的说明是"仅用于审计留痕"。通道做出来之后，
 *     如果顺手拿它当收件地址，这个公开端点就成了一键账号接管：
 *       POST /v1/auth/magic-link {"login":"lingyuan","sentTo":"我@攻击者"}
 *     地址只能来自 `auth_identity(provider='magic-link')` —— 库里登记过的那个。
 *
 *  ② **发不出去也返回同样的 202。**
 *     "这个账号没登记地址"和"这个账号不存在"必须长得一模一样，
 *     否则这个端点又变回账号枚举器。差别只写进服务端日志。
 *
 *  ③ **令牌不进日志。** 日志里只有掩码后的收件地址。
 *     把登录链接打进日志，等于把登录权限授予所有能读日志的人 ——
 *     所以 console 通道在生产环境是**拒绝启动**，不是"不推荐"。
 */
import { emit } from "./log.js";
import { sendMail } from "./smtp.js";

export type Channel = "email" | "sms";

export interface LoginLink {
  channel: Channel;
  /** 收件地址。来自库里登记的那个，不来自请求。 */
  to: string;
  displayName: string | null;
  link: string;
  ttlMin: number;
}

export interface Transport {
  readonly kind: "smtp" | "webhook" | "console";
  send(m: LoginLink): Promise<void>;
}

/** 日志里的收件地址一律掩码。留头留尾是为了让运维认得出"是不是那个人"，
 *  又不至于把通讯录抄进日志留存。 */
export function mask(addr: string): string {
  const at = addr.lastIndexOf("@");
  if (at > 0) {
    const [name, domain] = [addr.slice(0, at), addr.slice(at)];
    return (name.length <= 2 ? name[0] + "*" : name[0] + "*".repeat(name.length - 2) +
      name[name.length - 1]) + domain;
  }
  return addr.length <= 4 ? "*".repeat(addr.length)
    : addr.slice(0, 3) + "*".repeat(Math.max(1, addr.length - 7)) + addr.slice(-4);
}

/* ── 正文 ─────────────────────────────────────────────────────────────
   短、只有一件事、并且说清"不是你申请的怎么办"。
   链接是一次性的，所以"忽略即可"是真话，不是安慰。 */
export const subjectOf = (ttlMin: number) => `中心台登录链接（${ttlMin} 分钟内有效）`;

export function bodyOf(m: LoginLink): string {
  const who = m.displayName ? `${m.displayName}，你好：` : "你好：";
  return [
    who, "",
    `点开下面的链接即可登录中心台。链接 ${m.ttlMin} 分钟内有效，**只能使用一次**：`, "",
    m.link, "",
    "不是你本人申请的话，忽略这条消息即可 —— 没有点开，它就不会生效。"
  ].join("\n");
}

/** 短信没有主题，也没有耐心：把有效期和链接放在最前面。 */
export const smsOf = (m: LoginLink) =>
  `【中心台】登录链接（${m.ttlMin} 分钟内有效，只能用一次）：${m.link}　非本人申请请忽略。`;

/* ── 三种通道 ─────────────────────────────────────────────────────── */

class SmtpTransport implements Transport {
  readonly kind = "smtp" as const;
  constructor(private readonly url: string, private readonly from: string) {}
  async send(m: LoginLink) {
    await sendMail({ url: this.url, from: this.from },
      { to: m.to, subject: subjectOf(m.ttlMin), text: bodyOf(m) });
  }
}

/** 短信网关。厂商各不相同，所以这里只定一个最小的形状：
 *  POST 一个 `{to, text}` 的 JSON 过去，鉴权用 Bearer。
 *  真实网关的字段名对不上时，中间摆一个十行的适配器即可 ——
 *  比在这里长出一张厂商清单便宜得多。 */
class WebhookTransport implements Transport {
  readonly kind = "webhook" as const;
  constructor(private readonly url: string, private readonly token: string | null) {}
  async send(m: LoginLink) {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {})
      },
      body: JSON.stringify({ to: m.to, text: smsOf(m) }),
      signal: AbortSignal.timeout(10_000)
    });
    if (!res.ok)
      throw new Error(`短信网关返回 ${res.status} ${res.statusText}`);
  }
}

/** 开发用：把链接打在自己的日志里。**生产环境拒绝启动**（见 preflight）。 */
class ConsoleTransport implements Transport {
  readonly kind = "console" as const;
  send(m: LoginLink) {
    /* info 而不是 warn：这是开发环境下**唯一**拿到链接的办法，属于正常输出。
       真正该刺耳的地方在 preflight —— 它在生产环境直接拒绝启动。 */
    emit("info", "login-delivery",
      `【开发通道】给 ${m.to} 的登录链接：${m.link}`, { channel: m.channel });
    return Promise.resolve();
  }
}

/* ── 配置 ─────────────────────────────────────────────────────────── */

export interface DeliveryPlan {
  email: "smtp" | "console" | "none";
  sms: "webhook" | "console" | "none";
  /** 配置本身有问题 —— 交给 preflight 拒绝启动 */
  fatal: string[];
}

const isProd = (env: NodeJS.ProcessEnv) =>
  (env["NODE_ENV"] ?? "").toLowerCase() === "production";

/** 纯函数：只看 env，算出两条通道各自走哪一种。便于直接测。 */
export function deliveryPlan(env: NodeJS.ProcessEnv = process.env): DeliveryPlan {
  const fatal: string[] = [];
  const forced = env["SITEDESK_LOGIN_LINK_TRANSPORT"]?.trim().toLowerCase();

  if (forced === "console" && isProd(env))
    fatal.push(
      "SITEDESK_LOGIN_LINK_TRANSPORT=console 与 NODE_ENV=production 同时出现。\n" +
      "    这个通道会把**可用的登录链接**打进日志 —— 于是所有能读日志的人\n" +
      "    都能以任何人的身份登录，而审计轨迹里看到的是那个人自己。\n" +
      "    生产环境请配 SITEDESK_SMTP_URL 或 SITEDESK_SMS_WEBHOOK_URL。");
  if (forced && forced !== "console" && forced !== "none")
    fatal.push(`SITEDESK_LOGIN_LINK_TRANSPORT=${forced} 不认识（只支持 console / none）。`);

  const smtpUrl = env["SITEDESK_SMTP_URL"]?.trim();
  if (smtpUrl) {
    try {
      const u = new URL(smtpUrl);
      if (u.protocol !== "smtp:" && u.protocol !== "smtps:")
        fatal.push(`SITEDESK_SMTP_URL 的协议必须是 smtp:// 或 smtps://（收到 ${u.protocol}）。`);
    } catch { fatal.push("SITEDESK_SMTP_URL 不是一个合法的 URL。"); }
    if (!env["SITEDESK_MAIL_FROM"]?.trim())
      fatal.push(
        "配了 SITEDESK_SMTP_URL 却没有 SITEDESK_MAIL_FROM。\n" +
        "    没有发件人，绝大多数服务器会直接拒收 —— 而那要等到第一个人\n" +
        "    申请登录链接时才发现。");
  }

  /* 显式写 none 就是**两条都关**，哪怕 SMTP 配着 ——
     "我知道我配了，但现在别发"是一个合法的意图（比如临时停掉外发），
     而让它被一个还留在 .env 里的旧配置推翻，是最容易出事的那种"聪明"。 */
  if (forced === "none") return { email: "none", sms: "none", fatal };

  /* 没配就是没配：生产环境退回"什么都不发"，由运维用 login-link.sh 代发；
     开发环境退回 console，否则本地开发根本拿不到链接。 */
  const fallback = isProd(env) ? "none" : "console";
  return {
    email: forced === "console" ? "console" : (smtpUrl ? "smtp" : fallback),
    sms: forced === "console" ? "console"
      : (env["SITEDESK_SMS_WEBHOOK_URL"]?.trim() ? "webhook" : fallback),
    fatal
  };
}

/** 生产环境两条通道都没配 —— 不拒绝启动（运维代发仍然是可用的路径），
 *  但必须说一次：这是上线清单上的一项。 */
export const NO_CHANNEL_WARNING =
  "登录链接没有配置任何投递通道（SITEDESK_SMTP_URL / SITEDESK_SMS_WEBHOOK_URL）。\n" +
  "    系统仍然会签发令牌，但没有人收得到 —— 只能由能进服务器的人跑\n" +
  "    deploy/login-link.sh 代发，也就是说签发权限等同于运维权限。\n" +
  "    这是上线前该补掉的一项。";

/* ── 投递 ─────────────────────────────────────────────────────────── */

export class LoginDelivery {
  private readonly email: Transport | null;
  private readonly sms: Transport | null;
  readonly plan: DeliveryPlan;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.plan = deliveryPlan(env);
    const console_ = new ConsoleTransport();
    this.email = this.plan.email === "smtp"
      ? new SmtpTransport(env["SITEDESK_SMTP_URL"]!, env["SITEDESK_MAIL_FROM"]!)
      : this.plan.email === "console" ? console_ : null;
    this.sms = this.plan.sms === "webhook"
      ? new WebhookTransport(env["SITEDESK_SMS_WEBHOOK_URL"]!,
          env["SITEDESK_SMS_WEBHOOK_TOKEN"]?.trim() || null)
      : this.plan.sms === "console" ? console_ : null;
  }

  /** 这条通道有没有人在听。没有的话调用方只记日志，**响应仍然是同一个 202**。 */
  transportFor(channel: Channel): Transport | null {
    return channel === "email" ? this.email : this.sms;
  }

  /** 送。失败就抛 —— 由调用方决定怎么记，但它绝不会变成响应的一部分。 */
  async deliver(m: LoginLink): Promise<"sent" | "no-transport"> {
    const t = this.transportFor(m.channel);
    if (!t) return "no-transport";
    await t.send(m);
    /* 只记掩码后的地址与通道。链接绝不进日志 —— 那等于把登录权限
       交给所有能读日志的人。 */
    emit("info", "login-delivery", "登录链接已投递",
      { channel: m.channel, via: t.kind, to: mask(m.to) });
    return "sent";
  }
}
