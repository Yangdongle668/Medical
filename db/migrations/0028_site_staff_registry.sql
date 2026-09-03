-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   备案名册：这个中心上，都有谁在干活。

   ── 为什么不能直接查 staff ────────────────────────────────────────
   `staff_scope`（迁移 0008）对外部方是**整表关闭**的：

     USING (tenant_id = ... AND NOT app.current_is_external())

   那一条是对的，而且要保留 —— 员工名册（谁带谁、谁接谁、几级、
   在哪个城市、为什么停用）是我方的人事账，机构办看它没有道理。

   但机构办有一件必须做的事：**备案**。哪个 CRC 在我院这几个项目上
   出现，他的 GCP 证书还有效吗 —— 证书过期的人不得开展工作，
   这不是我方的内部管理，是机构履行监管职责的一部分。
   现在这件事只能靠邮件和微信问，问到的答案没有出处。

   ── 于是分开两件事 ────────────────────────────────────────────────
   「一片数据」（整本名册）继续锁着；
   「一个问题」（我看得到的中心上有谁、证书何时到期）单独开一个口子。
   这正是 SECURITY DEFINER 的用法，和 app.revoke_sessions 同一个道理。

   ── 开的口子有多大，逐列说清 ──────────────────────────────────────
   给：姓名、工种、GCP 到期日、是否在职、在哪几个中心、从哪天起。
   不给：登录名、职级、城市、带教人、继任者、停用原因、
         以及**本行范围之外的中心数** —— 最后这条最容易漏：
         `staff.siteCount` 数的是全部派工，机构办拿到它就知道了
         这个 CRC 在别家医院还带着几个中心。那是别人的事。
         所以这里的中心列表和计数**都在范围内重新算**。

   收敛仍然走 app.site_visible ——SECURITY DEFINER 绕开的是
   staff / account 两张表的策略，**不是行范围**。机构办依然只看本院，
   PI 依然只看自己的中心，CRA 依然只看被指派的。

   ── 为什么只有 CRA / CRC ──────────────────────────────────────────
   site_assignment 里就只有这两个工种（0004 的 CHECK 约束）。
   PI 是医院自己的人，他的证书归医院管，我方手里那份不会更新 ——
   把一列永远为空的 GCP 摆在备案表上，比不摆更糟。
   ══════════════════════════════════════════════════════════════════════ */
CREATE FUNCTION app.site_staff_registry()
  RETURNS TABLE (
    account_id    uuid,
    display_name  text,
    role_kind     text,
    gcp_expires_on date,
    active        boolean,
    study_site_id uuid,
    site_code     text,
    hospital      text,
    study_short   text,
    since         date
  )
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS
$$
  SELECT a.id, a.display_name, sa.role_kind, st.gcp_expires_on,
         a.status = 'active', s.id, s.code, s.hospital, sy.short_name,
         lower(sa.effective)
    FROM site_assignment sa
    JOIN study_site s ON s.id = sa.study_site_id
    JOIN study     sy ON sy.id = s.study_id
    JOIN account    a ON a.id = sa.account_id
    LEFT JOIN staff st ON st.account_id = sa.account_id
   WHERE sa.tenant_id = app.current_tenant_id()
     AND sa.effective @> CURRENT_DATE
     AND app.site_visible(s.id, s.study_id, s.hospital, s.pi_account_id)
$$;
COMMENT ON FUNCTION app.site_staff_registry() IS
  '按行范围收敛的备案名册：可见中心上的在岗 CRA/CRC，只给备案要用的那几列。
   走 SECURITY DEFINER 是因为 staff 的策略对外部方整表关闭 —— 那一条要保留，
   机构办要的不是名册，是"我院这几个中心上有谁、证书什么时候过期"。';

REVOKE ALL ON FUNCTION app.site_staff_registry() FROM public;
GRANT EXECUTE ON FUNCTION app.site_staff_registry() TO sitedesk_app;

-- Down Migration
DROP FUNCTION IF EXISTS app.site_staff_registry();
