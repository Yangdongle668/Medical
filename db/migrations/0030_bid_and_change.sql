-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   投标闭环 · 合同变更。

   两张表，一条主线：**没有回写就没有校准。**

   报价模型算「按我们的人天该报多少」，`bid` 算「市场认不认」——
   报出去的价赢没赢不回写，前者就是自说自话，
   而"我们是不是系统性报高 / 报低"这个问题永远答不了。

   `contract_change` 管的是签完之后：亏损第一大原因是入组延迟，
   **第二大就是 scope creep 没有变更单** —— 方案改了、活多了，
   没人提变更，于是它只表现为毛利莫名其妙地薄了，
   而复盘时找不到那笔钱去了哪。
   ══════════════════════════════════════════════════════════════════════ */

/* ── 投标 ────────────────────────────────────────────────────────── */
CREATE TABLE bid (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.default_tenant_id() REFERENCES tenant(id),
  code          text NOT NULL,
  sponsor       text NOT NULL,
  name          text NOT NULL,
  submitted_on  date NOT NULL,
  sites         int  NOT NULL CHECK (sites > 0),
  subjects      int  NOT NULL CHECK (subjects > 0),

  /* 我们报出去的价，与当时测算的人天。**两个都要存** ——
     只存价格的话，事后没法回答"是人天估多了还是费率高了"，
     而这两条要采取的行动完全不同。 */
  our_quote_cents  bigint NOT NULL CHECK (our_quote_cents > 0),
  our_person_days  numeric(10,1) NOT NULL CHECK (our_person_days > 0),

  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','won','lost')),
  decided_on    date,
  /* 成交价。中标时是我们最终签下来的价，失标时是对手的价。
     **允许为空**：失标常常问不到对方报了多少，
     而"不知道"和"和我们一样"是两回事 —— 后者会把偏差算成 0，
     于是一次输得很惨的标在统计上看起来毫无问题。 */
  winning_price_cents bigint CHECK (winning_price_cents IS NULL OR winning_price_cents > 0),

  owner_account_id uuid REFERENCES account(id),
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT bid_code_uniq UNIQUE (tenant_id, code),
  /* 还在等结果就不该有结论日；有结论就必须有日期。 */
  CONSTRAINT bid_status_shape CHECK (
    (status = 'pending' AND decided_on IS NULL)
    OR (status <> 'pending' AND decided_on IS NOT NULL)),
  /* 中标必须知道自己签了多少 —— 那个数就在合同上。
     失标可以不知道对方的价。 */
  CONSTRAINT bid_won_needs_price CHECK (
    status <> 'won' OR winning_price_cents IS NOT NULL),
  CONSTRAINT bid_pending_has_no_price CHECK (
    status <> 'pending' OR winning_price_cents IS NULL)
);
CREATE INDEX bid_status_idx ON bid (tenant_id, status, submitted_on DESC);

CREATE TRIGGER bid_touch BEFORE UPDATE ON bid
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

COMMENT ON TABLE bid IS
  '报出去的价，赢没赢。报价模型算「按我们的人天该报多少」，这张表算「市场认不认」——
   不回写，前者就是自说自话。winning_price_cents 允许为空：
   "不知道对方报了多少"和"和我们报得一样"是两回事。';

/* ── 合同变更 ────────────────────────────────────────────────────── */
CREATE TABLE change_kind (
  code text PRIMARY KEY,
  label text NOT NULL,
  seq  smallint NOT NULL
);
INSERT INTO change_kind (code, label, seq) VALUES
  ('visit_add',   '方案修订 · 访视增加',   1),
  ('exam_add',    '方案修订 · 检查项增加', 2),
  ('subject_adj', '例数调整',             3),
  ('site_adj',    '中心增减',             4),
  ('extend',      '周期延长',             5),
  ('price_adj',   '单价调整',             6);

