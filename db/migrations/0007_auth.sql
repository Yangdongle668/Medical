-- Up Migration
-- ════════════════════════════════════════════════════════════════════
-- 认证与幂等
--
-- Phase 0 §9.3 的决定：
--   内部员工 → OIDC（企业微信 / 飞书）
--   外部方（机构办 / PI）→ 一次性魔法链接，15 分钟有效、单次使用
--
-- account 表刻意不设密码列。这里也一样：**令牌只存哈希，绝不存明文**。
-- 数据库被拖库时，明文令牌等于把所有人的会话一起交出去。
-- ════════════════════════════════════════════════════════════════════

/* ── 外部身份 → 账号 ─────────────────────────────────────────────── */
CREATE TABLE auth_identity (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL DEFAULT app.default_tenant_id() REFERENCES tenant(id),
  account_id   uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  provider     text NOT NULL CHECK (provider IN ('oidc', 'magic-link', 'dev')),
  subject      text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  UNIQUE (provider, subject)
);
COMMENT ON COLUMN auth_identity.subject IS
  'OIDC 的 sub；魔法链接则是收件地址（邮箱 / 手机）。一个账号可以有多个身份。';
CREATE INDEX auth_identity_account_idx ON auth_identity (account_id);

/* ── 一次性登录链接 ──────────────────────────────────────────────── */
CREATE TABLE login_token (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL DEFAULT app.default_tenant_id() REFERENCES tenant(id),
  account_id   uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  issued_at    timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  sent_to      text,
  CONSTRAINT login_token_ttl CHECK (expires_at > issued_at),
  /* 15 分钟是上限，不是建议：链接会经过邮件网关、短信通道、可能被转发 */
  CONSTRAINT login_token_max_ttl CHECK (expires_at <= issued_at + interval '15 minutes')
);
COMMENT ON COLUMN login_token.token_hash IS
  '仅存 SHA-256。明文只在生成的那一刻存在于内存里，随链接发出后即丢弃。';
CREATE INDEX login_token_live_idx ON login_token (account_id) WHERE used_at IS NULL;

/* ── 会话 ───────────────────────────────────────────────────────── */
CREATE TABLE auth_session (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL DEFAULT app.default_tenant_id() REFERENCES tenant(id),
  account_id   uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  issued_at    timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  revoke_reason text,
  user_agent   text,
  CONSTRAINT auth_session_ttl CHECK (expires_at > issued_at)
);
CREATE INDEX auth_session_account_idx ON auth_session (account_id)
  WHERE revoked_at IS NULL;
COMMENT ON TABLE auth_session IS
  '不可撤销的无状态令牌对外部方不合适：机构老师离职、PI 换人都要能立刻断开。';

/* ── 幂等键 ─────────────────────────────────────────────────────── */
-- CRC 在地下室提交一次访视，信号断了，客户端重发 —— 不能记两笔工时。
CREATE TABLE idempotency_key (
  key             uuid NOT NULL,
  tenant_id       uuid NOT NULL DEFAULT app.default_tenant_id() REFERENCES tenant(id),
  account_id      uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  endpoint        text NOT NULL,
  request_hash    text NOT NULL,
  response_status int,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  PRIMARY KEY (key, account_id)
);
COMMENT ON TABLE idempotency_key IS
  '24 小时保留，之后由清理任务删除。request_hash 用于识别「同一把钥匙开不同的门」——
   那是客户端 bug，必须报错而不是静默返回上一次的结果。';
CREATE INDEX idempotency_key_gc_idx ON idempotency_key (created_at);

/* ── RLS：这些表只允许本人相关的行 ─────────────────────────────── */
ALTER TABLE auth_identity   ENABLE ROW LEVEL SECURITY;
ALTER TABLE login_token     ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_session    ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_key ENABLE ROW LEVEL SECURITY;

