-- ════════════════════════════════════════════════════════════════════
-- 集群级引导：角色与扩展。由 DBA 执行一次，不属于迁移。
--
-- 为什么不放在迁移里：角色是集群级对象、密码来自密钥管理，
-- 把它写进版本化迁移会让生产密码进 git。迁移只负责 schema 与授权。
-- ════════════════════════════════════════════════════════════════════

-- 迁移执行者（对象 owner）。owner 默认绕过 RLS，因此绝不能用它跑应用。
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sitedesk') THEN
    CREATE ROLE sitedesk LOGIN PASSWORD 'sitedesk' CREATEDB;
  END IF;
END $$;

-- 应用运行时角色。非 owner、无 BYPASSRLS —— 行级安全对它真实生效。
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sitedesk_app') THEN
    CREATE ROLE sitedesk_app LOGIN PASSWORD 'sitedesk_app';
  END IF;
END $$;

-- btree_gist：费率卡与派工的生效区间 EXCLUDE 约束需要它
CREATE EXTENSION IF NOT EXISTS btree_gist;
