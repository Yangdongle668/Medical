-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   两件互不相干、但都属于「写了一半」的事。

   ── 一、过期数据的清理（欠账 B2） ──────────────────────────────────
   0007 给 idempotency_key 写下的表注释是：

     24 小时保留，之后由清理任务删除。

   **那个清理任务不存在。** 表从上线第一天起只增不减，
   `idempotency_key_gc_idx` 这条为它建的索引也一直没人用过。
   login_token 与 auth_session 是同一个形状：用过的、过期的、撤销的，
   全都留着 —— 而它们存的是认证痕迹，留得越久越没有好处。

   为什么必须是 SECURITY DEFINER：这三张表都带 RLS，策略要求
   `account_id = app.current_account_id()`。清理任务不属于任何人，
   它没有身份可设 —— 用应用角色直接 DELETE 一行也删不掉，
   而且**不会报错**（RLS 过滤掉的行就当不存在），
   于是一个「跑了但什么也没删」的定时任务会安静地跑上一年。

   为什么带咨询锁：多副本时每个实例都会到点触发。同一秒里三个
   DELETE 扫同一批行，除了互相等锁没有任何好处。
   `pg_try_advisory_lock` 让抢不到的那两个直接跳过这一轮。

   ── 二、放宽登录链接的有效期上限（欠账 E4） ────────────────────────
   0007 把 15 分钟写成了**数据库约束**，理由是「链接会经过邮件网关、
   短信通道、可能被转发」。理由成立，但把它钉死在 schema 里过了头：
   有的客户内网邮件网关有几分钟的排队，15 分钟真的不够。

   上限放宽到 60 分钟，**默认仍然是 15**（在应用层）。
   放宽约束是向后兼容的：旧代码签发的 15 分钟令牌照样满足新约束。
   ══════════════════════════════════════════════════════════════════════ */

/* ── 一、清理 ────────────────────────────────────────────────────── */
CREATE FUNCTION app.gc_expired(
  p_idem_keep    interval DEFAULT interval '24 hours',
  p_token_keep   interval DEFAULT interval '7 days',
  p_session_keep interval DEFAULT interval '30 days'
) RETURNS TABLE (idem_deleted bigint, token_deleted bigint, session_deleted bigint)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, app, pg_temp AS
$$
DECLARE v_a bigint := 0; v_b bigint := 0; v_c bigint := 0;
BEGIN
  /* 抢不到就这一轮不扫。不等锁：等到手里的时候，抢到的那个早扫完了。
     锁号取一个固定常数，进程退出时自动释放。 */
  IF NOT pg_try_advisory_xact_lock(hashtext('sitedesk.gc_expired')) THEN
    RETURN QUERY SELECT -1::bigint, -1::bigint, -1::bigint;   -- -1 = 这轮跳过
    RETURN;
  END IF;

  /* 幂等键：已完成且过了保留期。**未完成的不删** ——
     那些是「正在处理中」，删掉等于允许同一把键被重放两次。 */
  DELETE FROM idempotency_key
   WHERE completed_at IS NOT NULL AND created_at < now() - p_idem_keep;
  GET DIAGNOSTICS v_a = ROW_COUNT;

  /* 登录令牌：过期或已用过，且过了保留期。
     保留一段时间是为了让审计问得出「那条链接是什么时候被兑换的」。 */
  DELETE FROM login_token
   WHERE (used_at IS NOT NULL OR expires_at < now())
     AND issued_at < now() - p_token_keep;
  GET DIAGNOSTICS v_b = ROW_COUNT;

  /* 会话：过期或已撤销，且过了保留期。 */
  DELETE FROM auth_session
   WHERE (revoked_at IS NOT NULL OR expires_at < now())
     AND issued_at < now() - p_session_keep;
  GET DIAGNOSTICS v_c = ROW_COUNT;

  RETURN QUERY SELECT v_a, v_b, v_c;
END $$;

COMMENT ON FUNCTION app.gc_expired(interval,interval,interval) IS
  '清理过期的幂等键 / 登录令牌 / 会话。带咨询锁，多副本下同一轮只有一个实例真扫。'
  ' 返回 -1 表示这一轮没抢到锁（不是没删到东西）。';

