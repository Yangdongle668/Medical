-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   CAPA 与内部稽查 —— 我方的第二道防线。

   ── 机构质控是医院查我们，稽查是我们自己查自己 ────────────────────
   两件事都产出「发现项」，但它们的意义完全不同：
   机构查出来的问题我方不能自行关闭（0009 就写着这条），
   而自己查出来的问题，价值不在于又发现了一批，
   **在于 CAPA 有效性验证：同类问题是否复发。**

   复发 = 当初只做了纠正，没做预防。
   「研究者集中补签并留痕」是纠正；补完签名，下个月照样缺。
   预防是把签名完整性做进 CRC 每周自查清单并留痕。
   **只做纠正不做预防的 CAPA，等于把同一个核查风险往后推了一个季度。**

   ── 复发为什么用外键，而不是记一个编号字符串 ──────────────────────
   原型的 capaEffect() 拿 f.repeat 这个字符串去 ISSUES 里找源事件，
   找不到就 `if(!src) return;` —— **静默丢掉**。
   而这个指标存在的全部理由就是抓复发：丢掉一条复发，
   它就从"无效"变回"有效"，而没有任何地方会报错。
   外键让这件事不可能发生。

   ── CAPA 落在质量事件上，不是另一张表 ────────────────────────────
   一条质量事件的整改措施、责任人、完成期限，是它自己的属性。
   拆成 capa 表，「这条事件的整改做完没有」就要 join 才答得出，
   而更糟的是可以出现"有 CAPA 没有事件"和"一条事件两份 CAPA"。

   ── category 是给 CAPA 有效性分组用的 ────────────────────────────
   `kind` 只有五个取值（偏离/质疑/药品不平衡/SAE/其他），
   按它分组，「源数据缺陷」和「知情同意版本错误」会落进同一格 ——
   而这两类问题的根因与预防措施毫无共同之处。
   ══════════════════════════════════════════════════════════════════════ */

/* ── 来源方补上申办方稽查与中心自查 ────────────────────────────────
   它们不是装饰：「同类问题总是被谁发现的」本身就是一个结论 ——
   如果某一类问题永远由申办方稽查发现、我方监查从来没查出来过，
   那要改的是 SDV 抽样策略，不是中心。 */
ALTER TABLE quality_event DROP CONSTRAINT quality_event_raised_by_check;
ALTER TABLE quality_event ADD CONSTRAINT quality_event_raised_by_check
  CHECK (raised_by IN ('system','cra','qa','institution','dm','sponsor','site'));

ALTER TABLE quality_event
  ADD COLUMN category              text,
  ADD COLUMN capa_plan             text,
  ADD COLUMN capa_owner_account_id uuid REFERENCES account(id),
  ADD COLUMN capa_due_on           date;

COMMENT ON COLUMN quality_event.category IS
  '问题类型（比 kind 细）。CAPA 有效性按它分组 ——
   按 kind 分的话，「源数据缺陷」和「知情同意版本错误」会落进同一格，
   而这两类的根因与预防措施毫无共同之处。';
COMMENT ON COLUMN quality_event.capa_plan IS
  '纠正与预防措施。**只写纠正不写预防的 CAPA，等于把同一个核查风险
   往后推了一个季度** —— 而这件事只有在同类问题复发时才看得出来。';

/* 责任人与期限同生共死；措施可以晚一步，但不能没有人。

   **「已指派、还没提交整改措施」是一个真实存在的状态**（原型里叫「待整改」）——
   机构质控刚提出来的三条就是这样：责任人和期限当场就定了，
   措施要受托方写。把三者绑成全有或全无，这个状态就没法表达，
   而它恰恰是最需要被看见的那一个：**有人欠着一份措施。**

   反过来不成立：有措施而没有责任人，「谁去做」没有答案。 */
ALTER TABLE quality_event ADD CONSTRAINT quality_capa_shape CHECK (
  (capa_owner_account_id IS NULL) = (capa_due_on IS NULL)
  AND (capa_plan IS NULL OR capa_owner_account_id IS NOT NULL));

/* 质疑走的是自己的闭环（回复 → 判定），不挂 CAPA。
   给它挂一份整改措施，读的人会以为质疑也要走整改流程。 */
ALTER TABLE quality_event ADD CONSTRAINT quality_capa_not_on_query CHECK (
  kind <> 'query' OR capa_plan IS NULL);

