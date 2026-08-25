import { Injectable } from "@nestjs/common";
import { randomBytes, createHash } from "node:crypto";
import { ctx } from "../infra/ctx.js";
import { ProblemException } from "../infra/problem.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
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
  /** 签发一次性登录链接。**不返回给调用方**，由邮件/短信通道直接发给本人。 */
  async issueLink(login: string, sentTo: string | null): Promise<{ token: string } | null> {
    const c = ctx();
    /* 签发发生在认证之前：此刻既没有 app.account_id，login_token 的 RLS 也会挡住插入。
       走 SECURITY DEFINER 函数一次性完成「解析 + 插入」，不去改会话状态 ——
       临时把 app.account_id 设成目标账号，等于给一个未认证请求提权。 */
    const token = randomBytes(32).toString("base64url");
    const { rows } = await c.client.query<{ issued: boolean }>(
      `SELECT app.issue_login_token($1,$2,$3,$4) AS issued`,
      [login, sha256(token), LINK_TTL_MIN, sentTo]);
    return rows[0]?.issued ? { token } : null;
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
