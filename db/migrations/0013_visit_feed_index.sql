-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   访视列表：48 秒 → 15 毫秒。

   ── 怎么发现的 ────────────────────────────────────────────────────
   开发库上 15 个中心、600 条访视，这个查询是毫秒级的，看不出任何问题。
   把库灌到 315 个中心 / 30,598 个受试者 / 180,011 条访视之后再量
   （db/scripts/inflate.mjs），最普通的那个请求 ——
   经营层打开访视列表、不带任何筛选 —— **48 秒**。

     Seq Scan on subject_visit  (actual rows=180011)
     Sort Method: top-N heapsort
     Execution Time: 48191.243 ms

   ── 为什么这么慢 ──────────────────────────────────────────────────
   两件事叠在一起：

   ① 列表按 `upper(v.visit_window)` 排序 —— 那是个**表达式**。
      表上已有的两条 (study_site_id, target_date) 索引都排不上用场：
      它们既是按 target_date 排的，又都带 `WHERE status = …` 的部分条件，
      而默认列表不筛状态。于是只能全表扫 + 排序。

   ② **RLS 的行谓词是每行一次函数调用。** 全表扫过 180,011 行，
      就是 180,011 次 app.site_visible()，然后才轮到 LIMIT 51。
      同一个查询限定到一个中心时只扫 600 行，185 毫秒 ——
      两者相差 300 倍的行数，也就相差 260 倍的时间。**开销是按行走的。**

   这就是为什么"加了 RLS 之后要格外小心全表扫"：
   在别的系统里全表扫只是慢，在这里它还乘上一个函数调用。

   ── 修法 ──────────────────────────────────────────────────────────
   按排序键本身建一条表达式索引。规划器于是可以顺着索引取前 51 行就停，
   RLS 也就只判 51 次。

     Index Scan using visit_feed_idx  (actual rows=51)
     Execution Time: 14.968 ms

   不做成部分索引：默认列表恰恰是不带状态筛选的那一个，
   而它正是最常被打开的。
   ══════════════════════════════════════════════════════════════════════ */

CREATE INDEX visit_feed_idx ON subject_visit (upper(visit_window), id DESC);

COMMENT ON INDEX visit_feed_idx IS
  '访视列表的排序键（upper(visit_window), id DESC）。没有它，默认列表全表扫，'
  '而 RLS 行谓词是每行一次函数调用 —— 18 万行时实测 48 秒。';

-- Down Migration
DROP INDEX IF EXISTS visit_feed_idx;
