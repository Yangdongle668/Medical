-- Up Migration
-- ════════════════════════════════════════════════════════════════════
-- ClinicalOps 临床作业
--
-- 受试者是**有生命周期的对象，不是一个计数**。
-- 把它记成 enrolled = 12，会同时错三件事：
--   ① 筛败看不见 —— 而筛败也是收入（I8'：筛败 × 单价 × 筛败费率）
--   ② 脱落看不见 —— 而脱落要按已完成访视比例扣减收入（I8'）
--   ③ 「这一例现在卡在哪」没有答案 —— CRC 每天真正要回答的就是这个
--
-- 数据红线：只存筛选号与随机号。姓名、证件、住院号、联系方式、
-- 精确出生日期**没有字段可以放** —— 不是"先不做"。
-- ════════════════════════════════════════════════════════════════════

/* ── 新增动作权限 ────────────────────────────────────────────────── */
-- 看得到中心 ≠ 看得到这个中心里的每一例。返回明细要单独授权且逐次写审计（I10）。
INSERT INTO action_key (code, label) VALUES
  ('subjRead',  '查看受试者明细'),
  ('subjWrite', '登记受试者与访视'),
  ('piConfirm', 'PI 确认访视');

-- 具体哪个角色拿到哪个动作，属于**租户数据**，在种子里给（见 tools/gen-seed.mjs）。
-- 迁移里只登记取值本身：迁移跑在种子之前，此刻 role 表还是空的 ——
-- 在这里写 INSERT ... SELECT FROM role 会安静地插入 0 行，一个错误都不报。

/* ── 可见性辅助：中心的行范围，按中心 id ─────────────────────────
   本模块四张表都挂在 study_site 下，策略里重复写同一段 EXISTS 太脆。
   收进 SECURITY DEFINER 函数：以 owner 身份读 study_site，
   不再触发 study_site 自己的策略，也不会递归。

   注意它接的是**父行的 id**，而父行在子行插入前一定已存在 ——
   所以不会踩 0008 里那个 `INSERT ... RETURNING` 的坑
   （STABLE 函数看不到刚插入的本表行）。 */
