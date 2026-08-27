-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   SOA（访视计划表）可配置（欠账 D2）。

   `visit_template` 从 Phase 4b 起就是一张**按项目**的表 —— 它本来就是数据，
   缺的只是一个能改它的入口，以及三个问题的答案（与启动清单模板同一组）：

   ① **谁能改** —— `manage` 动作，必须写原因，逐条进审计。
      SOA 是方案的一部分：改它对应的是一次方案修订，不是调一个参数。

   ② **改了对在途受试者是否生效** —— **已排的访视不动**。
      访视在排期那一刻从模板落成 `subject_visit` 行（连 visit_code、
      window_days 一起抄下来），此后与模板无关。改模板只影响**之后**
      才排出来的访视。
      这不是取舍，是唯一说得通的做法：一个受试者的 C4D1 已经排在下周三，
      模板一改就跳到下周五，那个人的行程、床位、伴随用药全部作废 ——
      而系统不会知道自己刚刚做了这件事。

   ③ **历史追溯** —— `subject_visit` 行本身就是历史（它抄了当时的模板值），
      再加一张 `visit_template_change` 记下每一次改了什么。
      不给 visit_template 加版本维度：那要改 UNIQUE(study_id, seq)，
      而 subject_visit / visit_template_task 都挂在这个键上，
      为了一个可以由变更日志回答的问题去动主键，代价不成比例。

   ── 一条硬约束：已经排出去的 seq 不能删 ──────────────────────────
   删掉一个已有 subject_visit 行的 seq，那些行就指向了一个不存在的
   访视定义：报表里它们还在，SOA 上它们不存在。
   这件事在数据库层面拦（触发器），不只在应用层 —— 应用层会有第二个入口。
   ══════════════════════════════════════════════════════════════════════ */

CREATE TABLE visit_template_change (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL DEFAULT app.default_tenant_id() REFERENCES tenant(id),
  study_id    uuid NOT NULL REFERENCES study(id) ON DELETE CASCADE,
  changed_at  timestamptz NOT NULL DEFAULT now(),
  changed_by  uuid REFERENCES account(id),
  reason      text NOT NULL,
  /* 改之前那一版的完整内容。存 JSON 而不是拆成行：
     它是**给人看的证据**，不是要拿去 JOIN 的数据。 */
  before_soa  jsonb NOT NULL,
  after_soa   jsonb NOT NULL
);
COMMENT ON TABLE visit_template_change IS
  'SOA 每一次修订的前后快照。方案修订要能拿出「改了什么、谁改的、为什么」。';

CREATE INDEX visit_template_change_study_idx
  ON visit_template_change (study_id, changed_at DESC);

ALTER TABLE visit_template_change ENABLE ROW LEVEL SECURITY;
/* 跟着项目走：看得见这个项目下任一中心的人，看得见它的 SOA 修订史。 */
CREATE POLICY visit_template_change_scope ON visit_template_change
  FOR ALL USING (EXISTS (
    SELECT 1 FROM study_site s
     WHERE s.study_id = visit_template_change.study_id
       AND app.site_visible(s.id, s.study_id, s.hospital, s.pi_account_id)))
  WITH CHECK (EXISTS (
    SELECT 1 FROM study_site s
     WHERE s.study_id = visit_template_change.study_id
       AND app.site_visible(s.id, s.study_id, s.hospital, s.pi_account_id)));

/* ── 已排出去的 seq 不能删 ─────────────────────────────────────── */
CREATE FUNCTION app.deny_scheduled_visit_template_delete() RETURNS trigger
  LANGUAGE plpgsql AS
$$
DECLARE n bigint;
BEGIN
  /* subject 上没有 study_id —— 项目挂在中心上。绕过 study_site 去 join
     subject 会得到 "column su.study_id does not exist"，而那条报错
     指的是触发器，不是调用方。 */
  SELECT count(*) INTO n
    FROM subject_visit v JOIN study_site s ON s.id = v.study_site_id
   WHERE s.study_id = OLD.study_id AND v.seq = OLD.seq;
  IF n > 0 THEN
    RAISE EXCEPTION
      'SOA 第 % 次访视已经排给了 % 个受试者，删掉它会让那些访视指向一个不存在的定义',
      OLD.seq, n
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN OLD;
END
$$;
COMMENT ON FUNCTION app.deny_scheduled_visit_template_delete IS
  '在库里拦，不只在应用层 —— 应用层会有第二个入口，而这条规则没有例外。';

CREATE TRIGGER visit_template_no_orphan BEFORE DELETE ON visit_template
  FOR EACH ROW EXECUTE FUNCTION app.deny_scheduled_visit_template_delete();

-- Down Migration
DROP TRIGGER IF EXISTS visit_template_no_orphan ON visit_template;
DROP FUNCTION IF EXISTS app.deny_scheduled_visit_template_delete();
DROP TABLE IF EXISTS visit_template_change;
