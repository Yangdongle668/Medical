-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   数据质疑（EDC Query）的闭环两端。

   ── 为什么不新建一张表 ────────────────────────────────────────────
   原型的 QUERIES 已经是 `quality_event` 里 `kind = 'query'` 的行。
   再建一张 data_query，同一条质疑就有了两个台账 ——
   「本中心还有几条未关闭的质量事件」这个数从此有两个答案，
   而核查时被问到的恰恰是这个数。

   所以这一版补的是**列**，不是表。

   ── 缺的是「谁负责」，不是「记在哪」 ────────────────────────────────
   原型自己写着：QUERIES 里 by:"数据管理" 出现了 5 次，
   但系统里没有数据管理这个角色 —— 质疑凭空产生、凭空关闭。

   一条质疑要能落地，必须答得出三个「谁」：
     · 谁提的  —— raised_by 补上 'dm'（此前只有 system/cra/qa/institution）
     · 谁负责答 —— owner_account_id，**提出时固化**，不跟着受试者的 CRC 变
     · 谁判定能关 —— closed_by，且只有 DM（closeQ 动作权限）

   ── 责任人为什么要固化，而不是从受试者的 CRC 现算 ──────────────────
   交接一次，历史上所有质疑的"责任 CRC"会集体改写 ——
   于是「这条挂了 21 天，是谁的 21 天」再也说不清。
   同一条道理已经在开票到期日上写过一次：**事实在发生那一刻定型。**

   ── 三个状态用的是既有的那三个，不是新开一套 ────────────────────────
     open           待中心回复
     pending_review 已回复待关闭   ← 回复了不等于问题解决了
     closed         已关闭
   「回复」与「关闭」是两个人的两个动作，中间那一格就是这件事的全部意义。
   ══════════════════════════════════════════════════════════════════════ */

/* ── 提出方补上 dm ─────────────────────────────────────────────── */
ALTER TABLE quality_event DROP CONSTRAINT quality_event_raised_by_check;
ALTER TABLE quality_event ADD CONSTRAINT quality_event_raised_by_check
  CHECK (raised_by IN ('system','cra','qa','institution','dm'));

ALTER TABLE quality_event
  ADD COLUMN form             text,
  ADD COLUMN field_name       text,
  ADD COLUMN owner_account_id uuid REFERENCES account(id),
  ADD COLUMN answered_on      date,
  ADD COLUMN answer           text,
  ADD COLUMN returned_reason  text,
  ADD COLUMN last_chased_on   date,
  ADD COLUMN chase_count      integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN quality_event.owner_account_id IS
  '责任 CRC。**提出时固化** —— 从受试者现算的话，一次交接会改写
   历史上所有质疑的责任人，"这条挂了 21 天是谁的 21 天"就没有答案了。';
COMMENT ON COLUMN quality_event.returned_reason IS
  '上一次被退回的理由。退回而不说为什么，等于把"凭空产生"的毛病
   搬到了闭环的另一端 —— CRC 只知道弹回来了，不知道要补什么。';
COMMENT ON COLUMN quality_event.chase_count IS
  '电话催办次数。挂过 7 天之后靠系统提醒已经不够了 —— 但"我们催过了"
   如果没有记录，它在核查和跟申办方对账时就等于没发生过。';
COMMENT ON COLUMN quality_event.answer IS
  '中心的最后一次回复。被退回后重答会覆盖它 ——
   历次回复留在审计轨迹里（audit_log 的 before/after），这里只存当前那一版。';

/* 回填：标题此前把「表单 · 字段」打包成一个字符串。
   拆出来是因为 DM 工作台要按表单聚类 —— 质疑集中在一个表单上是方案难填，
   散在各处才是录入质量差，而这两件事要做的事完全相反。
   拆不出来的（历史上手工建的、标题里没有分隔符）落到「未指明字段」：
   它说的是实话，比编一个字段名好。 */
UPDATE quality_event
   SET form       = COALESCE(NULLIF(split_part(title, ' · ', 1), ''), 'eCRF'),
       field_name = COALESCE(NULLIF(split_part(title, ' · ', 2), ''), '未指明字段')
 WHERE kind = 'query';

