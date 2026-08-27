-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   关闭闸门欠的那四项（欠账 B6），与 SAE 台账（欠账 D7）。

   ── 这是一条挂了五个阶段的已知问题 ────────────────────────────────
   `modules/site/gate.ts` 里的关闭闸门有八项前置条件，其中四项从 Phase 4a
   起就是 `pending()` 占位：

     ip-imbalance      药品数量不平衡          （clinical，尚未交付）
     ip-not-destroyed  回收药品未完成销毁登记  （clinical，尚未交付）
     specimen-open     生物样本链未闭环        （clinical，尚未交付）
     closeout-report   未向伦理递交结题报告    （regulatory，尚未交付）

   fail-closed 是对的：把「查不了」当成「通过」，等于允许在药品差三盒的
   时候关闭中心。但它的现实后果是 —— **现在没有任何一个中心关得掉**。
   闸门看起来在把关，实际上是一堵墙。

   这一支迁移把那四项背后的数据建起来，让四条真查询取代四个占位。
   刻意建到"够闸门用、够台账看"为止：完整的药品管理与样本管理是
   两个独立的产品模块，不该借着补闸门的名义一次长出来。

   ── 三张表的边界 ──────────────────────────────────────────────────
   · ip_movement          药品出入库流水（只追加）
   · specimen             生物样本，一行一管，带链路上的四个时点
   · regulatory_submission 伦理递交与批复
   ══════════════════════════════════════════════════════════════════════ */

/* ── 一、药品台账 ──────────────────────────────────────────────────
   只追加的流水，不存"当前库存"这个数：存了就要维护，而维护就会错。
   库存是**算出来的**（见 app.ip_balance），算不平就是不平。 */
CREATE TABLE ip_movement (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.default_tenant_id() REFERENCES tenant(id),
  study_site_id uuid NOT NULL REFERENCES study_site(id),
  moved_on      date NOT NULL DEFAULT CURRENT_DATE,
  /* receipt  申办方发货到中心（+）
     dispense 发给受试者（−）
     return   受试者退回中心（+，退回来的药还在中心手里）
     ship_back 退回申办方（−）
     destroy  就地销毁登记（−） */
  kind          text NOT NULL CHECK (kind IN
                  ('receipt','dispense','return','ship_back','destroy')),
  quantity      int  NOT NULL CHECK (quantity > 0),
  subject_ref   text,                       -- 只存筛选号/随机号，不存可识别信息
  ref_no        text,                       -- 发货单号 / 销毁记录编号
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES account(id)
);
COMMENT ON TABLE ip_movement IS
  '药品出入库流水，只追加。库存不存成一个数 —— 存了就要维护，维护就会错；'
  ' 库存由 app.ip_balance() 算出来，算不平就是真的不平。';
CREATE INDEX ip_movement_site_idx ON ip_movement (study_site_id, moved_on);

/* 中心当前在手的药量。+receipt +return −dispense −ship_back −destroy。
   **可能为负** —— 那不是要藏起来的错，那正是"账不平"的样子。 */
/* **刻意不是 SECURITY DEFINER**：让 RLS 照常生效。
   加了 DEFINER 的话，任何人拿一个中心 id 就能问出它的库存数 ——
   范围之外的东西连"它有多少药"都不该答得出来（这与「范围外一律 404」
   是同一条规矩）。在闸门这个调用点上中心本来就是可见的，
   所以不加也够用。 */
CREATE FUNCTION app.ip_balance(p_site_id uuid) RETURNS int
  LANGUAGE sql STABLE SET search_path = public, app, pg_temp AS
$$
  SELECT COALESCE(SUM(CASE m.kind
           WHEN 'receipt'   THEN  m.quantity
           WHEN 'return'    THEN  m.quantity
           WHEN 'dispense'  THEN -m.quantity
           WHEN 'ship_back' THEN -m.quantity
           WHEN 'destroy'   THEN -m.quantity END), 0)::int
    FROM ip_movement m WHERE m.study_site_id = p_site_id
$$;
COMMENT ON FUNCTION app.ip_balance(uuid) IS
  '中心在手药量。为负说明发出去的比收到的多 —— 记账错了，不是可以忽略的小事。';

/* ── 二、生物样本 ──────────────────────────────────────────────────
   一行一管。链路只关心四个时点，够回答"这管样本现在在哪"。 */
CREATE TABLE specimen (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.default_tenant_id() REFERENCES tenant(id),
  study_site_id uuid NOT NULL REFERENCES study_site(id),
  subject_ref   text NOT NULL,              -- 筛选号/随机号，绝不存姓名
  kind          text NOT NULL,              -- 血样 / 尿样 / 组织…
  collected_on  date NOT NULL,
  shipped_on    date,
  received_on   date,                       -- 中心实验室确认收到
  discarded_on  date,                       -- 就地销毁 / 作废，也算闭环
  tracking_no   text,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT specimen_flow CHECK (
    (shipped_on  IS NULL OR shipped_on  >= collected_on) AND
    (received_on IS NULL OR shipped_on IS NOT NULL) AND
    (received_on IS NULL OR received_on >= shipped_on)),
  /* 收到和销毁是两个互斥的结局。两个都填说明有人在补记，
     而补记要先说清楚到底是哪一个。 */
  CONSTRAINT specimen_one_ending CHECK (received_on IS NULL OR discarded_on IS NULL)
);
COMMENT ON TABLE specimen IS
  '生物样本。闭环 = 已被中心实验室确认收到，或已就地销毁登记。'
  ' 采了却两样都没有的，是"在路上不知去向"—— 中心一关就再也查不清。';
