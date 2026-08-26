-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   登录链接的投递地址。

   0007 建 auth_identity 时就写下了这句：

     subject —— OIDC 的 sub；魔法链接则是收件地址（邮箱 / 手机）。

   位置一直留着，只是没有人往里写，也没有人读它 —— 因为通道还没做。
   这一支迁移把那条路接通：**收件地址由服务端解析，不由请求携带。**

   ── 为什么这件事必须在数据库这一侧解决 ────────────────────────────
   契约里 `sentTo` 的说明是"仅用于审计留痕"。通道做出来之后，如果顺手
   拿请求里那个字段当收件地址，这个公开端点立刻变成一键账号接管：

     POST /v1/auth/magic-link {"login":"lingyuan","sentTo":"我@攻击者"}

   所以签发与解析地址必须是**同一个** SECURITY DEFINER 调用：
   应用层拿不到"往哪送"的决定权，它只负责把信送到函数给出的地址。

   ── 为什么不新加一列，而用 auth_identity ──────────────────────────
   一个账号将来会有多个身份（OIDC 的 sub、邮箱、手机），auth_identity
   本来就是为此建的。往 account 上加一列 email，等于把"身份"这件事
   拆成两个地方存 —— 而两个地方迟早会不一致。

   ── 旧函数留着 ────────────────────────────────────────────────────
   `app.issue_login_token` 不删：规约 10 是"生产只进不退"，而更实在的
   理由是部署顺序 —— 先迁移、后换镜像，中间那段时间旧代码正打在新
   schema 上（见 README「一键更新」）。删掉它，那一段里所有登录请求都会 500。
   ══════════════════════════════════════════════════════════════════════ */

/* ── 签发 + 解析收件地址，一次完成 ─────────────────────────────────
   返回值刻意分成 issued / reason 两个：对外它们都对应同一个 202
   （否则又是账号枚举器），但服务端日志要分得清是"没这个人"
   还是"这个人没登记地址" —— 后者是运维该去补的一件事，
   而它在响应里是看不见的。 */
CREATE FUNCTION app.issue_login_link(
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
  IF p_ttl_minutes IS NULL OR p_ttl_minutes < 1 OR p_ttl_minutes > 15 THEN
    RAISE EXCEPTION '登录链接有效期必须在 1–15 分钟之间';
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

  /* 没有地址就**不签发**。签一把没人收得到的令牌只是往库里堆垃圾，
     而"什么都没发生"在对外行为上和签发过完全一样（都是 202）。 */
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

COMMENT ON FUNCTION app.issue_login_link(text,text,int) IS
  '签发一次性登录链接，并**由服务端**给出收件地址。'
  ' 收件地址绝不能来自请求：那样这个公开端点就是一键账号接管。';

REVOKE ALL ON FUNCTION app.issue_login_link(text,text,int) FROM public;
GRANT EXECUTE ON FUNCTION app.issue_login_link(text,text,int) TO sitedesk_app;

COMMENT ON COLUMN login_token.sent_to IS
  '实际投递到的地址（由 app.issue_login_link 解析）。**不是**调用方声称的那个。';

/* ── 登记 / 更换收件地址 ───────────────────────────────────────────
   auth_identity 带 RLS（本人或内部账号），而登记地址这件事发生在
   任何人登录之前 —— 和 0007 里签发令牌是同一个先有鸡先有蛋，同一个解法。

   一个账号只保留一个 magic-link 地址：多个的话，"到底往哪送"就成了
   一个要靠 ORDER BY 猜的问题，而猜错的后果是链接送给了前任。 */
CREATE FUNCTION app.set_login_address(p_login text, p_address text) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, app, pg_temp AS
$$
DECLARE
  v_account uuid;
  v_owner   uuid;
BEGIN
  /* 形状先验一遍。一个打错的地址不会报错，只会让那个人永远收不到链接，
     而他会以为是系统坏了。 */
  IF p_address IS NULL OR NOT (
       p_address ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' OR
       p_address ~ '^\+?[0-9][0-9 -]{5,19}$') THEN
    RAISE EXCEPTION '收件地址既不像邮箱也不像手机号：%', p_address;
  END IF;

  SELECT a.id INTO v_account FROM account a
   WHERE a.login = p_login AND a.status = 'active';
  IF v_account IS NULL THEN RETURN false; END IF;

  /* 这个地址已经属于别人时**报错，不是悄悄改绑**：
     悄悄改绑等于把那个人的登录入口转给了另一个账号。 */
  SELECT i.account_id INTO v_owner FROM auth_identity i
   WHERE i.provider = 'magic-link' AND i.subject = p_address;
  IF v_owner IS NOT NULL AND v_owner <> v_account THEN
    RAISE EXCEPTION '这个地址已经登记给另一个账号了，请先解除那一边';
  END IF;

  DELETE FROM auth_identity
   WHERE account_id = v_account AND provider = 'magic-link';
  INSERT INTO auth_identity (account_id, provider, subject)
  VALUES (v_account, 'magic-link', p_address);
  RETURN true;
END $$;

COMMENT ON FUNCTION app.set_login_address(text,text) IS
  '登记 / 更换某个账号的登录链接收件地址。运维工具用（apps/api/scripts/set-login-address.mjs）。';

REVOKE ALL ON FUNCTION app.set_login_address(text,text) FROM public;
/* 授给应用角色，理由与 app.issue_login_token 一致：能拿到这个连接串的人
   本来就能给任意账号签发一把自己知道明文的令牌 —— 这个函数不扩大那个面。
   HTTP 那一侧没有任何端点调它，它只有运维脚本一个调用方。 */
GRANT EXECUTE ON FUNCTION app.set_login_address(text,text) TO sitedesk_app;

-- Down Migration
DROP FUNCTION IF EXISTS app.set_login_address(text,text);
DROP FUNCTION IF EXISTS app.issue_login_link(text,text,int);
