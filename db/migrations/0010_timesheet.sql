-- Up Migration
-- ════════════════════════════════════════════════════════════════════
-- Timesheet & Cost —— 钱这一侧
--
-- 到这里为止，系统知道「做了什么」，但不知道「花了多少、赚了多少」。
-- 而这两个数字一旦开始骗人，整个看板就都不能信了。
--
-- 三条不变量落在这张迁移上：
--   I1 工时归属唯一中心；billable 由工作类型推导后**落库固化**
--   I2 成本 = 人天 × 提交时生效的费率卡，落库快照；费率变更不回溯历史
--   I8' 收入四项：启动费 + 入组×单价 − 脱落未完成部分 + 筛败×单价×筛败费率
-- ════════════════════════════════════════════════════════════════════

/* ── 筛败费率：合同条款，不是常量 ────────────────────────────────
   原型里它是一行 `const SF_FEE = 0.35`。写死的后果不是不准，
   而是**没法按项目谈** —— 而筛败费率恰恰是每份合同都要单独谈的一条。 */
ALTER TABLE study
  ADD COLUMN screen_fail_fee_rate numeric(4,3) NOT NULL DEFAULT 0.350
    CHECK (screen_fail_fee_rate >= 0 AND screen_fail_fee_rate <= 1),
  ADD COLUMN overhead_rate numeric(4,3) NOT NULL DEFAULT 0.120
    CHECK (overhead_rate >= 0 AND overhead_rate <= 1);
COMMENT ON COLUMN study.screen_fail_fee_rate IS
  '筛败费率。筛败例数 × 单价 × 本费率计入收入（I8''）。
   漏算它会把本来赚钱的高筛败中心算成亏损，然后关掉它。';
COMMENT ON COLUMN study.overhead_rate IS
  'PM/QA/职能分摊比例，按直接人力成本计。';

/* ── 工作类型：billable 的**定义**在这里，而每条工时落库时抄一份 ── */
CREATE TABLE work_type (
  code     text PRIMARY KEY,
  seq      smallint NOT NULL UNIQUE,
  label    text NOT NULL,
  billable boolean NOT NULL
);
INSERT INTO work_type (code, seq, label, billable) VALUES
  ('visit_support', 1, '受试者访视陪同',   true),
  ('sdv',           2, '源数据准备与核对', true),
  ('ethics',        3, '伦理递交与跟进',   true),
  ('monitoring',    4, '现场监查（IMV）',  true),
  ('ip_mgmt',       5, '药品与物资管理',   true),
  ('training',      6, '内部培训',         false),
  ('bd',            7, '投标与商务支持',   false),
  ('rework',        8, '返工与整改',       false);
COMMENT ON COLUMN work_type.billable IS
  '此处是**定义**；每条工时落库时抄一份快照（I1）。
   「内部培训」明年若改成可计费，去年的工时不能因此变成可计费的。';

/* ── 费率卡：生效日期决定历史不被改写（I2） ───────────────────────
   费率会变（2025 年 CRC 人天 0.118 万，2026 年 0.13 万）。
   只存一个常量的话，调价当天所有历史项目的毛利会集体变化，
   而且无法向任何人解释。 */
CREATE TABLE rate_card (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL DEFAULT app.default_tenant_id() REFERENCES tenant(id),
  role_kind      text NOT NULL CHECK (role_kind IN ('CRA','CRC','PM','QA','DM')),
  level          text CHECK (level IS NULL OR level IN ('初级','中级','高级','经理','总监')),
  day_cost_cents bigint NOT NULL CHECK (day_cost_cents > 0),
  valid_from     date NOT NULL,
  valid_to       date,
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rate_card_range CHECK (valid_to IS NULL OR valid_to > valid_from),
  -- 同一 租户+工种+级别 的生效区间不允许重叠：**数据库层直接杜绝歧义**，
  -- 不需要靠应用代码小心翼翼地检查。区间重叠时"当天用哪个费率"没有答案。
  CONSTRAINT rate_card_no_overlap EXCLUDE USING gist (
    tenant_id WITH =, role_kind WITH =, coalesce(level, '') WITH =,
    daterange(valid_from, coalesce(valid_to, 'infinity'::date), '[)') WITH &&
  )
);
CREATE INDEX rate_card_lookup_idx ON rate_card (role_kind, valid_from DESC);

/** 某天对某工种/级别生效的费率。级别精确匹配优先，其次是不分级别的通用行。 */
CREATE FUNCTION app.rate_on(p_role text, p_level text, p_on date)
  RETURNS TABLE (id uuid, day_cost_cents bigint)
  LANGUAGE sql STABLE AS
$$
  SELECT r.id, r.day_cost_cents FROM rate_card r
   WHERE r.role_kind = p_role
     AND daterange(r.valid_from, coalesce(r.valid_to, 'infinity'::date), '[)') @> p_on
     AND (r.level = p_level OR r.level IS NULL)
   ORDER BY (r.level IS NOT NULL) DESC
   LIMIT 1
$$;

/* ── 工时：不可变事实 ────────────────────────────────────────────
   **工时不能删，只能作废。** 作废写下时间、人和原因，成本由此反向冲抵。
   理由有两个，第二个更要紧：
     ① 核查要求可追溯；
     ② 「昨天的报表和今天不一样」是信任崩塌的开始 ——
        而一旦一线发现报表会变，他们就不再照着它做决定了。 */
