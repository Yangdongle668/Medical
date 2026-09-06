-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   `app.set_login_address` 多了一个调用方：HTTP。

   `POST /v1/accounts/{id}:set-login-address`（`setLoginAddress`，需 manage）
   与运维脚本 `apps/api/scripts/set-login-address.mjs` 走**同一个函数** ——
   校验写两遍迟早对不上，而对不上的那天没人知道该信哪一条。

   ── 为什么 HTTP 那一侧现在可以调 ──────────────────────────────────
   原来的理由是"改地址等同于运维权限，所以要求能进服务器"。
   但管理员本来就能用 `setAccountPassword` 接管任何账号，
   两者一样悄无声息 —— 那道"要能进服务器"的门拦不住已经有 manage 的人，
   只拦住了正常的运营：新建的机构办 / PI 账号**没有入口**，
   而链接恰恰是为这两类人设计的登录方式。

   所以处置与迁移 0026 对「管理员给自己加 subject 字段」的处置一致：
   **不是拦住他，是让这件事留下时间和人** —— manage 动作、进审计轨迹。

   ── 这一开，函数原来那条"按登录名找账号"就不够了 ──────────────────
   `account` 上的唯一约束是 **UNIQUE (tenant_id, login)** —— 登录名
   只在租户内唯一。而函数是 SECURITY DEFINER，它那句

     SELECT a.id INTO v_account FROM account a
      WHERE a.login = p_login AND a.status = 'active';

   不受 RLS 管，也没有租户条件。两个租户各有一个 `zhanghm` 时，
   `SELECT INTO` **取第一行，不报错** —— 于是一个租户的管理员可以把
   自己的邮箱登记到另一个租户的同名账号上，再去登录页申请一次性链接。
   那是跨租户接管，而且全程一声不响。

   今天撞不上：`tenant` 表只有一行，`app.default_tenant_id()` 是个常量。
   **但"今天只有一个租户"不是一道防线**，它是一个恰好成立的事实；
   多租户改造那天，这里不会有任何东西报警。
   而在此之前它一直只有运维脚本一个调用方 —— 能进服务器的人
   本来就能连库改任意行，所以那时这句话是够的；现在不够了。

   一行补上：

     AND a.tenant_id = coalesce(app.current_tenant_id(), a.tenant_id)

   HTTP 那一侧每个请求都 `SET LOCAL app.account_id`，于是
   `app.current_tenant_id()` 有值，查找被钉在**调用者自己的租户**里。
   运维脚本不设会话主体，它是 NULL，coalesce 让条件恒真 ——
   那条路的行为一个字没变（它本来就等同于运维权限）。

   ── 没动的地方 ────────────────────────────────────────────────────
   "这个地址是不是已经属于别人"那一条**照旧跨租户查**，这是对的：
   一次性链接是按地址反查账号的，同一个邮箱落在两个租户的两个账号上，
   "到底登进哪一个"就成了要靠 ORDER BY 猜的问题。
   地址形状校验、一个账号只留一个地址、已属于别人则报错不改绑 —— 三条都还在。
   ══════════════════════════════════════════════════════════════════════ */

CREATE OR REPLACE FUNCTION app.set_login_address(p_login text, p_address text)
  RETURNS boolean
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

  /* 登录名只在租户内唯一（UNIQUE (tenant_id, login)）。
     有会话主体时钉在调用者自己的租户里；运维脚本没有会话主体，
     coalesce 让条件恒真 —— 详见本迁移开头。 */
  SELECT a.id INTO v_account FROM account a
   WHERE a.login = p_login AND a.status = 'active'
     AND a.tenant_id = coalesce(app.current_tenant_id(), a.tenant_id);
  IF v_account IS NULL THEN RETURN false; END IF;

  /* 这个地址已经属于别人时**报错，不是悄悄改绑**：
     悄悄改绑等于把那个人的登录入口转给了另一个账号。
     这一条有意跨租户 —— 链接是按地址反查账号的。 */
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
  '登记 / 更换某个账号的登录链接收件地址。两个调用方：'
  '运维脚本 apps/api/scripts/set-login-address.mjs，'
  '与 HTTP 端点 setLoginAddress（POST /v1/accounts/{id}:set-login-address，需 manage）。'
  '按登录名查找时钉在调用者租户内（无会话主体时不限，供运维脚本用）。';

-- Down Migration
/* 回到 0015 那一版：没有租户条件，注释里也只认运维脚本一个调用方。 */
CREATE OR REPLACE FUNCTION app.set_login_address(p_login text, p_address text)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, app, pg_temp AS
$$
DECLARE
  v_account uuid;
  v_owner   uuid;
BEGIN
  IF p_address IS NULL OR NOT (
       p_address ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' OR
       p_address ~ '^\+?[0-9][0-9 -]{5,19}$') THEN
    RAISE EXCEPTION '收件地址既不像邮箱也不像手机号：%', p_address;
  END IF;

  SELECT a.id INTO v_account FROM account a
   WHERE a.login = p_login AND a.status = 'active';
  IF v_account IS NULL THEN RETURN false; END IF;

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
