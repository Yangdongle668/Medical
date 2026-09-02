-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   客户 · 里程碑 · 现金流。

   ── 三件事是同一条主线：钱什么时候进来 ────────────────────────────
   在此之前系统只有**后视镜**：收入按已入组的例数确认，成本按已填的工时。
   两者都只回答"已经发生了什么"。

   而现金是另一回事：人力成本每月刚性支出，回款是**里程碑制 + 账期** ——
   一个毛利率 30% 的项目完全可能在第四个月付不出工资。
   「缺口出现在哪个月」这个问题，靠现有的任何一张表都答不出来。

   ── 0004 的那句注释到期了 ─────────────────────────────────────────
   `study.sponsor_name` 上写着「Client 聚合根在 Intake&Contract 模块建，
   届时改为 FK」。这一版就是那个时候：申办方从一个字符串变成一张表，
   因为要挂账期、联系人、合作起始年、以及**跨项目的应收账龄** ——
   而"这个客户欠了我们多少、平均拖多久"是按字符串分组算不出来的
   （同一个客户在不同项目里名字写得不完全一样，一次就够毁掉这个数）。
   ══════════════════════════════════════════════════════════════════════ */

/* ── 客户（申办方） ──────────────────────────────────────────────── */
CREATE TABLE client (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.default_tenant_id() REFERENCES tenant(id),
  name          text NOT NULL,
  /* 合作起始年。只到年 —— 记到日既问不准也没人用。 */
  since_year    int  CHECK (since_year IS NULL OR since_year BETWEEN 1980 AND 2200),
  contact       text,
  /* 合同账期（天）。**这是现金流预测里最要紧的一个数** ——
     同样一笔里程碑，月结 45 天和月结 90 天进账差一个半月。 */
  payment_terms_days int NOT NULL DEFAULT 60
    CHECK (payment_terms_days BETWEEN 0 AND 365),
  /* 关系评分 0–10。**它是主观的，所以要有出处** —— note 里写清是谁在什么时候打的。 */
  nps           int CHECK (nps IS NULL OR nps BETWEEN 0 AND 10),
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_name_uniq UNIQUE (tenant_id, name)
);
CREATE TRIGGER client_touch BEFORE UPDATE ON client
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

COMMENT ON TABLE client IS
  '申办方。从 study.sponsor_name 那个字符串升上来的（见 0004 的注释）。
   变成一张表的理由不是规范化，是**跨项目的账**：这个客户欠多少、平均拖多久、
   在手几个项目 —— 按字符串分组算这些，一次拼写不一致就够毁掉那个数。';

/* 从现有的 sponsor_name 回填，然后把 study 接上去。 */
INSERT INTO client (tenant_id, name)
  SELECT DISTINCT tenant_id, sponsor_name FROM study;

ALTER TABLE study ADD COLUMN client_id uuid REFERENCES client(id);
UPDATE study s SET client_id = c.id
  FROM client c WHERE c.tenant_id = s.tenant_id AND c.name = s.sponsor_name;
ALTER TABLE study ALTER COLUMN client_id SET NOT NULL;

/* **把老那一列删掉。** 留着它就是两个来源：改了客户名，
   台账上一半跟着变一半不变，而没有任何地方会报错。 */
ALTER TABLE study DROP COLUMN sponsor_name;

/* ── 里程碑计划：合同额按什么比例分段收 ─────────────────────────── */
CREATE TABLE milestone_plan (
  code  text PRIMARY KEY,
  label text NOT NULL,
  /* 占中心合同额的比例。五段加起来必须是 1 —— 由下面那条断言保证。 */
  ratio numeric(4,3) NOT NULL CHECK (ratio > 0 AND ratio <= 1),
  seq   smallint NOT NULL
);
INSERT INTO milestone_plan (code, label, ratio, seq) VALUES
  ('contract', '合同签署',      0.10, 1),
  ('siv',      '中心启动 SIV',  0.15, 2),
  ('half',     '入组过半',      0.25, 3),
  ('eighty',   '入组达成 80%',  0.25, 4),
  ('closeout', '中心结题',      0.25, 5);

/* 五段之和必须是 1。**在库里断言，不在文档里写** ——
   加一段忘了调别的，收入会凭空多出来一截，而没有任何地方会红。 */
DO $$
DECLARE v numeric;
BEGIN
  SELECT sum(ratio) INTO v FROM milestone_plan;
  IF v <> 1 THEN
    RAISE EXCEPTION '里程碑比例之和是 %，必须是 1', v;
  END IF;
END $$;