ALTER TABLE quality_event
  /* 这几列只对质疑有意义。方案偏离上挂一个"责任 CRC"，
     读的人会以为偏离也走同一条回复流程，而它不走。 */
  ADD CONSTRAINT quality_query_only CHECK (
    kind = 'query' OR (form IS NULL AND field_name IS NULL
      AND owner_account_id IS NULL AND answered_on IS NULL
      AND answer IS NULL AND returned_reason IS NULL
      AND last_chased_on IS NULL AND chase_count = 0)),
  ADD CONSTRAINT quality_query_needs_field CHECK (
    kind <> 'query' OR (form IS NOT NULL AND field_name IS NOT NULL)),
  /* 回复的日期与内容同生共死 —— 只有一个的话，"什么时候答的"或者
     "答了什么"必有一个没有答案。 */
  ADD CONSTRAINT quality_answer_shape CHECK ((answered_on IS NULL) = (answer IS NULL)),
  /* 待关闭必须有回复内容。没有回复而处在"已回复待关闭"，
     DM 判定的是一片空白。 */
  ADD CONSTRAINT quality_query_review_needs_answer CHECK (
    kind <> 'query' OR state <> 'pending_review' OR answer IS NOT NULL),
  /* 催办次数与最后一次催办的日期同生共死 —— 只有次数没有日期，
     "上次是什么时候催的"就没有答案，而那正是决定要不要再催的那个数。 */
  ADD CONSTRAINT quality_chase_shape CHECK (
    (chase_count = 0) = (last_chased_on IS NULL));

/* ── 两条质量闭环不能混 ────────────────────────────────────────
   原型写得很清楚：**机构办是外部的质量反馈闭环，DM 是内部的数据质量闭环。**

   在此之前 quality_event 的行策略只按中心可见性放行，于是本院的
   数据质疑对机构办也是可见的 —— 后果不是"多看到几行"，而是
   **机构质控页上「本院未关闭质量事件」这个数把 EDC 质疑也算了进去**：
   一家医院会因为几条例行的数据核实，看到一个像是要挨检查的数字。

   所以这里把 kind = 'query' 对外部方整体关掉。写在行策略上而不是
   两个 service 里，是因为同一批行不能"从这个端点看不见、
   从那个端点看得见" —— 那种不一致修一次只能修一半。 */
DROP POLICY quality_event_scope ON quality_event;
CREATE POLICY quality_event_scope ON quality_event FOR ALL
  USING (tenant_id = app.current_tenant_id()
         AND app.site_visible_by_id(quality_event.study_site_id)
         AND (kind <> 'query' OR NOT app.current_is_external()))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND app.site_visible_by_id(quality_event.study_site_id)
              AND (kind <> 'query' OR NOT app.current_is_external()));

/* 责任人的工作队列：CRC 打开这一页只关心"待我回复的"。
   索引带 state 是因为已关闭的那些永远不进这个队列。 */
CREATE INDEX quality_event_owner_open_idx
  ON quality_event (owner_account_id, state)
  WHERE kind = 'query' AND state <> 'closed';

-- Down Migration
DROP POLICY quality_event_scope ON quality_event;
CREATE POLICY quality_event_scope ON quality_event FOR ALL
  USING (tenant_id = app.current_tenant_id()
         AND app.site_visible_by_id(quality_event.study_site_id))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND app.site_visible_by_id(quality_event.study_site_id));
DROP INDEX IF EXISTS quality_event_owner_open_idx;
ALTER TABLE quality_event
  DROP CONSTRAINT IF EXISTS quality_query_only,
  DROP CONSTRAINT IF EXISTS quality_query_needs_field,
  DROP CONSTRAINT IF EXISTS quality_answer_shape,
  DROP CONSTRAINT IF EXISTS quality_query_review_needs_answer,
  DROP CONSTRAINT IF EXISTS quality_chase_shape;
ALTER TABLE quality_event
  DROP COLUMN IF EXISTS form,
  DROP COLUMN IF EXISTS field_name,
  DROP COLUMN IF EXISTS owner_account_id,
  DROP COLUMN IF EXISTS answered_on,
  DROP COLUMN IF EXISTS answer,
  DROP COLUMN IF EXISTS returned_reason,
  DROP COLUMN IF EXISTS last_chased_on,
  DROP COLUMN IF EXISTS chase_count;
/* dm 提出的质疑在回退后没有合法的 raised_by —— 归给 cra，
   因为它们确实是"我方内部提出"的那一类。丢掉的是"具体是谁的部门"。 */
UPDATE quality_event SET raised_by = 'cra' WHERE raised_by = 'dm';
ALTER TABLE quality_event DROP CONSTRAINT quality_event_raised_by_check;
ALTER TABLE quality_event ADD CONSTRAINT quality_event_raised_by_check
  CHECK (raised_by IN ('system','cra','qa','institution'));