CREATE INDEX specimen_open_idx ON specimen (study_site_id)
  WHERE received_on IS NULL AND discarded_on IS NULL;

/* ── 三、伦理递交与批复 ────────────────────────────────────────────── */
CREATE TABLE regulatory_submission (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.default_tenant_id() REFERENCES tenant(id),
  study_site_id uuid NOT NULL REFERENCES study_site(id),
  kind          text NOT NULL CHECK (kind IN ('initial','amendment','annual','closeout')),
  submitted_on  date NOT NULL,
  decision      text NOT NULL DEFAULT 'pending'
                  CHECK (decision IN ('pending','approved','rejected')),
  decided_on    date,
  ref_no        text,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT regulatory_decided CHECK (
    (decision = 'pending' AND decided_on IS NULL) OR
    (decision <> 'pending' AND decided_on IS NOT NULL)),
  CONSTRAINT regulatory_decided_after CHECK (decided_on IS NULL OR decided_on >= submitted_on)
);
COMMENT ON TABLE regulatory_submission IS
  '伦理递交与批复。关闭闸门看的是 kind=closeout 且 decision=approved 的那一条 ——'
  ' 递交了但没批下来，中心还不能关。';
CREATE INDEX regulatory_site_idx ON regulatory_submission (study_site_id, kind);

/* ── 四、SAE 的两个时点（欠账 D7）──────────────────────────────────
   I6 是「SAE 24 小时上报及时率」。quality_event 里一直有 `sae_late`
   这个 kind，但它记的是**结果**（已经晚了），算不出及时率 ——
   算及时率要的是「发生时刻」与「上报时刻」两个点。

   加成可空列，向后兼容：旧代码不写它们，旧数据也不需要回填。 */
ALTER TABLE quality_event ADD COLUMN occurred_at timestamptz;
ALTER TABLE quality_event ADD COLUMN reported_at timestamptz;
COMMENT ON COLUMN quality_event.occurred_at IS
  'SAE 发生（或研究者获知）的时刻。I6 的起点。';
COMMENT ON COLUMN quality_event.reported_at IS
  '向申办方/伦理上报的时刻。I6 = reported_at − occurred_at ≤ 24h 的比例。';
ALTER TABLE quality_event ADD CONSTRAINT quality_event_sae_order
  CHECK (reported_at IS NULL OR occurred_at IS NULL OR reported_at >= occurred_at);

/* kind 里加一个 'sae' —— 原来只有 'sae_late'（已经晚了的那些）。
   只加取值，不删旧的：旧行照常合法。 */
ALTER TABLE quality_event DROP CONSTRAINT quality_event_kind_check;
ALTER TABLE quality_event ADD CONSTRAINT quality_event_kind_check
  CHECK (kind IN ('deviation','query','ip_discrepancy','sae','sae_late','other'));

/* ── RLS：三张新表都按中心切 ───────────────────────────────────────
   规约 4：带 tenant_id 的表必须开 RLS，且用同一套 app.site_visible。 */
ALTER TABLE ip_movement            ENABLE ROW LEVEL SECURITY;
ALTER TABLE specimen               ENABLE ROW LEVEL SECURITY;
ALTER TABLE regulatory_submission  ENABLE ROW LEVEL SECURITY;

CREATE POLICY ip_movement_scope ON ip_movement FOR ALL
  USING (tenant_id = app.current_tenant_id()
         AND app.site_visible_by_id(ip_movement.study_site_id))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND app.site_visible_by_id(ip_movement.study_site_id));

CREATE POLICY specimen_scope ON specimen FOR ALL
  USING (tenant_id = app.current_tenant_id()
         AND app.site_visible_by_id(specimen.study_site_id))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND app.site_visible_by_id(specimen.study_site_id));

CREATE POLICY regulatory_scope ON regulatory_submission FOR ALL
  USING (tenant_id = app.current_tenant_id()
         AND app.site_visible_by_id(regulatory_submission.study_site_id))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND app.site_visible_by_id(regulatory_submission.study_site_id));

/* 只追加：药品流水与样本不许改历史。改历史等于让台账说另一句话，
   而核查看的就是这本台账。 */
CREATE TRIGGER ip_movement_append_only BEFORE UPDATE OR DELETE ON ip_movement
  FOR EACH STATEMENT EXECUTE FUNCTION app.deny_mutation();

-- Down Migration
DROP TRIGGER IF EXISTS ip_movement_append_only ON ip_movement;
DROP TABLE IF EXISTS regulatory_submission;
DROP TABLE IF EXISTS specimen;
DROP FUNCTION IF EXISTS app.ip_balance(uuid);
DROP TABLE IF EXISTS ip_movement;
ALTER TABLE quality_event DROP CONSTRAINT IF EXISTS quality_event_sae_order;
ALTER TABLE quality_event DROP COLUMN IF EXISTS occurred_at;
ALTER TABLE quality_event DROP COLUMN IF EXISTS reported_at;
ALTER TABLE quality_event DROP CONSTRAINT IF EXISTS quality_event_kind_check;
ALTER TABLE quality_event ADD CONSTRAINT quality_event_kind_check
  CHECK (kind IN ('deviation','query','ip_discrepancy','sae_late','other'));