CREATE FUNCTION app.site_visible_by_id(p_site_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS
$$
  SELECT EXISTS (SELECT 1 FROM study_site s WHERE s.id = p_site_id
                   AND app.site_visible(s.id, s.study_id, s.hospital, s.pi_account_id))
$$;
COMMENT ON FUNCTION app.site_visible_by_id IS
  '子表策略专用：父中心是否在当前身份的行范围内。与 app.site_visible 同一套规则。';

/* ── 受控取值 ────────────────────────────────────────────────────
   筛败与脱落原因必须是受控取值，不能是自由文本。
   自由文本统计不出「入排标准与该中心病源不匹配」——
   而这恰恰是唯一能指向行动的结论（谈方案修订，还是加招募渠道）。 */
CREATE TABLE screen_fail_reason (
  code text PRIMARY KEY, seq smallint NOT NULL UNIQUE, label text NOT NULL
);
INSERT INTO screen_fail_reason (code, seq, label) VALUES
  ('lab',           1, '实验室指标不符'),
  ('prior_therapy', 2, '既往治疗史不符'),
  ('imaging',       3, '影像学不符合'),
  ('comorbidity',   4, '合并疾病或用药禁忌'),
  ('withdrew_icf',  5, '受试者撤回知情'),
  ('other',         6, '其他');

CREATE TABLE withdraw_reason (
  code text PRIMARY KEY, seq smallint NOT NULL UNIQUE, label text NOT NULL
);
INSERT INTO withdraw_reason (code, seq, label) VALUES
  ('withdrew_icf',          1, '受试者撤回知情'),
  ('lost_to_followup',      2, '失访'),
  ('adverse_event',         3, '不良事件终止治疗'),
  ('investigator_decision', 4, '研究者判断需终止'),
  ('death',                 5, '死亡'),
  ('protocol_violation',    6, '方案违背终止');

/* ── 访视计划表 SOA ──────────────────────────────────────────────
   完成一次访视自动生成下一次 —— 靠的就是这张表。
   没有它，「下一次什么时候、窗口多宽、要做哪几项」只能靠 CRC 记忆，
   而记忆不会在他休假时留下来。

   anchor：seq 0 的筛选期访视锚定知情签署日，其余锚定入组日（Day 1）。 */
CREATE TABLE visit_template (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL DEFAULT app.default_tenant_id() REFERENCES tenant(id),
  study_id            uuid NOT NULL REFERENCES study(id) ON DELETE CASCADE,
  seq                 smallint NOT NULL,
  visit_code          text NOT NULL,
  visit_label         text NOT NULL,
  anchor              text NOT NULL CHECK (anchor IN ('icf', 'enroll')),
  offset_days         smallint NOT NULL,
  window_days         smallint NOT NULL CHECK (window_days >= 0),
  compensation_cents  bigint NOT NULL DEFAULT 0 CHECK (compensation_cents >= 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (study_id, seq),
  UNIQUE (study_id, visit_code),
  -- 只有 seq 0 锚定知情日：入组之前唯一确定的日期就是它
  CONSTRAINT visit_template_anchor_seq CHECK ((seq = 0) = (anchor = 'icf'))
);
CREATE TABLE visit_template_task (
  study_id  uuid NOT NULL,
  visit_seq smallint NOT NULL,
  seq       smallint NOT NULL,
  task      text NOT NULL,
  PRIMARY KEY (study_id, visit_seq, seq),
  FOREIGN KEY (study_id, visit_seq) REFERENCES visit_template (study_id, seq) ON DELETE CASCADE
);

/* ── 受试者 ─────────────────────────────────────────────────────── */
CREATE TABLE subject (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL DEFAULT app.default_tenant_id() REFERENCES tenant(id),
  study_site_id      uuid NOT NULL REFERENCES study_site(id),
  screening_no       text NOT NULL,
  randomization_no   text,
  state              text NOT NULL DEFAULT 'prescreen' CHECK (state IN
                       ('prescreen','screening','enrolled','screen_failed','withdrawn','completed')),
  icf_signed_on      date,
  enrolled_on        date,
  exited_on          date,
  screen_fail_reason text REFERENCES screen_fail_reason(code),
  withdraw_reason    text REFERENCES withdraw_reason(code),
  note               text,
  crc_account_id     uuid REFERENCES account(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (study_site_id, screening_no),
  UNIQUE (study_site_id, randomization_no),

  -- 状态与它的证据必须同时存在，否则「为什么是这个状态」没有答案
  CONSTRAINT subject_sf_needs_reason CHECK
    ((state = 'screen_failed') = (screen_fail_reason IS NOT NULL)),
  CONSTRAINT subject_wd_needs_reason CHECK
    ((state = 'withdrawn') = (withdraw_reason IS NOT NULL)),
  CONSTRAINT subject_screening_needs_icf CHECK
    (state = 'prescreen' OR icf_signed_on IS NOT NULL),
  -- 入组即随机化：没有随机号的"已入组"在核查时说不清是哪一例
  CONSTRAINT subject_enrolled_needs_rnd CHECK
    ((state IN ('enrolled','withdrawn','completed')) = (randomization_no IS NOT NULL)),
  CONSTRAINT subject_enrolled_needs_date CHECK
    ((state IN ('enrolled','withdrawn','completed')) = (enrolled_on IS NOT NULL)),
  CONSTRAINT subject_exit_after_icf CHECK (exited_on IS NULL OR exited_on >= icf_signed_on),
  CONSTRAINT subject_enroll_after_icf CHECK (enrolled_on IS NULL OR enrolled_on >= icf_signed_on)
);
CREATE INDEX subject_site_idx ON subject (study_site_id, state);
CREATE TRIGGER subject_touch BEFORE UPDATE ON subject
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
COMMENT ON COLUMN subject.screening_no IS
  '筛选号。**准标识符** —— 在一个中心内可定位到具体的人，因此受列权限管辖。';
COMMENT ON CONSTRAINT subject_wd_needs_reason ON subject IS
  '脱落必须有受控原因：它决定这一例还能不能算收入（I8'' 的脱落扣减）。';

/* ── 访视 ────────────────────────────────────────────────────────
   窗口用 daterange 生成列直接表达。超窗清单是一次 GiST 索引扫描，
   不是在应用层遍历每一例算日期 —— 后者在 3000 例时会拖垮列表页。 */
CREATE TABLE subject_visit (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL DEFAULT app.default_tenant_id() REFERENCES tenant(id),
  subject_id        uuid NOT NULL REFERENCES subject(id) ON DELETE CASCADE,
  -- 冗余一列中心 id：策略与「本中心的访视」查询都靠它，省一次 join
  study_site_id     uuid NOT NULL REFERENCES study_site(id),
  seq               smallint NOT NULL,
  visit_code        text NOT NULL,
  visit_label       text NOT NULL,
  target_date       date NOT NULL,
  window_days       smallint NOT NULL CHECK (window_days >= 0),
  -- 列名不能叫 window：那是 SQL 的保留字（WINDOW 子句），加引号才能用，
  -- 而"加了引号的列名"意味着此后每一处引用都要记得加。
  visit_window      daterange GENERATED ALWAYS AS (
                      daterange(target_date - window_days, target_date + window_days, '[]')
                    ) STORED,
  actual_date       date,
  status            text NOT NULL DEFAULT 'planned' CHECK (status IN
                      ('planned','done_pending_pi','locked','missed','cancelled')),
  edc_status        text NOT NULL DEFAULT 'pending'
                      CHECK (edc_status IN ('pending','entered','queried')),
  edc_entered_on    date,
  hours             numeric(4,2) CHECK (hours IS NULL OR (hours > 0 AND hours <= 24)),
  out_of_window     boolean NOT NULL DEFAULT false,
  pi_confirmed_by   uuid REFERENCES account(id),
  pi_confirmed_at   timestamptz,
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_id, seq),

  CONSTRAINT visit_done_needs_date CHECK
    ((status IN ('done_pending_pi','locked')) = (actual_date IS NOT NULL)),
  -- I3：锁定必须有 PI 的签字与时间，两者缺一不可
  CONSTRAINT visit_locked_needs_pi CHECK
    ((status = 'locked') = (pi_confirmed_by IS NOT NULL AND pi_confirmed_at IS NOT NULL)),
  CONSTRAINT visit_edc_entered_needs_date CHECK
    ((edc_status = 'entered') = (edc_entered_on IS NOT NULL))
);
CREATE INDEX subject_visit_window_gist ON subject_visit USING gist (visit_window);
CREATE INDEX subject_visit_open_idx ON subject_visit (study_site_id, target_date)
  WHERE status = 'planned';
CREATE INDEX subject_visit_pending_pi_idx ON subject_visit (study_site_id)
  WHERE status = 'done_pending_pi';
CREATE TRIGGER subject_visit_touch BEFORE UPDATE ON subject_visit
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
COMMENT ON COLUMN subject_visit.out_of_window IS
  '实际完成日落在窗口外。**落库固化**，不是每次查询重算 ——
   窗口宽度日后若被修订，历史上那次偏离不能因此消失。';

CREATE TABLE subject_visit_task (
  visit_id uuid NOT NULL REFERENCES subject_visit(id) ON DELETE CASCADE,
  seq      smallint NOT NULL,
  task     text NOT NULL,
  done_at  timestamptz,
  done_by  uuid REFERENCES account(id),
  PRIMARY KEY (visit_id, seq),
  CONSTRAINT visit_task_done_needs_actor CHECK ((done_at IS NULL) = (done_by IS NULL))
);

/* ── 质量事件 ────────────────────────────────────────────────────
   I4：访视超窗**必须**生成方案偏离，且在同一个事务里生成 ——
   事后补录的偏离，核查时看的是补录时间，不是发生时间。 */
CREATE TABLE quality_event (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL DEFAULT app.default_tenant_id() REFERENCES tenant(id),
  code           text NOT NULL UNIQUE,
  study_site_id  uuid NOT NULL REFERENCES study_site(id),
  subject_id     uuid REFERENCES subject(id),
  visit_id       uuid REFERENCES subject_visit(id),
  kind           text NOT NULL CHECK (kind IN
                   ('deviation','query','ip_discrepancy','sae_late','other')),
  severity       text NOT NULL CHECK (severity IN ('minor','major','critical')),
  state          text NOT NULL DEFAULT 'open'
                   CHECK (state IN ('open','pending_review','closed')),
  title          text NOT NULL,
  detail         text NOT NULL,
  auto_generated boolean NOT NULL DEFAULT false,
  raised_by      text NOT NULL CHECK (raised_by IN ('system','cra','qa','institution')),
  raised_on      date NOT NULL DEFAULT CURRENT_DATE,
  raised_by_account uuid REFERENCES account(id),
  closed_at      timestamptz,
  closed_by      uuid REFERENCES account(id),
  resolution     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT quality_closed_needs_resolution CHECK
    ((state = 'closed') = (closed_at IS NOT NULL AND closed_by IS NOT NULL
                           AND resolution IS NOT NULL)),
  -- 系统自动生成的事件必须指明来源对象，否则「它为什么存在」没有答案
  CONSTRAINT quality_auto_needs_source CHECK
    (NOT auto_generated OR (raised_by = 'system' AND visit_id IS NOT NULL))
);
CREATE INDEX quality_event_open_idx ON quality_event (study_site_id, kind)
  WHERE state <> 'closed';
CREATE TRIGGER quality_event_touch BEFORE UPDATE ON quality_event
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
COMMENT ON COLUMN quality_event.raised_by IS
  '来源方。**institution 提出的事件，关闭权在机构** ——
   我方自行关闭，「已关闭」这三个字在核查时就一文不值。';

/* ── 受试者补偿 ─────────────────────────────────────────────────── */
CREATE TABLE subject_payment (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL DEFAULT app.default_tenant_id() REFERENCES tenant(id),
  study_site_id  uuid NOT NULL REFERENCES study_site(id),
  subject_id     uuid NOT NULL REFERENCES subject(id) ON DELETE CASCADE,
  visit_id       uuid REFERENCES subject_visit(id),
  amount_cents   bigint NOT NULL CHECK (amount_cents >= 0),
  due_on         date NOT NULL,
  paid_on        date,
  receipt_ref    text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (visit_id),
  -- 只记「发了」而没有签收凭证，关闭中心时逐笔对不上
  CONSTRAINT payment_paid_needs_receipt CHECK ((paid_on IS NULL) = (receipt_ref IS NULL))
);
CREATE INDEX subject_payment_unpaid_idx ON subject_payment (study_site_id)
  WHERE paid_on IS NULL;
CREATE TRIGGER subject_payment_touch BEFORE UPDATE ON subject_payment
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

/* ── RLS：全部跟着中心的行范围走 ────────────────────────────────── */
ALTER TABLE visit_template      ENABLE ROW LEVEL SECURITY;
ALTER TABLE subject             ENABLE ROW LEVEL SECURITY;
ALTER TABLE subject_visit       ENABLE ROW LEVEL SECURITY;
ALTER TABLE subject_visit_task  ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality_event       ENABLE ROW LEVEL SECURITY;
ALTER TABLE subject_payment     ENABLE ROW LEVEL SECURITY;

-- 访视计划表是项目级的：本行范围内有该项目的中心，就看得到它的 SOA
CREATE POLICY visit_template_scope ON visit_template FOR ALL
  USING (tenant_id = app.current_tenant_id() AND EXISTS (
    SELECT 1 FROM study_site s WHERE s.study_id = visit_template.study_id
      AND app.site_visible(s.id, s.study_id, s.hospital, s.pi_account_id)))
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY subject_scope ON subject FOR ALL
  USING (tenant_id = app.current_tenant_id()
         AND app.site_visible_by_id(subject.study_site_id))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND app.site_visible_by_id(subject.study_site_id));

CREATE POLICY subject_visit_scope ON subject_visit FOR ALL
  USING (tenant_id = app.current_tenant_id()
         AND app.site_visible_by_id(subject_visit.study_site_id))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND app.site_visible_by_id(subject_visit.study_site_id));

