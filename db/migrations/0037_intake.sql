-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   立项与建档：项目是**怎么进系统的**。

   ── 此前系统的第一行数据是凭空出现的 ────────────────────────────────
   `study` 和 `study_site` 一直是种子直接灌进去的。真实系统里，
   一个项目要先有人**提出来**、有人**算过账**、有人**批准**，
   然后才有档案。中间那三步在库里一条记录都没有。

   后果不是"少一张表"，是**三个问题答不出来**：
     · 这个项目当初是谁签的、按什么毛利率签的；
     · 退回重谈的那几个，退在什么理由上；
     · 合同里写了 16 个中心，系统里只建了 12 个 —— 差的四个在哪。

   最后一条是早期成本失控最常见的一种：**那四个中心的成本已经在发生**
   （伦理递交、合同谈判、可行性访视），收入却还挂不上号。

   ── 毛利门槛在立项时就要算，不等做完才知道亏 ──────────────────────
   测算毛利率低于门槛的必须过经营层那一关。门槛写在 @sitedesk/calc 里
   （INTAKE_GM_GATE），不是写在这张表上 —— 它是口径，会随年份调整，
   而调整不该需要改表结构。

   ── 申请阶段的申办方**不是**客户 ────────────────────────────────────
   所以这里存的是 sponsor_name 字符串，而不是 client_id ——
   与 0031 把 `study.sponsor_name` 升成 FK 的方向看似相反，其实一致：
   **建客户档案是批准之后的事。** 提前建，`client` 表里就会混进一堆
   没谈成的公司，而"这个客户欠我们多少"那几个数会把它们一起算进去。
   ══════════════════════════════════════════════════════════════════════ */

/* 合同里写了几个中心。**没有它就答不出「差的中心在哪」** ——
   而那正是这一版要补的那个问题。 */
ALTER TABLE study ADD COLUMN planned_sites integer;
/* 回填只能假设"合同里写的就是已经建的" —— 迁移拿不到当初的合同。
   真实数字从立项那条申请上带过来（新项目），或由人在项目档案上改（老项目）。 */
UPDATE study SET planned_sites =
  GREATEST(1, (SELECT count(*) FROM study_site s WHERE s.study_id = study.id));
ALTER TABLE study ALTER COLUMN planned_sites SET NOT NULL;
ALTER TABLE study ADD CONSTRAINT study_planned_sites_positive
  CHECK (planned_sites > 0);
COMMENT ON COLUMN study.planned_sites IS
  '合同约定的参研中心数。它与 study_site 的实际行数之差就是**建档滞后** ——
   那些中心的成本已经在发生（伦理递交、合同谈判），收入却还挂不上号。';

CREATE TABLE intake_application (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.default_tenant_id() REFERENCES tenant(id),
  code          text NOT NULL,
  drug          text NOT NULL,
  /* 申请阶段还不是客户 —— 见文件头。 */
  sponsor_name  text NOT NULL,
  phase         text NOT NULL,
  indication    text NOT NULL,
  planned_sites    integer NOT NULL CHECK (planned_sites > 0),
  planned_subjects integer NOT NULL CHECK (planned_subjects > 0),
  enroll_months    integer NOT NULL CHECK (enroll_months > 0),
  contract_cents        bigint NOT NULL CHECK (contract_cents >= 0),
  /* 测算成本。**它是手填的** —— 报价模型那一页能把它算出来，
     但立项时未必已经算过。手填的数要能被看出是手填的，所以不设默认值。 */
  estimated_cost_cents  bigint NOT NULL CHECK (estimated_cost_cents >= 0),
  note          text,
  submitted_by  uuid NOT NULL REFERENCES account(id),
  submitted_on  date NOT NULL DEFAULT CURRENT_DATE,
  state         text NOT NULL DEFAULT 'submitted'
                  CHECK (state IN ('submitted','approved','returned')),
  decided_by    uuid REFERENCES account(id),
  decided_on    date,
  /* 退回必须写理由。**不说为什么的退回，提交人只能猜** ——
     而猜错的代价是拿着同一份价格再谈一轮。 */
  decision_note text,
  /* 批准之后建出来的项目档案。它把「当初怎么签的」和「现在怎么样」连起来。 */
  study_id      uuid REFERENCES study(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, code),

  /* 结论与它的证据必须同时存在 —— 「已批准」而没有批准人，
     核查时「谁拍的板」没有答案。 */
  CONSTRAINT intake_decided_shape CHECK
    ((state = 'submitted') = (decided_by IS NULL AND decided_on IS NULL)),
  CONSTRAINT intake_returned_needs_reason CHECK
    (state <> 'returned' OR (decision_note IS NOT NULL
                             AND length(btrim(decision_note)) >= 4)),
  /* 批准了就要有项目档案；没批准的不该挂着一个项目。
     「批准了但档案没建」是这条流程最容易漏的一格，所以由约束堵死。 */
  CONSTRAINT intake_approved_has_study CHECK ((state = 'approved') = (study_id IS NOT NULL))
);
CREATE INDEX intake_open_idx ON intake_application (submitted_on)
  WHERE state = 'submitted';
CREATE TRIGGER intake_touch BEFORE UPDATE ON intake_application
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

ALTER TABLE intake_application ENABLE ROW LEVEL SECURITY;

/* 立项是**我方的商务决策**：合同额、测算成本、毛利率。
   对外部方整表关闭 —— 一家医院看得到我们按什么毛利率接的项目，
   下一轮谈判就不用谈了。 */
CREATE POLICY intake_scope ON intake_application FOR ALL
  USING (tenant_id = app.current_tenant_id() AND NOT app.current_is_external())
  WITH CHECK (tenant_id = app.current_tenant_id() AND NOT app.current_is_external());

-- Down Migration
DROP TABLE IF EXISTS intake_application;
ALTER TABLE study DROP CONSTRAINT IF EXISTS study_planned_sites_positive;
ALTER TABLE study DROP COLUMN IF EXISTS planned_sites;
