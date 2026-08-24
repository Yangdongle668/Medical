-- Up Migration
-- ════════════════════════════════════════════════════════════════════
-- 地基：app schema、租户、公共触发器、默认授权
-- ════════════════════════════════════════════════════════════════════

CREATE SCHEMA IF NOT EXISTS app;
COMMENT ON SCHEMA app IS '内部函数与策略辅助。业务表留在 public。';

-- 今后由 sitedesk 建的表/序列自动授权给应用角色，避免每张表重复 GRANT。
-- audit_entry 的 UPDATE/DELETE 在 0003 里单独收回。
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sitedesk_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO sitedesk_app;
GRANT USAGE ON SCHEMA public, app TO sitedesk_app;

-- ── 租户 ────────────────────────────────────────────────────────────
-- Phase 0 §9.1 的决定：当前单租户，但列与表先立住。
-- 事后补 tenant_id 要动全部外键与全部 RLS 策略，那是最贵的改造路径。
CREATE TABLE tenant (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE tenant IS '租户。当前仅一行；多租户改造时此表即为切分维度。';

INSERT INTO tenant (id, code, name)
VALUES ('00000000-0000-0000-0000-000000000001', 'hengji', '恒济临床研究');

-- 全局默认租户，供各表 DEFAULT 引用
CREATE FUNCTION app.default_tenant_id() RETURNS uuid
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT '00000000-0000-0000-0000-000000000001'::uuid $$;

-- ── 公共触发器 ──────────────────────────────────────────────────────
CREATE FUNCTION app.touch_updated_at() RETURNS trigger
  LANGUAGE plpgsql AS
$$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
COMMENT ON FUNCTION app.touch_updated_at() IS
  '规约 9：updated_at 由触发器维护，不靠应用记得写。';

-- 只追加表的守卫：语句级 BEFORE 触发器会拦住包括 owner 在内的所有人。
-- 仅靠 REVOKE 挡不住 owner，而 owner 正是跑迁移的那个角色。
CREATE FUNCTION app.deny_mutation() RETURNS trigger
  LANGUAGE plpgsql AS
$$ BEGIN
     RAISE EXCEPTION '% 是只追加表，不允许 %', TG_TABLE_NAME, TG_OP
       USING ERRCODE = '42501';
   END $$;

-- Down Migration
DROP FUNCTION IF EXISTS app.deny_mutation();
DROP FUNCTION IF EXISTS app.touch_updated_at();
DROP FUNCTION IF EXISTS app.default_tenant_id();
DROP TABLE IF EXISTS tenant;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM sitedesk_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE USAGE, SELECT ON SEQUENCES FROM sitedesk_app;
DROP SCHEMA IF EXISTS app CASCADE;