-- 任务表没有自己的中心列，按父访视判定；父行插入前已存在，不踩 RETURNING 的坑
CREATE FUNCTION app.visit_task_visible(p_visit_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS
$$
  SELECT EXISTS (SELECT 1 FROM subject_visit v WHERE v.id = p_visit_id
                   AND app.site_visible_by_id(v.study_site_id))
$$;
CREATE POLICY subject_visit_task_scope ON subject_visit_task FOR ALL
  USING (app.visit_task_visible(visit_id))
  WITH CHECK (app.visit_task_visible(visit_id));

CREATE POLICY quality_event_scope ON quality_event FOR ALL
  USING (tenant_id = app.current_tenant_id()
         AND app.site_visible_by_id(quality_event.study_site_id))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND app.site_visible_by_id(quality_event.study_site_id));

CREATE POLICY subject_payment_scope ON subject_payment FOR ALL
  USING (tenant_id = app.current_tenant_id()
         AND app.site_visible_by_id(subject_payment.study_site_id))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND app.site_visible_by_id(subject_payment.study_site_id));

/* ── 自动生成的质量事件不可删除 ──────────────────────────────────
   I4 的另一半：能生成、但也能悄悄删掉的偏离记录，等于没有记录。
   整改靠关闭（写整改说明），不靠删除。 */
