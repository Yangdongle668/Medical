/* ══════════════════════════════════════════════════════════════════════
   演示数据：药品流水、生物样本、伦理递交、SAE。

   为什么要专门铺这一份 —— 关闭闸门的八项前置条件里有四项看的是这些表。
   一份没有它们的演示库，界面上永远画不出"关不掉中心，是因为这几件事"，
   于是也没有人会发现那几条查询其实没写对。

   刻意**各摆一种坏情况**：药品有 18 份在手、SAE 有一条超时未报。
   只摆好的那种，界面上"最坏的一条""还在计时"那几块永远不出现。
   ══════════════════════════════════════════════════════════════════════ */

/* ── 药品：SS-01 收 30 发 12，在手 18（关闭闸门会拦下它） ────────── */
INSERT INTO ip_movement (study_site_id, moved_on, kind, quantity, subject_ref, ref_no, note)
SELECT s.id, CURRENT_DATE - 40, 'receipt', 30, NULL, 'SF-2026-0011', '首批到货'
  FROM study_site s WHERE s.code = 'SS-01';
INSERT INTO ip_movement (study_site_id, moved_on, kind, quantity, subject_ref, ref_no, note)
SELECT s.id, CURRENT_DATE - 21, 'dispense', 12, 'S-0331', NULL, 'C1–C4 周期发放'
  FROM study_site s WHERE s.code = 'SS-01';

/* SS-02 账是平的 —— 台账上要有一个"正常"的样子做对照 */
INSERT INTO ip_movement (study_site_id, moved_on, kind, quantity, subject_ref, ref_no, note)
SELECT s.id, CURRENT_DATE - 60, 'receipt', 20, NULL, 'SF-2026-0007', '到货'
  FROM study_site s WHERE s.code = 'SS-02';
INSERT INTO ip_movement (study_site_id, moved_on, kind, quantity, subject_ref, ref_no, note)
SELECT s.id, CURRENT_DATE - 10, 'ship_back', 20, NULL, 'SF-2026-0099', '结题退回申办方'
  FROM study_site s WHERE s.code = 'SS-02';

/* ── 生物样本：一管在路上（关闭闸门拦），一管已闭环 ──────────────── */
INSERT INTO specimen (study_site_id, subject_ref, kind, collected_on, shipped_on,
                      received_on, tracking_no)
SELECT s.id, 'S-0331', '血样（PK）', CURRENT_DATE - 12, CURRENT_DATE - 11,
       NULL, 'SF7712003456'
  FROM study_site s WHERE s.code = 'SS-01';
INSERT INTO specimen (study_site_id, subject_ref, kind, collected_on, shipped_on,
                      received_on, tracking_no)
SELECT s.id, 'S-0203', '血样（PK）', CURRENT_DATE - 30, CURRENT_DATE - 29,
       CURRENT_DATE - 27, 'SF7712001122'
  FROM study_site s WHERE s.code = 'SS-01';

/* ── 伦理递交：初始已批，结题还没递 ─────────────────────────────── */
INSERT INTO regulatory_submission (study_site_id, kind, submitted_on, decision,
                                   decided_on, ref_no, note)
SELECT s.id, 'initial', CURRENT_DATE - 300, 'approved', CURRENT_DATE - 270,
       'EC-2025-0417', '初始审查通过'
  FROM study_site s WHERE s.code = 'SS-01';

/* SS-02 结题报告递了但**还没批** —— 闸门看的是批复，不是递交 */
INSERT INTO regulatory_submission (study_site_id, kind, submitted_on, decision,
                                   decided_on, ref_no, note)
SELECT s.id, 'closeout', CURRENT_DATE - 20, 'pending', NULL, 'EC-2026-0088',
       '结题报告已递交，等待伦理例会'
  FROM study_site s WHERE s.code = 'SS-02';

/* ── SAE：一条按时（8.5 小时），一条超时未报（52 小时） ──────────── */
INSERT INTO quality_event (code, study_site_id, kind, severity, state, title, detail,
                           auto_generated, raised_by, raised_on, occurred_at, reported_at)
SELECT 'SAE-2026-0001', s.id, 'sae', 'critical', 'open',
       '受试者出现 III 度中性粒细胞减少',
       '住院对症治疗，研究者判定与试验药物可能相关；已通知申办方医学监查。',
       false, 'cra', (now() - interval '31.5 hours')::date,
       now() - interval '31.5 hours', now() - interval '23 hours'
  FROM study_site s WHERE s.code = 'SS-01';

INSERT INTO quality_event (code, study_site_id, kind, severity, state, title, detail,
                           auto_generated, raised_by, raised_on, occurred_at, reported_at)
SELECT 'SAE-2026-0002', s.id, 'sae', 'critical', 'open',
       '受试者因肝功能异常住院',
       '尚在整理上报材料 —— 已经超过 24 小时时限。',
       false, 'cra', (now() - interval '52 hours')::date,
       now() - interval '52 hours', NULL
  FROM study_site s WHERE s.code = 'SS-01';
