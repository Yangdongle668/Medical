import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import { POOL } from "../infra/db.js";
import { randomBytes, createHash } from "node:crypto";
import { ctx } from "../infra/ctx.js";
import { ProblemException } from "../infra/problem.js";
import { emit } from "../infra/log.js";
import { LoginDelivery, type Channel } from "../infra/login-delivery.js";
import { hashPassword, verifyPassword, passwordProblem } from "./password.js";

/** 三种失败一个说法。区分开来，这个端点就是账号枚举器。 */
const wrongPassword = () =>
  new ProblemException("unauthenticated", { detail: "登录名或口令不对" });

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
/** 台的公开地址 —— 链接就是拿它拼的。填错了，链接点开会落到别处。 */
const publicOrigin = () =>
  (process.env["SITEDESK_PUBLIC_ORIGIN"] ?? "http://localhost:8080").replace(/\/+$/, "");
/* 有效期。两个都曾经是写死的常量 —— 而"链接 15 分钟够不够"这件事
   取决于客户的邮件网关排队多久，不取决于我们。

   上限是数据库那一侧管的（login_token_max_ttl，60 分钟，见迁移 0016）：
   在这里放宽而不改约束的话，配大了会撞在一句 CHECK 违反上，
   而那句话指不到是谁配错了。 */
const intEnv = (name: string, dflt: number, lo: number, hi: number) => {
  const raw = process.env[name]?.trim();
  if (!raw) return dflt;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n < lo || n > hi) {
    emit("warn", "auth",
      `${name}=${JSON.stringify(raw)} 不在 ${lo}–${hi} 之间，改用默认值 ${dflt}`);
    return dflt;
  }
  return n;
};
const LINK_TTL_MIN = () => intEnv("SITEDESK_LINK_TTL_MIN", 15, 1, 60);
const SESSION_TTL_H = () => intEnv("SITEDESK_SESSION_TTL_H", 8, 1, 24 * 30);

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
  constructor(
    private readonly delivery: LoginDelivery,
    /** 口令失败计数要活过业务回滚，所以得有一条不属于本次事务的连接。 */
    @Inject(POOL) private readonly pool: Pool
  ) {}

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
      [login, sha256(token), LINK_TTL_MIN()]);
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
      displayName: r.display_name, link, ttlMin: LINK_TTL_MIN()
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
      [accountId, sha256(token), String(SESSION_TTL_H()), userAgent]);
    await c.client.query(`UPDATE account SET last_login_at = now() WHERE id = $1`, [accountId]);
    return { token, expiresAt: rows[0]!.expires_at.toISOString() };
  }

  /* ── 口令 ───────────────────────────────────────────────────────
     成功与三种失败（账号不存在 / 没设口令 / 口令不对）返回的东西完全一样，
     **而且耗时也要一样** —— 见 password.ts 里那段「照样烧掉一次 scrypt」。 */
  async passwordLogin(login: string, password: string, userAgent: string | null) {
    const c = ctx();
    const { rows } = await c.client.query<{
      account_id: string; hash: string | null; is_initial: boolean;
      locked_until: Date | null;
    }>(`SELECT account_id, hash, is_initial, locked_until
          FROM app.password_challenge($1)`, [login]);
    const r = rows[0];

    /* 账号不存在：**也要走一次验证**再拒。直接 return 的话，
       "这个登录名在不在"就能用秒表读出来。 */
    if (!r) {
      await verifyPassword(password, null);
      emit("info", "password-login", "口令登录失败：账号不存在或已停用", {});
      throw wrongPassword();
    }

    if (r.locked_until && r.locked_until > new Date()) {
      const sec = Math.ceil((r.locked_until.getTime() - Date.now()) / 1000);
      emit("warn", "password-login", "口令登录被账号锁定挡下", { login });
      /* 这里**说得出**锁定还剩多久 —— 能走到这一步的人已经证明了
         这个账号存在（他触发过锁定），瞒着他只会让本人打不开门还不知道为什么。 */
      throw new ProblemException("rate-limited", {
        detail: `连续失败次数过多，账号已被临时锁定，请在 ${sec} 秒后重试。` });
    }

    const ok = await verifyPassword(password, r.hash);
    if (!ok) {
      /* **走池子，不走请求那条连接。**
         这里马上要抛 401，抛错就回滚 —— 记在请求连接上的失败次数
         会跟着一起没掉。也就是说：猜错的每一次都不算数，
         锁定永远不会生效，而 auth_password.failed_count 会一直是 0，
         看上去像"从来没人猜错过"。

         同样的坑 PgSharedCounter 里已经栽过一次并写在注释里了
         （"限流的计数必须活过业务的回滚"）—— 这是第二处。 */
      await this.pool.query(`SELECT app.password_login_failed($1)`, [r.account_id]);
      emit("info", "password-login",
        r.hash ? "口令登录失败：口令不对" : "口令登录失败：该账号没有设过口令", {});
      throw wrongPassword();
    }

    await c.client.query(`SELECT app.password_login_ok($1)`, [r.account_id]);
    if (r.is_initial)
      emit("warn", "password-login",
        `账号 ${login} 用出厂口令登录成功 —— 请立刻改密`, { login });
    return this.openSession(r.account_id, userAgent);
  }

  /** 改自己的口令。改完只留当前这一个会话。 */
  async changePassword(currentPassword: string, newPassword: string, sessionToken: string | null) {
    const c = ctx(), p = c.principal!;
    const bad = passwordProblem(newPassword);
    if (bad) throw new ProblemException("validation-failed", { detail: bad });

    const { rows } = await c.client.query<{ hash: string }>(
      `SELECT hash FROM auth_password WHERE account_id = $1`, [p.accountId]);
    const existing = rows[0]?.hash ?? null;

    /* 有口令就必须验旧的。会话被偷走时，改密是攻击者第一件想做的事 ——
       只凭一个会话就能换掉口令，等于会话一旦泄漏账号就永久失守。
       没口令的人（只用一次性链接登录）不必验：他手上那个真实会话
       本身就是身份证明，而"输入你没有的旧口令"是一条走不通的路。 */
    if (existing && !await verifyPassword(currentPassword, existing))
      throw new ProblemException("unauthenticated", { detail: "当前口令不对" });

    await c.client.query(`SELECT app.set_password($1, $2, false)`,
      [p.accountId, await hashPassword(newPassword)]);

    /* 改密的常见理由就是「号可能被人拿了」。
       不踢掉别的会话，这件事就只做了一半 —— 对方那个会话还开着。
       **留下当前这一个**：把自己一起踢掉，人改完密码就被弹回登录页，
       会以为改失败了。 */
    await c.client.query(
      `UPDATE auth_session SET revoked_at = now(), revoke_reason = $1
        WHERE account_id = $2 AND revoked_at IS NULL AND token_hash <> $3`,
      ["改密后清场", p.accountId, sha256(sessionToken ?? "")]);
  }

  async revoke(reason: string): Promise<void> {
    const c = ctx();
    await c.client.query(
      `UPDATE auth_session SET revoked_at = now(), revoke_reason = $1
        WHERE account_id = $2 AND revoked_at IS NULL`,
      [reason, c.principal!.accountId]);
  }
}
