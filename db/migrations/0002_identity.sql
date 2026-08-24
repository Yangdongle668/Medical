-- Up Migration
-- ════════════════════════════════════════════════════════════════════
-- Identity & Access —— 权限是三维的：行 × 列 × 动作
--
-- 行：role.row_rule 决定"看得到哪些中心"，由身份推导，绝不由用户选择
-- 列：role_field   决定"同一行里哪些字段可见"
-- 动作：role_action 决定"能对它做什么"
--
-- 外部角色（机构办 / 研究者）默认拒绝：role_field 初始为空，靠白名单加回。
-- 与"先给全部再关敏感的"在正常情况下结果一样，
-- 在新增一个字段时结果完全相反 —— 前者默认不可见，后者默认泄漏。
-- ════════════════════════════════════════════════════════════════════

-- ── 行范围规则（查找表：需要稳定的语义与说明，故不用 CHECK） ────────
CREATE TABLE row_rule (
  code        text PRIMARY KEY,
  label       text NOT NULL,
  description text NOT NULL
);
INSERT INTO row_rule (code, label, description) VALUES
  ('all',      '全部中心',           '经营层 / QA / 数据管理'),
  ('team',     '本组承接的项目',      '由 team_study 推导 —— PM'),
  ('assigned', '被指派的中心',        '由 site_assignment 推导 —— CRA / CRC'),
  ('hospital', '本院承接的项目',      '由 account.org_ref 推导 —— 机构办（外部）'),
  ('pi',       '本人担任研究者的中心', '由 study_site.pi_account_id 推导 —— PI（外部）'),
  ('none',     '无数据范围',          '仅用于停用或纯配置类账号');