CREATE TABLE timesheet_entry (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL DEFAULT app.default_tenant_id() REFERENCES tenant(id),
  study_site_id  uuid NOT NULL REFERENCES study_site(id),
  account_id     uuid NOT NULL REFERENCES account(id),
  work_date      date NOT NULL,
  work_type      text NOT NULL REFERENCES work_type(code),
  -- I1：落库固化，不随 work_type.billable 的定义变更而改变
  billable       boolean NOT NULL,
  hours          numeric(4,2) NOT NULL CHECK (hours > 0 AND hours <= 24),
  -- I2：费率快照 + 指向当时那张费率卡，两者都要有
  rate_card_id   uuid NOT NULL REFERENCES rate_card(id),
  day_cost_cents bigint NOT NULL CHECK (day_cost_cents > 0),
  travel_cents   bigint NOT NULL DEFAULT 0 CHECK (travel_cents >= 0),
  cost_cents     bigint NOT NULL CHECK (cost_cents >= 0),
  -- 访视与工时同次录入时指过来；由完成访视自动生成的工时一定有它
  subject_id     uuid REFERENCES subject(id),
  visit_id       uuid REFERENCES subject_visit(id),
  auto_generated boolean NOT NULL DEFAULT false,
  note           text,
  voided_at      timestamptz,
  voided_by      uuid REFERENCES account(id),
  void_reason    text,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT timesheet_void_complete CHECK (
    (voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL) OR
    (voided_at IS NOT NULL AND voided_by IS NOT NULL AND void_reason IS NOT NULL)),
  -- 一次访视只自动生成一条工时；重复触发不该重复计成本
  CONSTRAINT timesheet_one_auto_per_visit UNIQUE (visit_id, auto_generated)
);
CREATE INDEX timesheet_site_idx ON timesheet_entry (study_site_id, work_date)
  WHERE voided_at IS NULL;
CREATE INDEX timesheet_account_idx ON timesheet_entry (account_id, work_date)
  WHERE voided_at IS NULL;
COMMENT ON COLUMN timesheet_entry.cost_cents IS
  '提交时按当时费率算出的快照（I2）。**此后不再重算。**';

/* 工时是事实表：允许 INSERT 与「打作废标记」的 UPDATE，不允许 DELETE，
   也不允许改动任何一个会影响成本的字段。改数字要靠作废后重报。 */
CREATE FUNCTION app.timesheet_immutable() RETURNS trigger
  LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '工时不能删除，只能作废（写明时间、人与原因）'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION '已作废的工时不可再修改' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.study_site_id, NEW.account_id, NEW.work_date, NEW.work_type, NEW.billable,
      NEW.hours, NEW.rate_card_id, NEW.day_cost_cents, NEW.travel_cents, NEW.cost_cents)
     IS DISTINCT FROM
     (OLD.study_site_id, OLD.account_id, OLD.work_date, OLD.work_type, OLD.billable,
      OLD.hours, OLD.rate_card_id, OLD.day_cost_cents, OLD.travel_cents, OLD.cost_cents) THEN
    RAISE EXCEPTION '工时的归属、工时数与成本不可修改；改数字请作废后重报'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER timesheet_no_delete BEFORE DELETE ON timesheet_entry
  FOR EACH ROW EXECUTE FUNCTION app.timesheet_immutable();
CREATE TRIGGER timesheet_no_edit BEFORE UPDATE ON timesheet_entry
  FOR EACH ROW EXECUTE FUNCTION app.timesheet_immutable();

/* ── RLS ─────────────────────────────────────────────────────────
   工时跟着中心的行范围走，另加一条：**外部方看不到我方的人力成本**。
   机构办知道我们在他们医院投了多少人天，等于知道我们的报价底线。 */
ALTER TABLE rate_card       ENABLE ROW LEVEL SECURITY;
ALTER TABLE timesheet_entry ENABLE ROW LEVEL SECURITY;

CREATE POLICY rate_card_scope ON rate_card FOR ALL
  USING (tenant_id = app.current_tenant_id() AND NOT app.current_is_external())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY timesheet_scope ON timesheet_entry FOR ALL
  USING (tenant_id = app.current_tenant_id()
         AND NOT app.current_is_external()
         AND app.site_visible_by_id(timesheet_entry.study_site_id))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND NOT app.current_is_external()
              AND app.site_visible_by_id(timesheet_entry.study_site_id));

/* ── 新增动作权限 ────────────────────────────────────────────────
   授权（谁拿到哪个动作）属于租户数据，在种子里给 —— 见 db/README 规约 13。 */
INSERT INTO action_key (code, label) VALUES
  ('timeWrite', '填报与作废工时'),
  ('rateWrite', '维护费率卡');

-- Down Migration
DROP TRIGGER IF EXISTS timesheet_no_edit ON timesheet_entry;
DROP TRIGGER IF EXISTS timesheet_no_delete ON timesheet_entry;
DROP FUNCTION IF EXISTS app.timesheet_immutable();
DROP TABLE IF EXISTS timesheet_entry;
DROP FUNCTION IF EXISTS app.rate_on(text, text, date);
DROP TABLE IF EXISTS rate_card;
DROP TABLE IF EXISTS work_type;
ALTER TABLE study DROP COLUMN IF EXISTS overhead_rate;
ALTER TABLE study DROP COLUMN IF EXISTS screen_fail_fee_rate;
DELETE FROM role_action WHERE action_key IN ('timeWrite','rateWrite');
DELETE FROM action_key  WHERE code       IN ('timeWrite','rateWrite');
