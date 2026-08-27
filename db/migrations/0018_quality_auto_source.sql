-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   自动生成的质量事件，来源不止「一次访视」（欠账 D7 的一半）。

   `quality_auto_needs_source`（迁移 0009）写的是：

     NOT auto_generated OR (raised_by = 'system' AND visit_id IS NOT NULL)

   意图完全正确 —— **系统自动生成的事件必须指明来源对象，
   否则「它为什么存在」没有答案**。但那时唯一的自动事件是「访视超窗
   生成方案偏离」，来源天然是一次访视，于是"来源"被写成了 `visit_id`。

   I6 的 `sae_late`（SAE 超过 24 小时上报）也是自动生成的，
   而它的来源是**另一条质量事件**（那条 SAE），不是一次访视。

   两条路可走，只有一条是对的：
   ① 放宽约束，允许 auto_generated 没有来源 —— 那等于把 0009 的判断作废，
      而那个判断是对的：没有来源的自动记录，核查时答不出「凭什么」；
   ② 把"来源"这个概念补全。

   这里走 ②：加一列 `source_event_id`，约束改成「两种来源至少有一个」。
   ══════════════════════════════════════════════════════════════════════ */

ALTER TABLE quality_event
  ADD COLUMN source_event_id uuid REFERENCES quality_event(id);

COMMENT ON COLUMN quality_event.source_event_id IS
  '本条自动事件是因哪条质量事件而生成的。sae_late 指向它所说的那条 SAE。';

/* 索引：从一条 SAE 找它的超时记录，是台账上的常规动作 */
CREATE INDEX quality_event_source_idx ON quality_event (source_event_id)
  WHERE source_event_id IS NOT NULL;

ALTER TABLE quality_event DROP CONSTRAINT IF EXISTS quality_auto_needs_source;
ALTER TABLE quality_event ADD CONSTRAINT quality_auto_needs_source CHECK
  (NOT auto_generated OR (raised_by = 'system'
                          AND (visit_id IS NOT NULL OR source_event_id IS NOT NULL)));

/* 自己指向自己就不是"来源"了 —— 这种行只会在写错时出现，
   而它会让"找出这条记录的由来"变成一个死循环。 */
ALTER TABLE quality_event ADD CONSTRAINT quality_source_not_self
  CHECK (source_event_id IS NULL OR source_event_id <> id);

/* 一条 SAE 只该有一条超时记录：重复登记上报会生成第二条，
   而那时台账上会出现两条说同一件事的记录，核查看到的是"这里管理混乱"。
   （markSaeReported 本身也拒绝覆盖已有的上报时刻，这是第二道。） */
CREATE UNIQUE INDEX quality_event_one_late_per_sae
  ON quality_event (source_event_id) WHERE kind = 'sae_late';

-- Down Migration
DROP INDEX IF EXISTS quality_event_one_late_per_sae;
ALTER TABLE quality_event DROP CONSTRAINT IF EXISTS quality_source_not_self;
/* 约束收回"来源只能是一次访视"之前，先清掉靠 source_event_id 立住的那些行 ——
   sae_late 是自动生成的，但它没有 visit_id。不清的话 down 会失败，
   而报错只说约束不满足，指不到这里。 */
DELETE FROM quality_event WHERE kind = 'sae_late' AND visit_id IS NULL;
ALTER TABLE quality_event DROP CONSTRAINT IF EXISTS quality_auto_needs_source;
ALTER TABLE quality_event ADD CONSTRAINT quality_auto_needs_source CHECK
  (NOT auto_generated OR (raised_by = 'system' AND visit_id IS NOT NULL));
DROP INDEX IF EXISTS quality_event_source_idx;
ALTER TABLE quality_event DROP COLUMN IF EXISTS source_event_id;
