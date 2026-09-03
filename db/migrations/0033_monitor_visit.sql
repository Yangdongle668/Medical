-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   监查访视（SIV / IMV / COV）与监查报告跟进项。

   ── 「去过」和「报告交了」是两件事 ────────────────────────────────
   原型把访视状态写成 待确认 → 已排期 → 已提交，中间少了一格：
   **现场做完了，但监查报告还没写。**

   而 MVR 滞后正是监查这件事上最常见的欠账 ——
   人去了、问题也看见了，报告压在 CRA 手上两个月，
   于是中心那边"该整改的事"根本没开始。
   核查时看的是报告日期，不是出差日期。

   所以 performed_on 与 report_submitted_on 分开存，
   「访视做完到报告提交隔了多少天」才有答案。

   ── 跟进项全部关闭才能提交报告 ────────────────────────────────────
   这是原型自己写下的闸门。它和 SIV 闸门是同一类东西：
   **拦的时候要说得出拦在哪一项**，而不是一句"条件不满足"。

   ── 抽样比例落在行上，不是拍脑袋 ──────────────────────────────────
   原型写着「监查频率来自风险分级，不是一刀切」，但没有落到数据上。
   sdv_sample_pct 存的是**这一次实际用了多少抽样比例** ——
   它是当时那次决定的证据。建议值由 @sitedesk/calc 从质量信号算，
   但人可以不采纳；不采纳这件事本身要留得下来。
   ══════════════════════════════════════════════════════════════════════ */

CREATE TABLE monitor_visit (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.default_tenant_id() REFERENCES tenant(id),
  code          text NOT NULL,
  study_site_id uuid NOT NULL REFERENCES study_site(id),
  kind          text NOT NULL CHECK (kind IN ('siv','imv','cov')),
  /* 计划日期。改期要留痕（审计轨迹），所以这里只有一个"当前计划" */
  planned_on    date NOT NULL,
  monitor_account_id uuid NOT NULL REFERENCES account(id),
  /* 人天。差旅与工时都按它折算，所以不能是 0 —— 一次 0 天的监查，
     成本口径上等于没去过。 */
  days          numeric(4,1) NOT NULL CHECK (days > 0 AND days <= 30),
  state         text NOT NULL DEFAULT 'proposed'
                  CHECK (state IN ('proposed','scheduled','done','reported')),
  confirmed_on  date,
  performed_on  date,
  report_submitted_on date,
  /* SDV 抽样比例（%）。质量稳定的中心可以降，但**降到多少要留下来**。 */
  sdv_sample_pct int CHECK (sdv_sample_pct BETWEEN 1 AND 100),
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, code),

  /* 状态与它的证据必须同时存在 —— 「已排期」而没有确认日期，
     "什么时候跟中心敲定的"就没有答案。 */
  CONSTRAINT monitor_scheduled_needs_confirm CHECK
    (state = 'proposed' OR confirmed_on IS NOT NULL),
  CONSTRAINT monitor_done_needs_performed CHECK
    (state IN ('proposed','scheduled') OR performed_on IS NOT NULL),
  CONSTRAINT monitor_reported_needs_date CHECK
    ((state = 'reported') = (report_submitted_on IS NOT NULL)),
  /* 报告不可能早于现场。日期倒挂的行在统计"报告滞后"时会算出负数，
     而负数会把整个中心的均值拉好看。 */
  CONSTRAINT monitor_report_after_visit CHECK
    (report_submitted_on IS NULL OR performed_on IS NULL
     OR report_submitted_on >= performed_on)
);
CREATE INDEX monitor_visit_site_idx ON monitor_visit (study_site_id, planned_on);
CREATE INDEX monitor_visit_open_idx ON monitor_visit (planned_on)
  WHERE state <> 'reported';
CREATE TRIGGER monitor_visit_touch BEFORE UPDATE ON monitor_visit
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

COMMENT ON COLUMN monitor_visit.report_submitted_on IS
  '监查报告（MVR）提交日。**与 performed_on 分开存** ——
   人去了、问题也看见了，报告压两个月，中心那边该整改的事就没开始；
   而核查时看的是报告日期，不是出差日期。';
COMMENT ON COLUMN monitor_visit.sdv_sample_pct IS
  '这一次实际用的 SDV 抽样比例。建议值由风险分级算出，但人可以不采纳 ——
   不采纳这件事本身要留得下来，否则"为什么这次只抽了 30%"没有答案。';

/* 监查报告跟进项（MVR Follow-up）。
   它不是"待办清单"：每一项都是这次现场看出来的、要中心去做的事。
   全部关闭之前，报告提不了。 */
CREATE TABLE monitor_visit_item (
  visit_id   uuid NOT NULL REFERENCES monitor_visit(id) ON DELETE CASCADE,
  seq        int NOT NULL,
  task       text NOT NULL,
  done_at    timestamptz,
  done_by    uuid REFERENCES account(id),
  PRIMARY KEY (visit_id, seq),
  CONSTRAINT monitor_item_done_needs_actor CHECK ((done_at IS NULL) = (done_by IS NULL))
);

ALTER TABLE monitor_visit      ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitor_visit_item ENABLE ROW LEVEL SECURITY;

/* 监查是**我方对中心的作业**。外部方整表关闭：
   一个机构办看得到我们打算什么时候去、抽多少比例，
   等于把监查策略交给了被监查的一方。 */
CREATE POLICY monitor_visit_scope ON monitor_visit FOR ALL
  USING (tenant_id = app.current_tenant_id()
         AND NOT app.current_is_external()
         AND app.site_visible_by_id(monitor_visit.study_site_id))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND NOT app.current_is_external()
              AND app.site_visible_by_id(monitor_visit.study_site_id));

/* 跟进项跟着它的访视走 —— 单独写一份中心可见性判断，
   两处迟早会分叉。 */
CREATE POLICY monitor_visit_item_scope ON monitor_visit_item FOR ALL
  USING (EXISTS (SELECT 1 FROM monitor_visit v WHERE v.id = visit_id))
  WITH CHECK (EXISTS (SELECT 1 FROM monitor_visit v WHERE v.id = visit_id));

-- Down Migration
DROP TABLE IF EXISTS monitor_visit_item;
DROP TABLE IF EXISTS monitor_visit;