/* ── 内部稽查 ─────────────────────────────────────────────────── */
CREATE TABLE internal_audit (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.default_tenant_id() REFERENCES tenant(id),
  code          text NOT NULL,
  study_site_id uuid NOT NULL REFERENCES study_site(id),
  kind          text NOT NULL CHECK (kind IN
                  ('site','system','capa_check','pre_inspection')),
  audited_on    date NOT NULL,
  auditor_account_id uuid NOT NULL REFERENCES account(id),
  /* 稽查范围。**空范围的稽查等于没查** —— 事后说不清"当时看了什么"。 */
  scope         text NOT NULL CHECK (length(btrim(scope)) >= 4),
  state         text NOT NULL DEFAULT 'open'
                  CHECK (state IN ('open','remediating','closed')),
  closed_at     timestamptz,
  closed_by     uuid REFERENCES account(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  CONSTRAINT audit_closed_shape CHECK
    ((state = 'closed') = (closed_at IS NOT NULL AND closed_by IS NOT NULL))
);
CREATE INDEX internal_audit_site_idx ON internal_audit (study_site_id, audited_on);
CREATE TRIGGER internal_audit_touch BEFORE UPDATE ON internal_audit
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

/* 主键是 (audit_id, seq)，不是一个合成 id ——
   **这张表没有 tenant_id，租户归属只能从主键里的外键推导出来。**
   给它一个 `id uuid PRIMARY KEY`，归属就断了：
   db/test 里那条「每张业务表的租户归属都能被推导出来」会立刻红，
   而真实后果是**行策略写不出来** —— 事后补 tenant_id 要动全部外键与全部策略。
   monitor_visit_item 与 subject_visit_task 也是这个形状。 */
CREATE TABLE audit_finding (
  audit_id   uuid NOT NULL REFERENCES internal_audit(id) ON DELETE CASCADE,
  seq        int NOT NULL,
  severity   text NOT NULL CHECK (severity IN ('minor','major','critical')),
  finding    text NOT NULL,
  /* 复发：这一条稽查发现，是此前那条质量事件的**同一个问题又出现了**。

     两种复发都算数，而且要分得开：
       · 源事件已关闭 → **关闭后复发**：当初只做了纠正，没做预防；
       · 源事件还开着 → **整改期内复发**：措施根本没起作用。
     原型的数据正是后一种（QI-2026-0151 还在 CAPA 进行中就又出现了），
     所以这里不强求源事件已关闭 —— 强求的话，最能说明问题的那条会被拒收。

     用外键而不是记一个编号字符串：原型的 capaEffect() 拿字符串去找源事件，
     找不到就静默丢掉 —— 而这个指标存在的全部理由就是抓复发。
     （「源事件必须早于本次稽查」由服务层校验：CHECK 跨不了表。） */
  repeat_of  uuid REFERENCES quality_event(id),
  state      text NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed')),
  /* 验证整改的说明。**「已整改」三个字不是验证** ——
     核查时看的是"你怎么确认它真的改了"。 */
  verification text,
  closed_at  timestamptz,
  closed_by  uuid REFERENCES account(id),
  PRIMARY KEY (audit_id, seq),
  CONSTRAINT finding_closed_shape CHECK
    ((state = 'closed') = (closed_at IS NOT NULL AND closed_by IS NOT NULL
                           AND verification IS NOT NULL))
);
CREATE INDEX audit_finding_repeat_idx ON audit_finding (repeat_of)
  WHERE repeat_of IS NOT NULL;

ALTER TABLE internal_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_finding  ENABLE ROW LEVEL SECURITY;

/* 内部稽查是**我方查自己**。外部方整表关闭 ——
   把自查报告给被查方看，下一次自查就查不出东西了。 */
CREATE POLICY internal_audit_scope ON internal_audit FOR ALL
  USING (tenant_id = app.current_tenant_id()
         AND NOT app.current_is_external()
         AND app.site_visible_by_id(internal_audit.study_site_id))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND NOT app.current_is_external()
              AND app.site_visible_by_id(internal_audit.study_site_id));

CREATE POLICY audit_finding_scope ON audit_finding FOR ALL
  USING (EXISTS (SELECT 1 FROM internal_audit a WHERE a.id = audit_id))
  WITH CHECK (EXISTS (SELECT 1 FROM internal_audit a WHERE a.id = audit_id));

-- Down Migration
DROP TABLE IF EXISTS audit_finding;
DROP TABLE IF EXISTS internal_audit;
ALTER TABLE quality_event
  DROP CONSTRAINT IF EXISTS quality_capa_shape,
  DROP CONSTRAINT IF EXISTS quality_capa_not_on_query;
ALTER TABLE quality_event
  DROP COLUMN IF EXISTS category,
  DROP COLUMN IF EXISTS capa_plan,
  DROP COLUMN IF EXISTS capa_owner_account_id,
  DROP COLUMN IF EXISTS capa_due_on;
/* 申办方稽查与中心自查发现的事件在回退后没有合法的来源 —— 归给 qa，
   因为它们确实是"质量条线发现的"。丢掉的是"具体是谁查出来的"。 */
UPDATE quality_event SET raised_by = 'qa' WHERE raised_by IN ('sponsor','site');
ALTER TABLE quality_event DROP CONSTRAINT quality_event_raised_by_check;
ALTER TABLE quality_event ADD CONSTRAINT quality_event_raised_by_check
  CHECK (raised_by IN ('system','cra','qa','institution','dm'));
