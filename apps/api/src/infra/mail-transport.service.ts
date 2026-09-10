import { Injectable } from "@nestjs/common";
import { ctx, principal } from "./ctx.js";
import { ProblemException } from "./problem.js";
import { seal, open, hasSecretKey } from "./secret.js";
import { mask, type Transport, type Message } from "./login-delivery.js";
import { sendMail } from "./smtp.js";

/* ════════════════════════════════════════════════════════════════════
   投递通道：库里那一份。

   ── 为什么要在请求里就把它读出来 ────────────────────────────────
   投递发生在 `afterCommit` 里（令牌先落库，再发信 —— 否则用户可能
   在令牌落库之前就点开链接，拿到一句"链接无效"而库里明明有）。
   而 `afterCommit` 跑的时候**数据库连接已经归还了**
   （notify.ts 里写着同一条）。所以配置必须在请求内读出来，
   装进闭包带过去，不能等到要发的时候再查。

   ── 环境变量没有作废 ────────────────────────────────────────────
   库里没配就回退到 env。理由是第一个租户开出来之前没有人能登进来配它 ——
   那是另一个死锁。env 是开机的那条路，库里那份是日常运营的那条路。
   ════════════════════════════════════════════════════════════════════ */

interface Row {
  kind: string; url: string | null; from_addr: string | null;
  username: string | null; secret_enc: string | null;
  updated_at: Date | null; updated_by_name: string | null;
  last_test_at: Date | null; last_test_ok: boolean | null; last_test_error: string | null;
}

/** 已经解好、可以直接用来发信的一份配置。**含明文口令，不出这一层。** */
export interface ResolvedSmtp { url: string; from: string }

const ts = (v: Date | null) => v ? v.toISOString() : null;

@Injectable()
export class MailTransportService {
  private async row(): Promise<Row | null> {
    const c = ctx();
    const { rows } = await c.client.query<Row>(
      `SELECT m.kind, m.url, m.from_addr, m.username, m.secret_enc,
              m.updated_at, a.display_name AS updated_by_name,
              m.last_test_at, m.last_test_ok, m.last_test_error
         FROM mail_transport m
         LEFT JOIN account a ON a.id = m.updated_by
        WHERE m.tenant_id = app.current_tenant_id()`);
    return rows[0] ?? null;
  }

  /** 给设置页看的那一份。**没有口令**，只有"存了没有"。 */
  async get() {
    const r = await this.row();
    const envUrl = process.env["SITEDESK_SMTP_URL"]?.trim();
    const dbOn = r?.kind === "smtp" && !!r.url;
    return {
      kind: (r?.kind ?? "none") as "smtp" | "none",
      url: r?.url ?? null,
      fromAddr: r?.from_addr ?? null,
      username: r?.username ?? null,
      secretSet: !!r?.secret_enc,
      source: dbOn ? "db" as const : envUrl ? "env" as const : "none" as const,
      keyReady: hasSecretKey(),
      lastTestAt: ts(r?.last_test_at ?? null),
      lastTestOk: r?.last_test_ok ?? null,
      lastTestError: r?.last_test_error ?? null,
      updatedAt: ts(r?.updated_at ?? null),
      updatedByName: r?.updated_by_name ?? null
    };
  }

  /** 解出可用的 SMTP 配置：库里优先，回退 env，都没有就 null。
   *
   *  **必须在请求内调用**（afterCommit 时连接已经归还）。 */
  async resolve(): Promise<ResolvedSmtp | null> {
    const r = await this.row();
    if (r?.kind === "smtp" && r.url && r.from_addr) {
      let url = r.url;
      if (r.username) {
        /* 口令拼进 URL 是 smtp.ts 的入参形状。**拼在这一层**，
           库里那一栏因此永远不含口令 —— 它会进日志、进报错、进
           "把这行配置发给我看看"的截图。 */
        const u = new URL(r.url);
        u.username = encodeURIComponent(r.username);
        if (r.secret_enc) u.password = encodeURIComponent(open(r.secret_enc));
        url = u.toString();
      }
      return { url, from: r.from_addr };
    }
    const envUrl = process.env["SITEDESK_SMTP_URL"]?.trim();
    const envFrom = process.env["SITEDESK_MAIL_FROM"]?.trim();
    return envUrl && envFrom ? { url: envUrl, from: envFrom } : null;
  }

  /** 把解好的配置包成通道。给 LoginDelivery 用。 */
  static transportOf(cfg: ResolvedSmtp): Transport {
    return {
      kind: "smtp",
      async send(m: Message) {
        await sendMail({ url: cfg.url, from: cfg.from },
          { to: m.to, subject: m.subject, text: m.text });
      }
    };
  }