CREATE TABLE role (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL DEFAULT app.default_tenant_id() REFERENCES tenant(id),
  code         text NOT NULL,
  name         text NOT NULL,
  is_external  boolean NOT NULL DEFAULT false,
  row_rule     text NOT NULL REFERENCES row_rule(code),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
COMMENT ON COLUMN role.is_external IS
  '医院方（机构办 / PI）。他们的字段权限初始全关，靠 role_field 白名单加回。';
CREATE TRIGGER role_touch BEFORE UPDATE ON role
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ── 列维度：字段可见性 ──────────────────────────────────────────────
CREATE TABLE field_key (
  code        text PRIMARY KEY,
  label       text NOT NULL,
  sensitivity text NOT NULL CHECK (sensitivity IN ('L1','L2','L3'))
);
COMMENT ON COLUMN field_key.sensitivity IS
  'L1 一般 / L2 商业敏感（成本毛利报价）/ L3 受试者相关。见架构文档 §11.1。';
INSERT INTO field_key (code, label, sensitivity) VALUES
  ('cost',   '成本与人天',   'L2'),
  ('margin', '毛利与利润率', 'L2'),
  ('price',  '报价与合同金额','L2'),
  ('subject','受试者筛选号', 'L3'),
  ('staff',  '员工薪资口径', 'L2');

CREATE TABLE role_field (
  role_id   uuid NOT NULL REFERENCES role(id) ON DELETE CASCADE,
  field_key text NOT NULL REFERENCES field_key(code),
  visible   boolean NOT NULL DEFAULT false,
  PRIMARY KEY (role_id, field_key)
);

-- ── 动作维度 ────────────────────────────────────────────────────────
CREATE TABLE action_key (
  code  text PRIMARY KEY,
  label text NOT NULL
);
INSERT INTO action_key (code, label) VALUES
  ('approve',  '审批工时 / 差旅 / 偏离'),
  ('closeQA',  '关闭质量事件'),
  ('raiseQ',   '发起数据质疑'),
  ('closeQ',   '关闭数据质疑'),
  ('advance',  '推进中心阶段'),
  ('manage',   '管理人员与权限'),
  ('bid',      '维护报价与投标'),
  ('ethics',   '递交伦理事务');

CREATE TABLE role_action (
  role_id    uuid NOT NULL REFERENCES role(id) ON DELETE CASCADE,
  action_key text NOT NULL REFERENCES action_key(code),
  allowed    boolean NOT NULL DEFAULT false,
  PRIMARY KEY (role_id, action_key)
);

-- ── 可访问模块（收敛导航，不是安全边界；安全边界是上面三维） ────────
CREATE TABLE role_module (
  role_id    uuid NOT NULL REFERENCES role(id) ON DELETE CASCADE,
  module_key text NOT NULL,
  sort_order smallint NOT NULL DEFAULT 0,
  PRIMARY KEY (role_id, module_key)
);

-- ── 分组：PM 行范围的来源 ───────────────────────────────────────────
CREATE TABLE team (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL DEFAULT app.default_tenant_id() REFERENCES tenant(id),
  code             text NOT NULL,
  name             text NOT NULL,
  lead_account_id  uuid,          -- FK 在 account 建好后补，避免建表环
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
CREATE TRIGGER team_touch BEFORE UPDATE ON team
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ── 账号 ────────────────────────────────────────────────────────────
-- 认证凭据不在这里：内部走 OIDC（企业微信/飞书），外部走一次性魔法链接。
-- 相关表（auth_identity / login_token）属于 Phase 3。
CREATE TABLE account (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL DEFAULT app.default_tenant_id() REFERENCES tenant(id),
  login            text NOT NULL,
  display_name     text NOT NULL,
  role_id          uuid NOT NULL REFERENCES role(id),
  team_id          uuid REFERENCES team(id),
  is_external      boolean NOT NULL DEFAULT false,
  org_ref          text,          -- 外部方所属机构（医院名）—— hospital 行规则用
  status           text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','disabled')),
  joined_on        date,
  disabled_at      timestamptz,
  disabled_reason  text,
  last_login_at    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, login),
  -- 停用必须留原因：审计轨迹要能追溯到人，"账号没了"不是答案
  CONSTRAINT account_disabled_needs_reason CHECK (
    status = 'active' OR (disabled_at IS NOT NULL AND disabled_reason IS NOT NULL)),
  -- 注：org_ref 的必填性取决于角色的 row_rule（跨表条件），CHECK 表达不了，
  --     由下面的触发器精确执行。曾一度写成"外部账号必须有 org_ref"——
  --     那是错的：PI 也是外部账号，但他按 pi 规则切行，与所属机构无关。
  CONSTRAINT account_login_shape CHECK (login ~ '^[a-z][a-z0-9_]{2,31}$')
);
CREATE INDEX account_role_idx ON account (role_id);
CREATE INDEX account_team_idx ON account (team_id) WHERE team_id IS NOT NULL;
CREATE TRIGGER account_touch BEFORE UPDATE ON account
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE team
  ADD CONSTRAINT team_lead_fk FOREIGN KEY (lead_account_id) REFERENCES account(id);

-- row_rule = 'hospital' 的账号没有 org_ref，行范围会静默为空 —— 人能登录，
-- 但一条数据都看不到，且没有任何报错。这类"静默为空"必须在写入时就拦住。
CREATE FUNCTION app.assert_account_scope_resolvable() RETURNS trigger
  LANGUAGE plpgsql AS
$$
DECLARE v_rule text;
BEGIN
  SELECT row_rule INTO v_rule FROM role WHERE id = NEW.role_id;
  IF v_rule = 'hospital' AND coalesce(btrim(NEW.org_ref), '') = '' THEN
    RAISE EXCEPTION '账号 % 的角色按「本院承接的项目」切行，必须填写 org_ref（所属机构）', NEW.login
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER account_scope_resolvable
  BEFORE INSERT OR UPDATE OF role_id, org_ref ON account
  FOR EACH ROW EXECUTE FUNCTION app.assert_account_scope_resolvable();

-- Down Migration
DROP TRIGGER IF EXISTS account_scope_resolvable ON account;
DROP FUNCTION IF EXISTS app.assert_account_scope_resolvable();
ALTER TABLE team DROP CONSTRAINT IF EXISTS team_lead_fk;
DROP TABLE IF EXISTS account;
DROP TABLE IF EXISTS team;
DROP TABLE IF EXISTS role_module;
DROP TABLE IF EXISTS role_action;
DROP TABLE IF EXISTS action_key;
DROP TABLE IF EXISTS role_field;
DROP TABLE IF EXISTS field_key;
DROP TABLE IF EXISTS role;
DROP TABLE IF EXISTS row_rule;
