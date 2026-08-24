-- Up Migration
-- ════════════════════════════════════════════════════════════════════
-- 金额统一为「整数分」。
--
-- Phase 1 用 numeric(14,2) 存元；Phase 2 定契约时发现三处口径不一致：
--   · 架构文档 §2.2 早已写明 `unitPriceCent: bigint`（分）
--   · 契约层要求整数分 —— 计算引擎前后端共用，整数运算不需要十进制库
--   · pg 驱动把 numeric 返回为字符串，前端一旦 Number() 就回到浮点
--
-- 三者取一，必须一致（原则 9）。选分：
--   现实上限 5 亿元 = 5e10 分，远在 Number.MAX_SAFE_INTEGER (9e15) 之内，
--   而元 + 小数在 JS 里做乘除迟早出现 0.1+0.2 那类误差。
--
-- 注：bigint 在 pg 驱动里默认也返回字符串（int8 可能溢出 JS）。
--     应用层需 pg.types.setTypeParser(20, Number) —— 见 apps/api 的启动配置（Phase 3）。
--
-- 这是一次**前向迁移**，不是就地修改 0004：Phase 1 已交付并推送，
-- 改历史迁移会让已经跑过它的环境与迁移记录对不上。
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE study
  ADD COLUMN contract_amount_cents bigint;
UPDATE study SET contract_amount_cents = round(contract_amount * 100)::bigint;
ALTER TABLE study
  ALTER COLUMN contract_amount_cents SET NOT NULL,
  ADD CONSTRAINT study_contract_amount_nonneg CHECK (contract_amount_cents >= 0),
  DROP COLUMN contract_amount;

ALTER TABLE study_site
  ADD COLUMN unit_price_cents  bigint,
  ADD COLUMN startup_fee_cents bigint;
UPDATE study_site SET
  unit_price_cents  = round(unit_price  * 100)::bigint,
  startup_fee_cents = round(startup_fee * 100)::bigint;
ALTER TABLE study_site
  ALTER COLUMN unit_price_cents  SET NOT NULL,
  ALTER COLUMN startup_fee_cents SET NOT NULL,
  ALTER COLUMN startup_fee_cents SET DEFAULT 0,
  ADD CONSTRAINT site_unit_price_nonneg  CHECK (unit_price_cents  >= 0),
  ADD CONSTRAINT site_startup_fee_nonneg CHECK (startup_fee_cents >= 0),
  DROP COLUMN unit_price,
  DROP COLUMN startup_fee;

COMMENT ON COLUMN study.contract_amount_cents  IS '合同额，单位：分。展示层负责换算万元。';
COMMENT ON COLUMN study_site.unit_price_cents  IS '单例单价，单位：分。';
COMMENT ON COLUMN study_site.startup_fee_cents IS '启动费，单位：分。';

-- Down Migration
ALTER TABLE study_site
  ADD COLUMN unit_price  numeric(14,2),
  ADD COLUMN startup_fee numeric(14,2);
UPDATE study_site SET
  unit_price  = unit_price_cents  / 100.0,
  startup_fee = startup_fee_cents / 100.0;
ALTER TABLE study_site
  ALTER COLUMN unit_price SET NOT NULL,
  ALTER COLUMN startup_fee SET NOT NULL,
  ALTER COLUMN startup_fee SET DEFAULT 0,
  ADD CONSTRAINT study_site_unit_price_check  CHECK (unit_price  >= 0),
  ADD CONSTRAINT study_site_startup_fee_check CHECK (startup_fee >= 0),
  DROP COLUMN unit_price_cents,
  DROP COLUMN startup_fee_cents;

ALTER TABLE study ADD COLUMN contract_amount numeric(14,2);
UPDATE study SET contract_amount = contract_amount_cents / 100.0;
ALTER TABLE study
  ALTER COLUMN contract_amount SET NOT NULL,
  ADD CONSTRAINT study_contract_amount_check CHECK (contract_amount >= 0),
  DROP COLUMN contract_amount_cents;
