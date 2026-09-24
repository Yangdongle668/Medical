-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   邮件提醒：系统主动找人，而不是等人上来看。

   ── 为什么 ──────────────────────────────────────────────────────────
   首页待办（/v1/me/inbox）把「要你动手的」排得很清楚 —— 前提是人打开了它。
   SAE 的 24 小时、访视窗口的最后一天、挂了一周的质疑，都不会等人想起来登录。
   原来系统只在派工与交接时发通知（NotifyService），其余一律沉默，
   于是这些事实际发生在微信群里，系统事后补记账。

   ── 发什么（口径在 apps/api/src/modules/workbench/remind.service.ts） ──
   **提醒的内容就是这个人的待办** —— 以他本人的身份跑一遍 inbox，
   不另写一套「什么算急」。两种邮件：
     · 紧急：SAE 时钟、今天关窗的访视 —— 到点就发，同一件事同一个档只发一次；
     · 每日摘要：工作日早上一封，列出已过期 / 今天 / 这几天各几件。

   ── 两张表 ──────────────────────────────────────────────────────────
   notify_pref  每个人一行：要不要摘要、要不要紧急提醒。没有这一行 = 都要。
   notify_sent  发过的记一笔 —— (人, 哪件事, 哪个档) 唯一。**去重在库里**：
                多副本同时跑、进程重启，都不会把同一件事发两遍。
   两张都只让本人读写（RLS）；后台任务以收件人本人的身份写，不开后门。
   ══════════════════════════════════════════════════════════════════════ */

CREATE TABLE notify_pref (
  account_id  uuid PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL DEFAULT app.default_tenant_id() REFERENCES tenant(id),
  digest      boolean NOT NULL DEFAULT true,
  urgent      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER notify_pref_touch BEFORE UPDATE ON notify_pref
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
COMMENT ON TABLE notify_pref IS
  '邮件提醒偏好。没有这一行等于全开 —— 默认要提醒，退订是人自己的选择。';

CREATE TABLE notify_sent (
  account_id  uuid NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL DEFAULT app.default_tenant_id() REFERENCES tenant(id),
  item_key    text NOT NULL,
  mark        text NOT NULL,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, item_key, mark)
);
COMMENT ON TABLE notify_sent IS
  '发过的提醒。item_key 是那件事（sae:<id> / visit:<id> / digest），mark 是档位'
  '（SAE 的 12h / 20h / 24h，摘要的日期）。主键保证同一件事同一个档只发一次。';
COMMENT ON COLUMN notify_sent.mark IS '档位：同一件事跨过下一个档会再发一次，同一个档不会。';
/* 清理用：只留九十天 —— 更早的去重记录不会再被用到（那些事早就不在待办里了）。 */
CREATE INDEX notify_sent_gc_idx ON notify_sent (sent_at);

ALTER TABLE notify_pref ENABLE ROW LEVEL SECURITY;
ALTER TABLE notify_sent ENABLE ROW LEVEL SECURITY;

/* 只有本人：偏好是私事，发送记录也是（它等于"这个人手上有哪些急事"的流水）。 */
CREATE POLICY notify_pref_own ON notify_pref FOR ALL
  USING (tenant_id = app.current_tenant_id() AND account_id = app.current_account_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND account_id = app.current_account_id());
CREATE POLICY notify_sent_own ON notify_sent FOR ALL
  USING (tenant_id = app.current_tenant_id() AND account_id = app.current_account_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND account_id = app.current_account_id());

/* ── 收件人名单 ─────────────────────────────────────────────────────
   后台任务在谁的身份都还没有的时候要知道「该给谁跑一遍」。
   SECURITY DEFINER，只吐出 id 与偏好 —— 地址照旧由 login_destination 在
   发送那一刻解析（与登录链接、交接通知同一条判定）。
   只给**有邮箱**的在用内部账号：外部角色默认不登录（0051），停用的登不进来。 */
CREATE FUNCTION app.notify_recipients()
  RETURNS TABLE (account_id uuid, digest boolean, urgent boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS
$$
  SELECT a.id, coalesce(p.digest, true), coalesce(p.urgent, true)
    FROM account a
    JOIN role r ON r.id = a.role_id
    LEFT JOIN notify_pref p ON p.account_id = a.id
   WHERE a.status = 'active' AND NOT r.is_external
     AND EXISTS (SELECT 1 FROM app.login_destination(a.id) d WHERE d.channel = 'email')
     AND (coalesce(p.digest, true) OR coalesce(p.urgent, true))
   ORDER BY a.id
$$;
REVOKE ALL ON FUNCTION app.notify_recipients() FROM public;
GRANT EXECUTE ON FUNCTION app.notify_recipients() TO sitedesk_app;

/* 九十天前的去重记录一并清掉 —— 挂在已有的清理任务上，不另起一个定时器。 */
CREATE FUNCTION app.gc_notify_sent(p_keep interval DEFAULT interval '90 days')
  RETURNS bigint
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, app, pg_temp AS
$$
DECLARE v bigint;
BEGIN
  DELETE FROM notify_sent WHERE sent_at < now() - p_keep;
  GET DIAGNOSTICS v = ROW_COUNT;
  RETURN v;
END $$;
REVOKE ALL ON FUNCTION app.gc_notify_sent(interval) FROM public;
GRANT EXECUTE ON FUNCTION app.gc_notify_sent(interval) TO sitedesk_app;

-- Down Migration
DROP FUNCTION IF EXISTS app.gc_notify_sent(interval);
DROP FUNCTION IF EXISTS app.notify_recipients();
DROP TABLE IF EXISTS notify_sent;
DROP TABLE IF EXISTS notify_pref;
