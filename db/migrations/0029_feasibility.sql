-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   中心可行性调查。

   ── 为什么它必须是一张表，而不是一份问卷附件 ──────────────────────
   亏损的第一大来源是入组延迟，而入组延迟的根在**选址**：
   一个一年出不了 3 例的中心，合同上的例数一个不少，
   只能靠别的中心加班补。事后把它标红是最便宜也最没用的功能 ——
   那时钱已经花完了。

   把调查记下来，才有两件事可做：
     ① 选之前有一套公开口径的分数，拒绝一家医院时说得出凭什么；
     ② 选之后回填**实际月入组**，让那套口径能自我修正。
   ②比①要紧。没有②，评分只是一套自洽的说法，
   而自洽的说法在第一次争议里会被"我觉得这家不错"覆盖掉。

   ── 「明知分低仍入选」不是异常，是要记下来的常态 ──────────────────
   历史上两次都发生过：一次是申办方指定 PI，一次是为赶 FPI 凑中心数。
   系统**不阻止**这种事 —— 它拦不住，也不该拦：
   商务上的取舍本来就不归一套评分决定。
   但 `override_reason` 是必填的：入选一家评分低于 65 分的医院，
   必须留下一句话。半年后复盘"这家怎么会选进来"时，
   有那句话和没有那句话，是完全不同的两次会。

   ── 行范围：对外部方**整表关闭** ──────────────────────────────────
   和 staff 那条同样的道理，而且更硬：这里存的是
   「我们在评估哪几家医院、各打了多少分、谁被拒了」。
   让被比较的医院看见这张表，是可以直接毁掉合作关系的那种泄漏。
   ══════════════════════════════════════════════════════════════════════ */

CREATE TABLE feasibility (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL DEFAULT app.default_tenant_id() REFERENCES tenant(id),
  code         text NOT NULL,
  study_id     uuid NOT NULL REFERENCES study(id) ON DELETE CASCADE,

  hospital     text NOT NULL,
  city         text NOT NULL,
  dept         text NOT NULL,
  pi_name      text NOT NULL,

  surveyed_on  date NOT NULL,
  surveyed_by  uuid REFERENCES account(id),

  /* ── 问卷 ────────────────────────────────────────────────────────
     每一栏都是**调查时问得出答案的事实**，不是判断。
     「这家医院靠谱吗」问不出东西；
     「你们科去年这个适应症看了多少病人」问得出。 */
  pt_year      int  NOT NULL CHECK (pt_year >= 0),
  past_n       int  NOT NULL CHECK (past_n >= 0),
  past_best    numeric(6,2) NOT NULL DEFAULT 0 CHECK (past_best >= 0),
  compet       int  NOT NULL DEFAULT 0 CHECK (compet >= 0),
  ethics_days  int  NOT NULL CHECK (ethics_days >= 0),
  start_days   int  NOT NULL CHECK (start_days >= 0),
  team_n       int  NOT NULL CHECK (team_n >= 0),
  pi_commit    numeric(6,2) NOT NULL CHECK (pi_commit >= 0),
  /* 入排匹配度。**允许为空，而且空得有意义** ——
     早期的记录这一栏是 NULL：不是漏填，是当时问卷里根本没有这一项。
     它是复盘湘雅二（评分 82 入选，实际筛败率 57%）之后才加的：
     病源足、团队强、启动快全部说对了，
     但没有人问过"你们的病人符合我们这套入排吗"。
     用 0 代替 NULL 会让那次教训在数据上消失。 */
  elig_pct     numeric(4,3) CHECK (elig_pct IS NULL OR (elig_pct >= 0 AND elig_pct <= 1)),

  status       text NOT NULL DEFAULT 'assessing'
                 CHECK (status IN ('assessing','selected','rejected')),
  decided_on   date,
  decided_by   uuid REFERENCES account(id),
  /* 入选之后指向建出来的中心。**不设 NOT NULL** ——
     决定入选和建档是两件事，中间隔着合同。 */
  study_site_id uuid REFERENCES study_site(id) ON DELETE SET NULL,
  /* 明知分低仍入选的理由。见文件头。 */
  override_reason text,
  /* 拒绝的理由。同样必须留下 —— 半年后申办方问"为什么没选这家"，
     "评分不够"不是答案，"年就诊 45 例、既往没做过、启动要 147 天"才是。 */
  reject_reason   text,

  /* 事后回填的实际月入组。**这一列是整套评分唯一能自我修正的地方。** */
  actual_rate  numeric(6,2) CHECK (actual_rate IS NULL OR actual_rate >= 0),

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT feasibility_code_uniq UNIQUE (tenant_id, code),
  /* 同一个项目不要对同一家医院的同一个科室重复调查 ——
     重复了就没人知道该看哪一份。 */
  CONSTRAINT feasibility_target_uniq UNIQUE (tenant_id, study_id, hospital, dept),
  /* 决定和决定人同生同灭：只有一半的记录，在核查时答不出"谁定的"。 */
  CONSTRAINT feasibility_decided_shape
    CHECK ((decided_on IS NULL) = (decided_by IS NULL)),
  /* 还在评估中就不该有决定；有了决定就必须有日期。 */
  CONSTRAINT feasibility_status_shape CHECK (
    (status = 'assessing' AND decided_on IS NULL)
    OR (status <> 'assessing' AND decided_on IS NOT NULL)),
  /* 拒绝必须写理由。入选的 override_reason 是**条件必填**，
     条件是"分数不够"，而分数在应用层算 —— 库里拦不住，
     所以那一条在服务里，这一条在库里：能在库里拦的就别留给应用。 */
  CONSTRAINT feasibility_reject_needs_reason CHECK (
    status <> 'rejected' OR (reject_reason IS NOT NULL AND length(btrim(reject_reason)) >= 4)),
  /* 只有入选的中心才谈得上实际入组速度。 */
  CONSTRAINT feasibility_actual_needs_selected CHECK (
    actual_rate IS NULL OR status = 'selected')
);

CREATE INDEX feasibility_study_idx ON feasibility (study_id, surveyed_on DESC);
CREATE INDEX feasibility_status_idx ON feasibility (tenant_id, status);

CREATE TRIGGER feasibility_touch BEFORE UPDATE ON feasibility
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

COMMENT ON TABLE feasibility IS
  '选址的账。报价模型算「这个项目要花多少人天」，这张表算「这家医院能不能出病人」。
   actual_rate 是唯一能让评分口径自我修正的一列 —— 没有它，评分只是一套自洽的说法。';

/* ── RLS ────────────────────────────────────────────────────────────
   两层：
     ① **外部方一行都看不到**（见文件头）；
     ② 内部按项目切：这个项目下有一个中心是我看得见的，
        这个项目的可行性调查我就看得见 —— 与 study_scope 同一条推理。

   注意候选中心**还不是 study_site**，所以不能用 site_visible 直接判它。
   判的是「这个项目对我可见吗」。 */
ALTER TABLE feasibility ENABLE ROW LEVEL SECURITY;
CREATE POLICY feasibility_scope ON feasibility FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND NOT app.current_is_external()
    AND (app.current_row_rule() = 'all' OR EXISTS (
      SELECT 1 FROM study_site s
       WHERE s.study_id = feasibility.study_id
         AND app.site_visible(s.id, s.study_id, s.hospital, s.pi_account_id))))
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND NOT app.current_is_external());

-- Down Migration
DROP POLICY IF EXISTS feasibility_scope ON feasibility;
DROP TABLE IF EXISTS feasibility;
