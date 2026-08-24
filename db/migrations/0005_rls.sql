-- Up Migration
-- ════════════════════════════════════════════════════════════════════
-- 行级安全 —— 兜底，不是主要手段。
--
-- 主要手段是 packages/policy 在查询层注入范围。RLS 存在的意义是：
-- 即使有人绕过应用层写了裸 SQL，也拿不到不该拿的行。
--
-- 两个前提，缺一个 RLS 就是摆设：
--   ① 应用必须用非 owner 角色（sitedesk_app）连接 —— owner 默认绕过 RLS
--   ② 每个请求必须 SET LOCAL app.account_id —— 未设置时一行都看不到（fail-closed）
-- ════════════════════════════════════════════════════════════════════

-- ── 会话主体 ────────────────────────────────────────────────────────
CREATE FUNCTION app.current_account_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT nullif(current_setting('app.account_id', true), '')::uuid $$;
COMMENT ON FUNCTION app.current_account_id() IS
  '由应用在每个请求开始时 SET LOCAL app.account_id。未设置返回 NULL —— 所有策略随之为假。';

-- 以下三个读 account/role。它们是 SECURITY DEFINER（owner 身份执行），
-- 因此不受 account 表自身 RLS 影响，也就不会与策略互相递归。
CREATE FUNCTION app.current_row_rule() RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS
$$ SELECT r.row_rule
     FROM account a JOIN role r ON r.id = a.role_id
    WHERE a.id = app.current_account_id() AND a.status = 'active' $$;

CREATE FUNCTION app.current_team_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS
$$ SELECT a.team_id FROM account a
    WHERE a.id = app.current_account_id() AND a.status = 'active' $$;

CREATE FUNCTION app.current_org_ref() RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS
$$ SELECT a.org_ref FROM account a
    WHERE a.id = app.current_account_id() AND a.status = 'active' $$;

CREATE FUNCTION app.current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS
$$ SELECT a.tenant_id FROM account a
    WHERE a.id = app.current_account_id() AND a.status = 'active' $$;

CREATE FUNCTION app.current_is_external() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS
$$ SELECT coalesce(a.is_external, true) FROM account a
    WHERE a.id = app.current_account_id() AND a.status = 'active' $$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO sitedesk_app;

-- ── 行可见性：五条规则的唯一判定处 ──────────────────────────────────
-- 直接以谓词写进策略（而不是包成一个查 study_site 的函数），避免策略递归。
CREATE FUNCTION app.site_visible(p_site_id uuid, p_study_id uuid,
                                 p_hospital text, p_pi_account_id uuid)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS
$$
  SELECT CASE app.current_row_rule()
    WHEN 'all'  THEN true
    WHEN 'none' THEN false
    WHEN 'team' THEN EXISTS (
      SELECT 1 FROM team_study ts
       WHERE ts.study_id = p_study_id AND ts.team_id = app.current_team_id())
    WHEN 'assigned' THEN EXISTS (
      SELECT 1 FROM site_assignment sa
       WHERE sa.study_site_id = p_site_id
         AND sa.account_id = app.current_account_id()
         AND sa.effective @> CURRENT_DATE)
    WHEN 'hospital' THEN p_hospital = app.current_org_ref()
    WHEN 'pi'       THEN p_pi_account_id = app.current_account_id()
    ELSE false
  END
$$;
COMMENT ON FUNCTION app.site_visible IS
  '五条行范围规则的唯一实现。packages/policy 里的 rowScope() 必须与它等价，
   并由一组共享测试用例双向验证 —— 两处实现不一致就是数据泄漏。';

-- ── study_site ──────────────────────────────────────────────────────
ALTER TABLE study_site ENABLE ROW LEVEL SECURITY;
CREATE POLICY study_site_scope ON study_site FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND app.site_visible(id, study_id, hospital, pi_account_id))
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND app.site_visible(id, study_id, hospital, pi_account_id));

-- ── study：只要有一个中心可见，这个项目就可见 ───────────────────────
ALTER TABLE study ENABLE ROW LEVEL SECURITY;
CREATE POLICY study_scope ON study FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND (app.current_row_rule() = 'all' OR EXISTS (
      SELECT 1 FROM study_site s
       WHERE s.study_id = study.id
         AND app.site_visible(s.id, s.study_id, s.hospital, s.pi_account_id))))
  WITH CHECK (tenant_id = app.current_tenant_id());

-- ── site_assignment：看得到中心，或者是自己的派工 ───────────────────
ALTER TABLE site_assignment ENABLE ROW LEVEL SECURITY;
CREATE POLICY site_assignment_scope ON site_assignment FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND (account_id = app.current_account_id() OR EXISTS (
      SELECT 1 FROM study_site s
       WHERE s.id = site_assignment.study_site_id
         AND app.site_visible(s.id, s.study_id, s.hospital, s.pi_account_id))))
  WITH CHECK (tenant_id = app.current_tenant_id());

-- ── account：外部方只看得到自己 ─────────────────────────────────────
-- 内部员工名单对机构办 / PI 没有用处，而"能看到的东西越少越好"是默认立场。
ALTER TABLE account ENABLE ROW LEVEL SECURITY;
CREATE POLICY account_scope ON account FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND (NOT app.current_is_external() OR id = app.current_account_id()))
  WITH CHECK (tenant_id = app.current_tenant_id());

-- ── audit_entry：按可见中心切；无中心归属的条目仅内部可见 ───────────
ALTER TABLE audit_entry ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_scope ON audit_entry FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND (
      CASE WHEN study_site_id IS NULL
           THEN NOT app.current_is_external()
           ELSE EXISTS (
             SELECT 1 FROM study_site s
              WHERE s.id = audit_entry.study_site_id
                AND app.site_visible(s.id, s.study_id, s.hospital, s.pi_account_id))
      END))
  WITH CHECK (tenant_id = app.current_tenant_id());

-- 配置类表按租户切即可
ALTER TABLE team ENABLE ROW LEVEL SECURITY;
CREATE POLICY team_scope ON team FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE role ENABLE ROW LEVEL SECURITY;
CREATE POLICY role_scope ON role FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- Down Migration
DROP POLICY IF EXISTS role_scope ON role;
ALTER TABLE role DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS team_scope ON team;
ALTER TABLE team DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_scope ON audit_entry;
ALTER TABLE audit_entry DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS account_scope ON account;
ALTER TABLE account DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS site_assignment_scope ON site_assignment;
ALTER TABLE site_assignment DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS study_scope ON study;
ALTER TABLE study DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS study_site_scope ON study_site;
ALTER TABLE study_site DISABLE ROW LEVEL SECURITY;
DROP FUNCTION IF EXISTS app.site_visible(uuid, uuid, text, uuid);
DROP FUNCTION IF EXISTS app.current_is_external();
DROP FUNCTION IF EXISTS app.current_tenant_id();
DROP FUNCTION IF EXISTS app.current_org_ref();
DROP FUNCTION IF EXISTS app.current_team_id();
DROP FUNCTION IF EXISTS app.current_row_rule();
DROP FUNCTION IF EXISTS app.current_account_id();
