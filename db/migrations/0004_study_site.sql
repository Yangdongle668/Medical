-- Up Migration
-- ════════════════════════════════════════════════════════════════════
-- 示范业务表：StudySite（项目 × 中心）—— 本系统的最小作业单元。
--
-- Phase 1 只建这一张业务表，其余各表随各自模块在 Phase 6 建
-- （Phase 0 §8.1：一次建完 40 张表与"按模块垂直开发"直接矛盾）。
-- 选它是因为五条行范围规则全都落在它身上，不建它就无法验证 RLS。
-- ════════════════════════════════════════════════════════════════════

-- ── 中心状态机（查找表：需要顺序，故不用 CHECK） ───────────────────
CREATE TABLE site_state (
  code  text PRIMARY KEY,
  seq   smallint NOT NULL UNIQUE,
  label text NOT NULL
);
INSERT INTO site_state (code, seq, label) VALUES
  ('intake',      1, '立项'),
  ('irb_submit',  2, '伦理递交'),
  ('irb_approve', 3, '伦理批件'),
  ('contract',    4, '合同签署'),
  ('siv',         5, 'SIV启动'),
  ('enrolling',   6, '入组中'),
  ('enrolled',    7, '入组完成'),
  ('followup',    8, '随访中'),
  ('closed',      9, '中心关闭');
COMMENT ON TABLE site_state IS
  '推进到下一节点必须过闸门（SIV 看启动阻塞项，关闭看七项前置条件）。
   闸门逻辑在 packages/domain，不在数据库 —— 数据库只保证状态取值合法。';

CREATE TABLE study (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL DEFAULT app.default_tenant_id() REFERENCES tenant(id),
  code              text NOT NULL,
  short_name        text NOT NULL,
  sponsor_name      text NOT NULL,   -- Client 聚合根在 Intake&Contract 模块建，届时改为 FK
  phase             text NOT NULL,
  indication        text NOT NULL,
  planned_subjects  integer NOT NULL CHECK (planned_subjects > 0),
  contract_amount   numeric(14,2) NOT NULL CHECK (contract_amount >= 0),  -- 元
  started_on        date,
  ends_on           date,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  CONSTRAINT study_period CHECK (ends_on IS NULL OR started_on IS NULL OR ends_on > started_on)
);
CREATE TRIGGER study_touch BEFORE UPDATE ON study
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE study_site (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL DEFAULT app.default_tenant_id() REFERENCES tenant(id),
  study_id          uuid NOT NULL REFERENCES study(id),
  code              text NOT NULL,
  hospital          text NOT NULL,
  dept              text NOT NULL,
  city              text NOT NULL,

  pi_account_id     uuid REFERENCES account(id),   -- pi 行规则用；PI 可能尚未开户
  pi_name           text NOT NULL,

  state             text NOT NULL DEFAULT 'intake' REFERENCES site_state(code),
  contracted        integer NOT NULL CHECK (contracted > 0),
  unit_price        numeric(14,2) NOT NULL CHECK (unit_price >= 0),   -- 元/例
  startup_fee       numeric(14,2) NOT NULL DEFAULT 0 CHECK (startup_fee >= 0),

  irb_approved_on   date,
  siv_on            date,
  siv_planned_on    date,
  fpi_on            date,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  -- 首例入组不可能早于启动会
  CONSTRAINT site_fpi_after_siv CHECK (fpi_on IS NULL OR siv_on IS NULL OR fpi_on >= siv_on),
  -- 启动会不可能早于伦理批件
  CONSTRAINT site_siv_after_irb CHECK (siv_on IS NULL OR irb_approved_on IS NULL OR siv_on >= irb_approved_on)
);
CREATE INDEX study_site_study_idx    ON study_site (study_id);
CREATE INDEX study_site_hospital_idx ON study_site (tenant_id, hospital);
CREATE INDEX study_site_pi_idx       ON study_site (pi_account_id) WHERE pi_account_id IS NOT NULL;
CREATE TRIGGER study_site_touch BEFORE UPDATE ON study_site
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ── team 的承接项目：PM 行范围的来源 ────────────────────────────────
CREATE TABLE team_study (
  team_id    uuid NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  study_id   uuid NOT NULL REFERENCES study(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, study_id)
);
-- 一个项目同一时间只归一个组，否则"本组的中心"就有歧义
CREATE UNIQUE INDEX team_study_one_owner ON team_study (study_id);

-- ── 派工：assigned 行范围的来源 ─────────────────────────────────────
-- 完整的派工模型（FTE 冲突检测、利用率）在 Site&Staffing 模块展开；
-- 这里只建 RLS 所必需的最小结构。
CREATE TABLE site_assignment (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.default_tenant_id() REFERENCES tenant(id),
  account_id    uuid NOT NULL REFERENCES account(id),
  study_site_id uuid NOT NULL REFERENCES study_site(id) ON DELETE CASCADE,
  role_kind     text NOT NULL CHECK (role_kind IN ('CRA','CRC')),
  effective     daterange NOT NULL DEFAULT daterange(CURRENT_DATE, NULL, '[)'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- 同一人对同一中心的派工区间不得重叠 —— 否则"他什么时候开始负责"没有答案
  EXCLUDE USING gist (account_id WITH =, study_site_id WITH =, effective WITH &&)
);
CREATE INDEX site_assignment_account_idx ON site_assignment (account_id);
CREATE INDEX site_assignment_site_idx    ON site_assignment (study_site_id);

-- Down Migration
DROP TABLE IF EXISTS site_assignment;
DROP TABLE IF EXISTS team_study;
DROP TABLE IF EXISTS study_site;
DROP TABLE IF EXISTS study;
DROP TABLE IF EXISTS site_state;
