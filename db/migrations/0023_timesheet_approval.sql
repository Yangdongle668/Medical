-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   工时审批（欠账 D4）。

   在此之前：填了就进成本，没有「待审 → 通过」这一环。
   `approve` 这个动作权限存在，但只用来作废别人的填报。

   ── 一个必须先答的问题：未审的工时算不算成本？ ────────────────────
   两条路都说得通，但只有一条是对的：

   ① 不算 —— 损益里只有已审的成本。**这条不行**：人已经把活干了，
      成本已经发生。不算进去，毛利就比实际好看，而"比实际好看"
      正是这套系统一直在防的那种失真。等审批补上，毛利会突然掉一截，
      而那时没有人说得清是经营变差了还是审批积压了。

   ② 算，但**标出来有多少还没审**。损益是完整的，
      同时看得见"这里面有多少是待审的"。

   走 ②。于是 `approved_at` 不影响任何金额，它只回答一个问题：
   **这笔工时有没有被第二个人看过。**

   ── 审批的全部价值在于「第二个人」 ────────────────────────────────
   所以有一条不能让步的规则：**不能审自己填的工时**。
   自审等于没有审批流，只是多了一次点击 —— 而多出来的那次点击
   会让人以为这里已经有把关了。

   这条规则放在**数据库**里，不只在应用层：应用层会有第二个入口
   （批量审批、脚本、以后的定时结算），而这条规则没有例外。

   作废与审批是两件事：作废是"这笔不该存在"（成本退出统计），
   审批是"这笔我看过了"。已作废的不需要审 —— 它已经不在成本里了。
   ══════════════════════════════════════════════════════════════════════ */

ALTER TABLE timesheet_entry
  ADD COLUMN approved_at timestamptz,
  ADD COLUMN approved_by uuid REFERENCES account(id);

COMMENT ON COLUMN timesheet_entry.approved_at IS
  '审批通过的时刻。**不影响成本**：人已经干了活，成本已经发生 —— 它只回答"有没有被第二个人看过"。';

ALTER TABLE timesheet_entry ADD CONSTRAINT timesheet_approved_pair CHECK
  ((approved_at IS NULL) = (approved_by IS NULL));

/* 审自己填的等于没有审批流，只是多了一次点击 ——
   而多出来的那次点击会让人以为这里已经有把关了。 */
ALTER TABLE timesheet_entry ADD CONSTRAINT timesheet_no_self_approve CHECK
  (approved_by IS NULL OR approved_by <> account_id);

/* 「还有哪些没审」是审批页每次都要问的那一句 */
CREATE INDEX timesheet_unapproved_idx
  ON timesheet_entry (study_site_id, work_date)
  WHERE approved_at IS NULL AND voided_at IS NULL;

/* ── 审过的不能"撤回审批" ──────────────────────────────────────────
   `timesheet_immutable()`（迁移 0010）守着归属、工时数与成本，
   但新加的两列不在它的名单里 —— 于是把 approved_at 改回 NULL 是通的，
   而那等于把"我看过了"这件事抹掉重来。

   改错了要往前走，不能往回改：作废这一笔，重报一笔新的。
   这和"工时不能删只能作废"是同一条道理，只是这次守的是审批痕迹。 */
CREATE OR REPLACE FUNCTION app.timesheet_immutable() RETURNS trigger
  LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '工时不能删除，只能作废（写明时间、人与原因）'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION '已作废的工时不可再修改' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.approved_at IS NOT NULL AND NEW.approved_at IS NULL THEN
    RAISE EXCEPTION '不能撤回审批 —— 审错了请作废这一笔并重报'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.study_site_id, NEW.account_id, NEW.work_date, NEW.work_type, NEW.billable,
      NEW.hours, NEW.rate_card_id, NEW.day_cost_cents, NEW.travel_cents, NEW.cost_cents)
     IS DISTINCT FROM
     (OLD.study_site_id, OLD.account_id, OLD.work_date, OLD.work_type, OLD.billable,
      OLD.hours, OLD.rate_card_id, OLD.day_cost_cents, OLD.travel_cents, OLD.cost_cents) THEN
    RAISE EXCEPTION '工时的归属、工时数与成本不可修改；改数字请作废后重报'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

-- Down Migration
CREATE OR REPLACE FUNCTION app.timesheet_immutable() RETURNS trigger
  LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '工时不能删除，只能作废（写明时间、人与原因）'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION '已作废的工时不可再修改' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.study_site_id, NEW.account_id, NEW.work_date, NEW.work_type, NEW.billable,
      NEW.hours, NEW.rate_card_id, NEW.day_cost_cents, NEW.travel_cents, NEW.cost_cents)
     IS DISTINCT FROM
     (OLD.study_site_id, OLD.account_id, OLD.work_date, OLD.work_type, OLD.billable,
      OLD.hours, OLD.rate_card_id, OLD.day_cost_cents, OLD.travel_cents, OLD.cost_cents) THEN
    RAISE EXCEPTION '工时的归属、工时数与成本不可修改；改数字请作废后重报'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
DROP INDEX IF EXISTS timesheet_unapproved_idx;
ALTER TABLE timesheet_entry DROP CONSTRAINT IF EXISTS timesheet_no_self_approve;
ALTER TABLE timesheet_entry DROP CONSTRAINT IF EXISTS timesheet_approved_pair;
ALTER TABLE timesheet_entry DROP COLUMN IF EXISTS approved_by;
ALTER TABLE timesheet_entry DROP COLUMN IF EXISTS approved_at;