CREATE TABLE contract_change (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.default_tenant_id() REFERENCES tenant(id),
  code          text NOT NULL,
  study_id      uuid NOT NULL REFERENCES study(id) ON DELETE CASCADE,
  /* 有的变更是全项目的（周期延长、中心增减），有的只影响一个中心。
     **为空是正常状态**，不是漏填。 */
  study_site_id uuid REFERENCES study_site(id) ON DELETE CASCADE,
  kind          text NOT NULL REFERENCES change_kind(code),

  raised_on     date NOT NULL,
  raised_by     uuid REFERENCES account(id),
  what          text NOT NULL,

  /* 工作量影响（人天）。**可正可负** —— 例数下调是负的。 */
  person_days_impact numeric(10,2) NOT NULL,
  /* 是不是「每例」。true 时实际影响 = 影响 × 受影响的入组例数，
     而那个例数**随入组进度变化** —— 所以不存，每次算。
     存下来的话，一条"每例多 1.5 人天"的变更会永远停在提出那天的例数上，
     而它真正可怕的地方恰恰是：入组越多，白做的越多。 */
  per_subject   boolean NOT NULL DEFAULT false,

  /* 谈下来的金额。**为空 = 还没谈成或对方不给钱**，
     这正是 scope creep 的定义：活已经在做，钱没有对应。 */
  amount_cents  bigint,

  status        text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','submitted','signed','rejected')),
  decided_on    date,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT change_code_uniq UNIQUE (tenant_id, code),
  CONSTRAINT change_status_shape CHECK (
    (status IN ('draft','submitted') AND decided_on IS NULL)
    OR (status IN ('signed','rejected') AND decided_on IS NOT NULL)),
  /* 已签署必须有金额 —— 哪怕是 0。**0 和 NULL 在这里差别极大**：
     0 是"谈过了，对方不给钱，我们认了"，NULL 是"还没谈"。
     前者是决策，后者是欠账。 */
  CONSTRAINT change_signed_needs_amount CHECK (
    status <> 'signed' OR amount_cents IS NOT NULL),
  /* 中心级的变更，中心必须属于这个项目 —— 这一条在服务里校验，
     库里拦不住（要跨表），所以这里只放该放的：
     study_site_id 为空是全项目变更。 */
  CONSTRAINT change_kind_known CHECK (length(kind) > 0)
);
CREATE INDEX change_study_idx ON contract_change (study_id, raised_on DESC);
CREATE INDEX change_status_idx ON contract_change (tenant_id, status);

CREATE TRIGGER contract_change_touch BEFORE UPDATE ON contract_change
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

COMMENT ON TABLE contract_change IS
  '亏损第一大原因是入组延迟，第二大就是 scope creep 没有变更单。
   就算最终要不到钱也必须记下来 —— 下次报价时这就是该加进去的成本。
   amount_cents 为 NULL 是"还没谈"，为 0 是"谈过了对方不给" —— 两者差别极大。';

/* ── RLS ────────────────────────────────────────────────────────────
   两张表都是**商业数据，对外部方整表关闭** ——
   投标价格与合同变更金额落到医院或申办方手里都是直接的商业损失。

   内部：
     · bid 还没有项目（那正是投标的意思），所以按租户切，不按项目 ——
       它由 `bid` 动作权限收敛（只有经营层 / PM / 管理员有）。
     · contract_change 挂在项目上，按项目切，与 feasibility 同一条推理。 */
ALTER TABLE bid ENABLE ROW LEVEL SECURITY;
CREATE POLICY bid_scope ON bid FOR ALL
  USING (tenant_id = app.current_tenant_id() AND NOT app.current_is_external())
  WITH CHECK (tenant_id = app.current_tenant_id() AND NOT app.current_is_external());

ALTER TABLE contract_change ENABLE ROW LEVEL SECURITY;
CREATE POLICY contract_change_scope ON contract_change FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND NOT app.current_is_external()
    AND (app.current_row_rule() = 'all' OR EXISTS (
      SELECT 1 FROM study_site s
       WHERE s.study_id = contract_change.study_id
         AND app.site_visible(s.id, s.study_id, s.hospital, s.pi_account_id))))
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND NOT app.current_is_external());

-- Down Migration
DROP POLICY IF EXISTS contract_change_scope ON contract_change;
DROP TABLE IF EXISTS contract_change;
DROP TABLE IF EXISTS change_kind;
DROP POLICY IF EXISTS bid_scope ON bid;
DROP TABLE IF EXISTS bid;
