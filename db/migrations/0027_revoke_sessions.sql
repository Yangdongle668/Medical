-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   撤销某个账号的会话。

   ── 为什么需要一个函数 ────────────────────────────────────────────
   `auth_session` 的策略是「只看得到自己那些」（迁移 0007）：

     USING (tenant_id = ... AND account_id = app.current_account_id())

   对本人来说这是对的。但管理员给别人重设口令时也要断开对方的会话 ——
   那句 UPDATE 以管理员的身份跑，策略把它限在管理员自己的会话上，
   于是**匹配到 0 行，一个错都不报**。口令换了、旧会话还开着，
   而接口返回 204，界面显示成功。

   这是 RLS 最难发现的一种失败：不是拒绝，是安静地少做。

   ── 为什么不是"给管理员放宽策略" ──────────────────────────────────
   放宽的话，拿着 manage 的人从此能读到所有人的会话令牌哈希、
   最近登录的 UA 与时间。那是一整个新的暴露面，
   而这里需要的只是**一个动作**：把某人的会话关掉。
   SECURITY DEFINER 函数正是用来把"一个动作"和"一片数据"分开的。

   ── keep 参数 ─────────────────────────────────────────────────────
   本人改自己的口令时要留下当前这一个 —— 把自己一起踢掉，
   人改完密码就被弹回登录页，会以为改失败了然后再改一遍。
   ══════════════════════════════════════════════════════════════════════ */
CREATE FUNCTION app.revoke_sessions(
  p_account uuid, p_reason text, p_keep_token_hash text DEFAULT NULL
) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, app, pg_temp AS
$$
DECLARE v_n integer;
BEGIN
  UPDATE auth_session
     SET revoked_at = now(), revoke_reason = p_reason
   WHERE account_id = p_account
     AND revoked_at IS NULL
     AND (p_keep_token_hash IS NULL OR token_hash <> p_keep_token_hash);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
COMMENT ON FUNCTION app.revoke_sessions(uuid, text, text) IS
  '断开某个账号的会话。keep_token_hash 留下当前这一个（本人改密时用）。
   走 SECURITY DEFINER 是因为 auth_session 的策略只允许本人 —— 管理员那句
   UPDATE 会匹配到 0 行而不报错，口令换了旧会话还开着。';

REVOKE ALL ON FUNCTION app.revoke_sessions(uuid, text, text) FROM public;
GRANT EXECUTE ON FUNCTION app.revoke_sessions(uuid, text, text) TO sitedesk_app;

-- Down Migration
DROP FUNCTION IF EXISTS app.revoke_sessions(uuid, text, text);
