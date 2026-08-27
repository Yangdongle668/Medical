-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   业务通知的收件地址解析（欠账 D5：交接不发通知）。

   `app.issue_login_link()` 里已经有一段"从 auth_identity 找收件地址"的逻辑，
   但它和签发令牌绑在一起 —— 交接通知没有令牌可签。
   把那一段单独拿出来，两处共用同一个判定：
   **只认库里登记的那个地址**，绝不用调用方传的。

   为什么必须 SECURITY DEFINER：通知发生在业务事务的尾巴上，
   此刻的行范围是**发起人**的，而收件人未必在他的范围里 ——
   `auth_identity` 的 RLS 只放行本人。
   给它 SECURITY DEFINER 不扩大任何范围：它只回答"这个账号的地址是什么"，
   而调用方要有那个 account_id 才问得出来。

   通道由地址形状推断，与 issue_login_link 同一条判定（有 @ 就是邮件）。
   两处写两遍的话，哪天有人改了一处，同一个人的登录链接走邮件、
   通知走短信 —— 而没有任何报错。
   ══════════════════════════════════════════════════════════════════════ */

CREATE FUNCTION app.login_destination(p_account uuid)
  RETURNS TABLE (channel text, address text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS
$$
  SELECT CASE WHEN position('@' in i.subject) > 0 THEN 'email' ELSE 'sms' END,
         i.subject
    FROM auth_identity i
    JOIN account a ON a.id = i.account_id
   WHERE i.account_id = p_account
     AND i.provider = 'magic-link'
     /* 停用的账号不发通知：他登不进来，发过去只是噪音 —— 而噪音会让
        真正该看的通知被忽略。 */
     AND a.status = 'active'
   ORDER BY i.created_at DESC
   LIMIT 1
$$;

COMMENT ON FUNCTION app.login_destination(uuid) IS
  '账号的收件地址与通道。与 app.issue_login_link 同一条判定 —— 两处分开写必然漂移。';

REVOKE ALL ON FUNCTION app.login_destination(uuid) FROM public;
GRANT EXECUTE ON FUNCTION app.login_destination(uuid) TO sitedesk_app;

-- Down Migration
DROP FUNCTION IF EXISTS app.login_destination(uuid);