  async set(b: {
    kind: "smtp" | "none";
    url?: string | null; fromAddr?: string | null;
    username?: string | null; secret?: string | null;
    reason: string;
  }) {
    const c = ctx();
    const p = principal();
    const before = await this.get();

    if (b.kind === "smtp") {
      if (!b.url?.trim() || !b.fromAddr?.trim())
        throw new ProblemException("invariant-violated", {
          invariant: "mail-transport-incomplete",
          detail: "选了 SMTP 就必须给服务器地址和发件人 —— " +
            "没有发件人，绝大多数服务器会直接拒收，而那要等到第一个人申请登录链接时才发现"
        });
      let u: URL;
      try { u = new URL(b.url.trim()); }
      catch { throw this.badUrl("这不是一个合法的地址"); }
      if (u.protocol !== "smtp:" && u.protocol !== "smtps:")
        throw this.badUrl(`协议必须是 smtp:// 或 smtps://（收到 ${u.protocol}）`);
      if (u.username || u.password)
        throw this.badUrl(
          "地址里不要带用户名和口令 —— 它们分开填。" +
          "URL 会进日志、进报错、进「把这行配置发给我看看」的截图，而口令不该跟着去");
    }

    /* 口令三种意思：**省略 = 不动已存的那一个**（改个端口不该被迫重输
       口令），空串 = 清掉，有值 = 换成新的。三种都要分得开。 */
    let secret: string | null | undefined;
    if (b.secret !== undefined) {
      if (b.secret === null || b.secret === "") secret = null;
      else {
        if (!hasSecretKey())
          throw new ProblemException("invariant-violated", {
            invariant: "no-secret-key",
            detail: "服务器上没有配置 SITEDESK_SECRET_KEY，口令没法安全地存下来。" +
              "先在服务器上设一个（openssl rand -base64 32），再回来填口令 —— " +
              "这里不会悄悄存明文：一份会进备份、进从库、进 dump 的明文口令，" +
              "比「这个功能暂时不能用」糟得多。"
          });
        secret = seal(b.secret);
      }
    }

    /* 先保证有一行，再更新。**不写成一条 upsert** ——
       ON CONFLICT DO UPDATE 里 `mail_transport.x`（旧值）和
       `excluded.x`（新值）混在一起，是"口令那一栏到底动没动"
       最容易写错的地方，而写错的表现是口令被悄悄清掉。 */
    await c.client.query(
      `INSERT INTO mail_transport (tenant_id, kind) VALUES (app.current_tenant_id(), 'none')
       ON CONFLICT (tenant_id) DO NOTHING`);
    await c.client.query(
      `UPDATE mail_transport
          SET kind = $1, url = $2, from_addr = $3, username = $4,
              updated_by = $5, updated_at = now()
              ${secret !== undefined ? ", secret_enc = $6" : ""},
              /* 改了配置，上一次试发的结果就不再说明任何事 —— 留着它
                 会让人以为「绿的，配好了」，而那是上一台服务器的绿。 */
              last_test_at = NULL, last_test_ok = NULL, last_test_error = NULL
        WHERE tenant_id = app.current_tenant_id()`,
      secret !== undefined
        ? [b.kind, b.url?.trim() || null, b.fromAddr?.trim() || null,
           b.username?.trim() || null, p.accountId, secret]
        : [b.kind, b.url?.trim() || null, b.fromAddr?.trim() || null,
           b.username?.trim() || null, p.accountId]);

    const after = await this.get();
    return { before, after };
  }

  private badUrl(why: string) {
    return new ProblemException("invariant-violated",
      { invariant: "mail-transport-bad-url", detail: `SMTP 地址不对：${why}` });
  }

  /** 记一次试发的结果。收件人由调用方解析（一律是本人登记的地址）。 */
  async recordTest(ok: boolean, error: string | null) {
    await ctx().client.query(
      `UPDATE mail_transport
          SET last_test_at = now(), last_test_ok = $1, last_test_error = $2
        WHERE tenant_id = app.current_tenant_id()`, [ok, error]);
  }

  /** 试发。**收件人不接受传入** —— 一律取当前登录者登记的那个地址。 */
  async test(): Promise<{ ok: boolean; sentTo: string | null; error: string | null }> {
    const c = ctx();
    const p = principal();
    /* 收件地址走 `app.login_destination` —— 全仓库唯一的一处判定
       （它自己的注释：「与 app.issue_login_link 同一条判定 ——
       两处分开写必然漂移」）。在这里再查一遍 auth_identity，
       就是那第二处。 */
    const { rows } = await c.client.query<{ address: string }>(
      "SELECT address FROM app.login_destination($1)", [p.accountId]);
    const to = rows[0]?.address;
    if (!to)
      throw new ProblemException("invariant-violated", {
        invariant: "no-own-address",
        detail: "你自己还没有登记收件地址 —— 试发只发给本人，" +
          "所以先在账号台账里给自己登记一个（「设收件地址」）。" +
          "不接受在这里指定收件人：那样的「试发」就是一个开放的转发器。"
      });

    const cfg = await this.resolve();
    if (!cfg)
      throw new ProblemException("invariant-violated", {
        invariant: "mail-transport-none",
        detail: "还没有可用的投递通道 —— 先把上面那几栏填好并保存。"
      });

    try {
      await sendMail({ url: cfg.url, from: cfg.from }, {
        to,
        subject: "中心台：投递通道试发",
        text: [
          "这是一封试发信。",
          "",
          "收到它说明登录链接现在送得出去了 —— 忘记口令的人可以自己申请，",
          "不再需要能进服务器的人代发。",
          "",
          "没有别的意思，忽略即可。"
        ].join("\n")
      });
      await this.recordTest(true, null);
      return { ok: true, sentTo: mask(to), error: null };
    } catch (e) {
      /* **失败不抛**：它是一次诊断，不是一次事故。把原话原样交给页面 ——
         "认证失败"和"连不上"要采取的行动完全不同，压成一句"试发失败"
         等于让人自己去猜。 */
      const msg = e instanceof Error ? e.message : String(e);
      await this.recordTest(false, msg.slice(0, 500));
      return { ok: false, sentTo: mask(to), error: msg };
    }
  }
}
