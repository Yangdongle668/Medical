-- Up Migration
-- ════════════════════════════════════════════════════════════════════
-- 审计轨迹 —— 在 GCP 语境下这不是"加个功能"，是系统成立与否的前提。
--
-- 每条必须回答四件事：谁（含当时的角色）、何时、改了什么（前→后）、为什么。
-- 第四件最容易被省掉也最要命：核查员看到"访视目标日从 08-18 改成 08-25"，
-- 要问的从来不是"改了吗"，而是"为什么改" ——
-- 是受试者确实改期，还是为了让超窗看起来没发生。
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE audit_entry (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL DEFAULT app.default_tenant_id() REFERENCES tenant(id),
  at                timestamptz NOT NULL DEFAULT now(),

  actor_account_id  uuid REFERENCES account(id),   -- NULL = 系统动作
  actor_login       text NOT NULL,                 -- 快照：账号可能改名或停用
  actor_role_code   text NOT NULL,                 -- 快照：当时的角色，不随后来改角色而变

  action            text NOT NULL,
  target_type       text NOT NULL,
  target_id         text NOT NULL,
  before_value      jsonb,
  after_value       jsonb,
  study_site_id     uuid,                          -- 冗余，供按中心检索；不加 FK 以免删中心受阻
  reason            text,

  -- 关键字段的变更必须写原因。哪些算关键，由应用层的 sensitive_action 清单决定，
  -- 这里只保证"声明为关键的动作"不能没有原因。
  is_sensitive      boolean NOT NULL DEFAULT false,
  CONSTRAINT audit_sensitive_needs_reason CHECK (
    NOT is_sensitive OR (reason IS NOT NULL AND length(btrim(reason)) >= 4))
);

COMMENT ON TABLE audit_entry IS
  '只追加。UPDATE / DELETE 由语句级触发器拒绝，包括 owner。';
COMMENT ON COLUMN audit_entry.actor_role_code IS
  '当时的角色快照。改了角色之后回看历史，必须看到"他当时是什么身份"。';

CREATE INDEX audit_at_idx        ON audit_entry (tenant_id, at DESC);
CREATE INDEX audit_target_idx    ON audit_entry (target_type, target_id, at DESC);
CREATE INDEX audit_actor_idx     ON audit_entry (actor_account_id, at DESC);
CREATE INDEX audit_site_idx      ON audit_entry (study_site_id, at DESC)
  WHERE study_site_id IS NOT NULL;
-- 权限类变更是核查必查项，单独可检索
CREATE INDEX audit_sensitive_idx ON audit_entry (at DESC) WHERE is_sensitive;

-- ── 不可变性：两道锁 ────────────────────────────────────────────────
-- ① REVOKE 挡住应用角色
REVOKE UPDATE, DELETE, TRUNCATE ON audit_entry FROM sitedesk_app;
-- ② 语句级触发器挡住所有人（包括 owner —— 而 owner 正是跑迁移的角色）
CREATE TRIGGER audit_entry_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_entry
  FOR EACH STATEMENT EXECUTE FUNCTION app.deny_mutation();

-- Down Migration
DROP TRIGGER IF EXISTS audit_entry_append_only ON audit_entry;
DROP TABLE IF EXISTS audit_entry;
