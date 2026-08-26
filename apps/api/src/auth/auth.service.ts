import { Injectable } from "@nestjs/common";
import { randomBytes, createHash } from "node:crypto";
import { ctx } from "../infra/ctx.js";
import { ProblemException } from "../infra/problem.js";
import { emit } from "../infra/log.js";
import { LoginDelivery, type Channel } from "../infra/login-delivery.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
/** 台的公开地址 —— 链接就是拿它拼的。填错了，链接点开会落到别处。 */
const publicOrigin = () =>
  (process.env["SITEDESK_PUBLIC_ORIGIN"] ?? "http://localhost:8080").replace(/\/+$/, "");
const LINK_TTL_MIN = 15;
const SESSION_TTL_H = 8;

/* ════════════════════════════════════════════════════════════════════
   认证。

   Phase 0 §9.3：内部走 OIDC，外部走一次性魔法链接。
   本阶段实现魔法链接与会话；OIDC 需要一个真实 IdP，
   在此以 `dev` provider 顶替（**仅当 SITEDESK_DEV_LOGIN=1 时可用**）。

   令牌只存哈希。明文只在生成的那一刻存在于内存里，随链接发出即丢弃 ——
   数据库被拖库时，明文令牌等于把所有人的会话一起交出去。
   ════════════════════════════════════════════════════════════════════ */
@Injectable()
export class AuthService {
  constructor(private readonly delivery: LoginDelivery) {}

  /** 签发一次性登录链接，并**交给通道送给本人**。
   *
   *  返回值只给开发登录（SITEDESK_DEV_LOGIN=1）用。生产环境下调用方
   *  拿到它也不该回显 —— 回显等于把登录接口变成谁都能用的后门。
   *
   *  收件地址**不看参数**：它由 app.issue_login_link 从 auth_identity 里解析。
   *  拿请求里的 sentTo 当收件地址，这个公开端点就是一键账号接管。 */
  async issueLink(login: string, claimedSentTo: string | null): Promise<{ token: string } | null> {
    const c = ctx();
    /* 签发发生在认证之前：此刻既没有 app.account_id，login_token 的 RLS 也会挡住插入。
       走 SECURITY DEFINER 函数一次性完成「解析 + 插入」，不去改会话状态 ——
       临时把 app.account_id 设成目标账号，等于给一个未认证请求提权。 */
    const token = randomBytes(32).toString("base64url");
    const { rows } = await c.client.query<{
      issued: boolean; reason: string; channel: Channel | null;
      destination: string | null; display_name: string | null;
    }>(`SELECT issued, reason, channel, destination, display_name
          FROM app.issue_login_link($1,$2,$3)`,
      [login, sha256(token), LINK_TTL_MIN]);
    const r = rows[0];

    if (!r?.issued) {
      /* 对外一律同一个 202；差别只写进日志。
         no-destination 是运维该去补的一件事，而它在响应里看不见 ——
         不写日志的话，"某个人一直收不到链接"就没有任何线索。 */
      emit("info", "login-delivery",
        r?.reason === "no-destination"
          ? "账号没有登记收件地址，未签发链接（用 deploy/login-address.sh 登记）"
          : "申请登录链接的账号不存在或已停用，未签发",
        { reason: r?.reason ?? "unknown" });
      return null;
    }

    if (claimedSentTo && claimedSentTo !== r.destination)
      /* 请求里带了一个和登记的不一样的地址。**照登记的发**，但要留声音：
         这既可能是有人在试探，也可能是这个人换了邮箱而没人来改。 */
      emit("warn", "login-delivery",
        "请求里声称的收件地址与登记的不一致，按登记的投递", {});

    /* **提交之后再发。** 在事务里发的话，用户可能在令牌落库之前就点开链接，
       拿到一句"链接无效"，而库里明明有 —— 那是最难复现的一类报障。 */
    const link = `${publicOrigin()}/login?token=${encodeURIComponent(token)}`;
    c.afterCommit.push(() => this.delivery.deliver({
      channel: r.channel ?? "email", to: r.destination!,
      displayName: r.display_name, link, ttlMin: LINK_TTL_MIN
    }).then((how) => {
      if (how === "no-transport")
        emit("warn", "login-delivery",
          "链接已签发，但没有配置对应的投递通道 —— 只能由运维用 deploy/login-link.sh 代发",
          { channel: r.channel });
    }));

    return { token };
  }

  /** 兑换链接换会话。兑换在数据库里原子完成，并发只有一次能成功。 */
  async redeem(token: string, userAgent: string | null): Promise<{ token: string; expiresAt: string }> {
    const c = ctx();
    const { rows } = await c.client.query<{ id: string | null }>(
      `SELECT app.consume_login_token($1) AS id`, [sha256(token)]);
    const accountId = rows[0]?.id ?? null;
    if (!accountId)
      throw new ProblemException("unauthenticated", {
        detail: "登录链接无效、已过期或已被使用。请重新申请。" });
    return this.openSession(accountId, userAgent);
  }

  async openSession(accountId: string, userAgent: string | null) {
    const c = ctx();
    const token = randomBytes(32).toString("base64url");
    /* 会话表带 RLS（account_id = current_account_id），此刻尚未设身份，
       故先设上再插入 —— 与请求中间件里的顺序一致。 */
    await c.client.query("SELECT set_config('app.account_id', $1, true)", [accountId]);
    const { rows } = await c.client.query<{ expires_at: Date }>(
      `INSERT INTO auth_session (account_id, token_hash, expires_at, user_agent)
       VALUES ($1,$2, now() + ($3 || ' hours')::interval, $4) RETURNING expires_at`,
      [accountId, sha256(token), String(SESSION_TTL_H), userAgent]);
    await c.client.query(`UPDATE account SET last_login_at = now() WHERE id = $1`, [accountId]);
    return { token, expiresAt: rows[0]!.expires_at.toISOString() };
  }

  async revoke(reason: string): Promise<void> {
    const c = ctx();
    await c.client.query(
      `UPDATE auth_session SET revoked_at = now(), revoke_reason = $1
        WHERE account_id = $2 AND revoked_at IS NULL`,
      [reason, c.principal!.accountId]);
  }
}
