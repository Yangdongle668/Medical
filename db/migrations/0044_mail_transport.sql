-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   登录链接的投递通道：从环境变量搬进系统里。

   ── 这一格一直是空的，而它自己写着这件事 ────────────────────────────
   login-delivery.ts 的 NO_CHANNEL_WARNING 原话：

       系统仍然会签发令牌，但没有人收得到 —— 只能由能进服务器的人跑
       deploy/login-link.sh 代发，也就是说**签发权限等同于运维权限**。
       这是上线前该补掉的一项。

   通道本身早就写好了（SMTP 客户端、重试、掩码日志一应俱全），
   缺的是**填它的地方**：SITEDESK_SMTP_URL 只能由能改环境变量、
   能重启进程的人来设。于是一套装好的系统里，管理员建得了账号、
   设得了口令、登记得了收件地址，**唯独没法让链接真的发出去**。

   ── 口令要落库，这是本仓库第一个"可还原的密文" ──────────────────────
   `auth_password` 存的是哈希 —— 不可还原，泄漏了也登不进去。
   SMTP 口令不一样：它必须被还原出来才能用。所以：

   · 库里存的是 **AES-256-GCM 密文**（infra/secret.ts），
     密钥来自 `SITEDESK_SECRET_KEY`，只在进程内存里；
   · 没有配这个密钥时，**拒绝保存口令**并说清为什么 ——
     而不是悄悄存明文。一份会进备份、进从库、进 dump 的明文口令，
     比"这个功能暂时不能用"糟得多；
   · 密文**永不出服务层**。契约里那一栏是 `secretSet: boolean`，
     不是口令本身 —— 一个能把口令读回来的设置页，
     等于给所有管理员发了一份邮箱凭证。

   ── 为什么按租户存 ──────────────────────────────────────────────────
   每个 CRO 有自己的邮件服务器与发件人域名。而"用谁的服务器发"
   决定了那封信从哪儿来 —— 这不是显示偏好，是收件方的信任来源。

   ── 环境变量没有作废 ────────────────────────────────────────────────
   库里没配时回退到 env（见 login-delivery.ts）。理由是：
   第一个租户开出来之前没有人能登进来配它 —— 那是另一个死锁。
   env 是开机的那条路，库里那份是日常运营的那条路。
   ══════════════════════════════════════════════════════════════════════ */

CREATE TABLE mail_transport (
  tenant_id       uuid PRIMARY KEY DEFAULT app.default_tenant_id() REFERENCES tenant(id),
  /* none = 明确关掉（不是"没配"）。两者在页面上要分得开：
     "还没配"是待办，"关掉了"是决定。 */
  kind            text NOT NULL DEFAULT 'none' CHECK (kind IN ('smtp', 'none')),
  /* smtp://host:port 或 smtps://host:port —— **不含口令**。
     口令走 secret_enc，免得它跟着 URL 一起进日志、进报错。 */
  url             text,
  from_addr       text,
  username        text,
  /** AES-256-GCM 密文，见 apps/api/src/infra/secret.ts。永不出服务层。 */
  secret_enc      text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES account(id),
  /* 最近一次试发。**设置页必须能自己验一次** ——
     否则"配好了"这件事要等第一个真人申请登录链接时才知道真假，
     而那时候没收到的人不会来报，他只会以为系统坏了。 */
  last_test_at    timestamptz,
  last_test_ok    boolean,
  last_test_error text,
  CONSTRAINT mail_transport_smtp_complete CHECK (
    kind <> 'smtp' OR (url IS NOT NULL AND from_addr IS NOT NULL))
);

COMMENT ON TABLE mail_transport IS
  '登录链接与通知的投递通道，一租户一行。secret_enc 是 AES-256-GCM 密文，
   永不出服务层 —— 契约里只有 secretSet: boolean。库里没配时回退到环境变量。';

ALTER TABLE mail_transport ENABLE ROW LEVEL SECURITY;
/* 外部方（机构办 / PI）一行都看不到：这是我方的基础设施配置。
   "只有管理员能改"那一层由动作权限 manage 管（与全仓一致），
   策略这一层管的是租户与内外之别。 */
CREATE POLICY mail_transport_scope ON mail_transport FOR ALL
  USING (tenant_id = app.current_tenant_id() AND NOT app.current_is_external())
  WITH CHECK (tenant_id = app.current_tenant_id() AND NOT app.current_is_external());

-- Down Migration
DROP POLICY IF EXISTS mail_transport_scope ON mail_transport;
DROP TABLE IF EXISTS mail_transport;