REVOKE ALL ON FUNCTION app.gc_expired(interval,interval,interval) FROM public;
GRANT EXECUTE ON FUNCTION app.gc_expired(interval,interval,interval) TO sitedesk_app;

COMMENT ON TABLE idempotency_key IS
  '24 小时保留，之后由 app.gc_expired() 删除（由 API 进程定时调用，见 infra/gc.ts）。
   request_hash 用于识别「同一把钥匙开不同的门」—— 那是客户端 bug，
   必须报错而不是静默返回上一次的结果。';

/* ── 二、有效期上限 ──────────────────────────────────────────────── */
ALTER TABLE login_token DROP CONSTRAINT login_token_max_ttl;
ALTER TABLE login_token ADD CONSTRAINT login_token_max_ttl
  CHECK (expires_at <= issued_at + interval '60 minutes');
COMMENT ON CONSTRAINT login_token_max_ttl ON login_token IS
  '上限，不是建议：链接会经过邮件网关、短信通道、可能被转发。默认仍是 15 分钟（应用层）。';

/* 两个签发函数里同样写死了 15，一并放宽 —— 只改约束不改函数的话，
   配置放宽之后会撞在一句「有效期必须在 1–15 分钟之间」上，
   而那句话来自哪里要找一会儿。 */
CREATE OR REPLACE FUNCTION app.issue_login_token(
  p_login text, p_token_hash text, p_ttl_minutes int, p_sent_to text
) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, app, pg_temp AS
$$
DECLARE v_account uuid;
BEGIN
  IF p_ttl_minutes IS NULL OR p_ttl_minutes < 1 OR p_ttl_minutes > 60 THEN
    RAISE EXCEPTION '登录链接有效期必须在 1–60 分钟之间';
  END IF;
  SELECT id INTO v_account FROM account WHERE login = p_login AND status = 'active';
  IF v_account IS NULL THEN RETURN false; END IF;
  INSERT INTO login_token (account_id, token_hash, expires_at, sent_to)
  VALUES (v_account, p_token_hash,
          now() + (p_ttl_minutes || ' minutes')::interval, p_sent_to);
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION app.issue_login_link(
  p_login text, p_token_hash text, p_ttl_minutes int
) RETURNS TABLE (issued boolean, reason text, channel text,
                 destination text, display_name text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, app, pg_temp AS
$$
DECLARE
  v_account uuid;
  v_name    text;
  v_dest    text;
BEGIN
  IF p_ttl_minutes IS NULL OR p_ttl_minutes < 1 OR p_ttl_minutes > 60 THEN
    RAISE EXCEPTION '登录链接有效期必须在 1–60 分钟之间';
  END IF;

  SELECT a.id, a.display_name INTO v_account, v_name
    FROM account a WHERE a.login = p_login AND a.status = 'active';
  IF v_account IS NULL THEN
    RETURN QUERY SELECT false, 'no-account', NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  SELECT i.subject INTO v_dest
    FROM auth_identity i
   WHERE i.account_id = v_account AND i.provider = 'magic-link'
   ORDER BY i.created_at DESC
   LIMIT 1;

  IF v_dest IS NULL THEN
    RETURN QUERY SELECT false, 'no-destination', NULL::text, NULL::text, v_name;
    RETURN;
  END IF;

  INSERT INTO login_token (account_id, token_hash, expires_at, sent_to)
  VALUES (v_account, p_token_hash,
          now() + (p_ttl_minutes || ' minutes')::interval, v_dest);

  RETURN QUERY SELECT true, 'ok',
    CASE WHEN position('@' in v_dest) > 0 THEN 'email' ELSE 'sms' END,
    v_dest, v_name;
END $$;

-- Down Migration
DROP FUNCTION IF EXISTS app.gc_expired(interval,interval,interval);
ALTER TABLE login_token DROP CONSTRAINT login_token_max_ttl;
ALTER TABLE login_token ADD CONSTRAINT login_token_max_ttl
  CHECK (expires_at <= issued_at + interval '15 minutes');