/* ── 里程碑：达成 → 开票 → 回款 ─────────────────────────────────── */
CREATE TABLE milestone (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.default_tenant_id() REFERENCES tenant(id),
  code          text NOT NULL,
  study_site_id uuid NOT NULL REFERENCES study_site(id) ON DELETE CASCADE,
  plan_code     text NOT NULL REFERENCES milestone_plan(code),

  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  /* 达成日。**没达成就不该有这一行** —— 未来的里程碑是预测，不是台账，
     预测由 calc 从入组速度推，不落库。混进来会凭空造出现金流。 */
  reached_on    date NOT NULL,

  state         text NOT NULL DEFAULT 'pending'
                  CHECK (state IN ('pending','invoiced','paid')),
  invoiced_on   date,
  /* 账期到期日。开票时按客户的 payment_terms_days 算出来，**落库固化** ——
     客户之后改了账期，历史发票的到期日不该跟着变。 */
  due_on        date,
  paid_on       date,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT milestone_code_uniq UNIQUE (tenant_id, code),
  /* 同一个中心的同一段只能达成一次。 */
  CONSTRAINT milestone_once UNIQUE (study_site_id, plan_code),
  /* 状态与日期必须自洽：开了票才有到期日，回了款才有回款日。 */
  CONSTRAINT milestone_invoiced_shape CHECK (
    (state = 'pending' AND invoiced_on IS NULL AND due_on IS NULL)
    OR (state <> 'pending' AND invoiced_on IS NOT NULL AND due_on IS NOT NULL)),
  CONSTRAINT milestone_paid_shape CHECK (
    (state = 'paid') = (paid_on IS NOT NULL)),
  CONSTRAINT milestone_dates CHECK (
    (invoiced_on IS NULL OR invoiced_on >= reached_on)
    AND (due_on IS NULL OR invoiced_on IS NULL OR due_on >= invoiced_on)
    AND (paid_on IS NULL OR invoiced_on IS NULL OR paid_on >= invoiced_on))
);
CREATE INDEX milestone_site_idx ON milestone (study_site_id, reached_on DESC);
/* 应收账龄查询走这条：未回款、已开票、按到期日排。 */
CREATE INDEX milestone_ar_idx ON milestone (tenant_id, state, due_on)
  WHERE state = 'invoiced';

CREATE TRIGGER milestone_touch BEFORE UPDATE ON milestone
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

COMMENT ON TABLE milestone IS
  '达成 → 开票 → 回款。只记**已达成**的 —— 未来的里程碑是从入组速度推出来的预测，
   不落库：预测混进台账会凭空造出现金流，而那正是现金流预测最容易骗人的地方。
   due_on 在开票时按客户账期算出来并固化，客户改账期不回溯历史发票。';

/* ── RLS ────────────────────────────────────────────────────────────
   · client：**对外部方整表关闭**（账期、联系人、关系评分都是商业信息），
     内部按"这个客户下有没有我看得见的中心"切。
   · milestone：跟着中心的行范围走，且同样不给外部方 ——
     一个中心收了多少钱，医院不该从我们这里看到。 */
ALTER TABLE client ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_scope ON client FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND NOT app.current_is_external()
    AND (app.current_row_rule() = 'all' OR EXISTS (
      SELECT 1 FROM study st JOIN study_site s ON s.study_id = st.id
       WHERE st.client_id = client.id
         AND app.site_visible(s.id, s.study_id, s.hospital, s.pi_account_id))))
  WITH CHECK (
    tenant_id = app.current_tenant_id() AND NOT app.current_is_external());

ALTER TABLE milestone ENABLE ROW LEVEL SECURITY;
CREATE POLICY milestone_scope ON milestone FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND NOT app.current_is_external()
    AND EXISTS (
      SELECT 1 FROM study_site s
       WHERE s.id = milestone.study_site_id
         AND app.site_visible(s.id, s.study_id, s.hospital, s.pi_account_id)))
  WITH CHECK (
    tenant_id = app.current_tenant_id() AND NOT app.current_is_external());

-- Down Migration
DROP POLICY IF EXISTS milestone_scope ON milestone;
DROP TABLE IF EXISTS milestone;
DROP TABLE IF EXISTS milestone_plan;
DROP POLICY IF EXISTS client_scope ON client;
ALTER TABLE study ADD COLUMN IF NOT EXISTS sponsor_name text;
UPDATE study s SET sponsor_name = c.name FROM client c WHERE c.id = s.client_id;
ALTER TABLE study ALTER COLUMN sponsor_name SET NOT NULL;
ALTER TABLE study DROP COLUMN IF EXISTS client_id;
DROP TABLE IF EXISTS client;