CREATE FUNCTION app.deny_auto_quality_delete() RETURNS trigger
  LANGUAGE plpgsql AS
$$
BEGIN
  IF EXISTS (SELECT 1 FROM old_rows WHERE auto_generated) THEN
    RAISE EXCEPTION '系统自动生成的质量事件不可删除，只能整改后关闭'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER quality_event_no_auto_delete
  AFTER DELETE ON quality_event
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION app.deny_auto_quality_delete();

-- Down Migration
DROP TRIGGER IF EXISTS quality_event_no_auto_delete ON quality_event;
DROP FUNCTION IF EXISTS app.deny_auto_quality_delete();
DROP POLICY IF EXISTS subject_visit_task_scope ON subject_visit_task;
DROP FUNCTION IF EXISTS app.visit_task_visible(uuid);
DROP TABLE IF EXISTS subject_payment;
DROP TABLE IF EXISTS quality_event;
DROP TABLE IF EXISTS subject_visit_task;
DROP TABLE IF EXISTS subject_visit;
DROP TABLE IF EXISTS subject;
DROP TABLE IF EXISTS visit_template_task;
DROP TABLE IF EXISTS visit_template;
DROP TABLE IF EXISTS withdraw_reason;
DROP TABLE IF EXISTS screen_fail_reason;
DROP FUNCTION IF EXISTS app.site_visible_by_id(uuid);
-- 先清引用再删取值：role_action 里的授权由种子写入，但外键在这里
DELETE FROM role_action WHERE action_key IN ('subjRead','subjWrite','piConfirm');
DELETE FROM action_key  WHERE code       IN ('subjRead','subjWrite','piConfirm');