CREATE POLICY auth_identity_self ON auth_identity FOR ALL
  USING (tenant_id = app.current_tenant_id()
         AND (account_id = app.current_account_id() OR NOT app.current_is_external()))
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY login_token_self ON login_token FOR ALL
  USING (tenant_id = app.current_tenant_id() AND account_id = app.current_account_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY auth_session_self ON auth_session FOR ALL
  USING (tenant_id = app.current_tenant_id() AND account_id = app.current_account_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY idempotency_self ON idempotency_key FOR ALL
  USING (tenant_id = app.current_tenant_id() AND account_id = app.current_account_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND account_id = app.current_account_id());

/* ── 认证解析：先有鸡先有蛋的解法 ──────────────────────────────────
   auth_session 自带 RLS（account_id = current_account_id），
   而 current_account_id 恰恰要靠查 auth_session 才能知道。
   与 app.current_row_rule() 同一手法：SECURITY DEFINER 绕过策略，
   但只暴露「令牌 → 账号」这一个最小能力，不返回任何别的字段。 */
CREATE FUNCTION app.resolve_session(p_token_hash text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS
$$
  SELECT s.account_id
    FROM auth_session s JOIN account a ON a.id = s.account_id
   WHERE s.token_hash = p_token_hash
     AND s.revoked_at IS NULL
     AND s.expires_at > now()
     AND a.status = 'active'
$$;

/* 兑换一次性登录链接。**在数据库里原子完成**：
   并发的两次兑换只有一次能拿到账号，另一次拿到 NULL。
   放在应用层做「先查再改」，两个请求同时到达就会双双成功。 */
CREATE FUNCTION app.consume_login_token(p_token_hash text) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, app, pg_temp AS
$$
DECLARE v_account uuid;
BEGIN
  UPDATE login_token t
     SET used_at = now()
   WHERE t.token_hash = p_token_hash
     AND t.used_at IS NULL
     AND t.expires_at > now()
     AND EXISTS (SELECT 1 FROM account a WHERE a.id = t.account_id AND a.status = 'active')
  RETURNING t.account_id INTO v_account;
  RETURN v_account;
END $$;

/* 登录名 → 账号。签发登录链接时需要，而此刻还没有身份可设。
   刻意只返回 id，不返回姓名、角色、机构 —— 最小暴露面。
   调用它的端点对「账号存在」与「不存在」返回完全相同的响应，
   因此它不构成账号枚举通道。 */
CREATE FUNCTION app.resolve_login(p_login text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS
$$ SELECT id FROM account WHERE login = p_login AND status = 'active' $$;

/* 签发登录链接发生在**认证之前**：此刻 app.account_id 尚未设置，
   而 login_token 的 RLS 要求 account_id = current_account_id() —— 插不进去。
   两种解法：临时把 app.account_id 设成目标账号（等于给未认证请求提权），
   或把「解析 + 插入」收进一个 SECURITY DEFINER 函数。取后者：
   它不改变会话状态，暴露面仅限于「是否签发成功」这一个布尔值。 */
CREATE FUNCTION app.issue_login_token(
  p_login text, p_token_hash text, p_ttl_minutes int, p_sent_to text
) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, app, pg_temp AS
$$
DECLARE v_account uuid;
BEGIN
  IF p_ttl_minutes IS NULL OR p_ttl_minutes < 1 OR p_ttl_minutes > 15 THEN
    RAISE EXCEPTION '登录链接有效期必须在 1–15 分钟之间';
  END IF;
  SELECT id INTO v_account FROM account WHERE login = p_login AND status = 'active';
  IF v_account IS NULL THEN RETURN false; END IF;
  INSERT INTO login_token (account_id, token_hash, expires_at, sent_to)
  VALUES (v_account, p_token_hash,
          now() + (p_ttl_minutes || ' minutes')::interval, p_sent_to);
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION app.issue_login_token(text,text,int,text)    FROM public;
GRANT EXECUTE ON FUNCTION app.issue_login_token(text,text,int,text) TO sitedesk_app;
REVOKE ALL ON FUNCTION app.resolve_login(text)        FROM public;
GRANT EXECUTE ON FUNCTION app.resolve_login(text)     TO sitedesk_app;
REVOKE ALL ON FUNCTION app.resolve_session(text)      FROM public;
REVOKE ALL ON FUNCTION app.consume_login_token(text)  FROM public;
GRANT EXECUTE ON FUNCTION app.resolve_session(text)     TO sitedesk_app;
GRANT EXECUTE ON FUNCTION app.consume_login_token(text) TO sitedesk_app;

-- Down Migration
DROP FUNCTION IF EXISTS app.issue_login_token(text,text,int,text);
DROP FUNCTION IF EXISTS app.resolve_login(text);
DROP FUNCTION IF EXISTS app.consume_login_token(text);
DROP FUNCTION IF EXISTS app.resolve_session(text);
DROP TABLE IF EXISTS idempotency_key;
DROP TABLE IF EXISTS auth_session;
DROP TABLE IF EXISTS login_token;
DROP TABLE IF EXISTS auth_identity;
