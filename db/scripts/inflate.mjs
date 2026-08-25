/* 性能夹具：把库灌到**看得出问题的量级**。
 *
 *  为什么需要它：15 个中心、598 个受试者的规模上，PostgreSQL 的规划器
 *  对几乎所有查询都会选顺序扫描 —— 因为那确实更快。于是
 *  「索引建对了没有」这个问题在开发库上**问不出来**：
 *  加了索引没人用，少了索引也看不出，EXPLAIN 两种情况长得一样。
 *
 *  所以先造量，再量。集合式插入（generate_series），不逐行 INSERT。
 *  只往测试库灌，且所有数据都带 PERF- 前缀，便于识别与清除。
 *
 *  用法：DATABASE_URL=... node db/scripts/inflate.mjs [倍数]
 */
import pg from "pg";
import { loadEnv } from "./env.mjs";
loadEnv();

const SCALE = Number(process.argv[2] ?? 1);
const SITES    = 300 * SCALE;
const SUBJ_PER = 100;            // 每个中心的受试者
const VIS_PER  = 6;              // 每个受试者的访视

const url = process.env.SEED_DATABASE_URL || process.env.DATABASE_URL;
if (!url) { console.error("缺少 DATABASE_URL"); process.exit(1); }
const c = new pg.Client({ connectionString: url });
await c.connect();

const t0 = Date.now();
await c.query("BEGIN");

/* 已有的一个项目下面挂新中心 —— 不新建项目，免得动到既有断言 */
const { rows: [study] } = await c.query("SELECT id FROM study LIMIT 1");
if (!study) { console.error("库里没有项目，先跑 seed"); process.exit(1); }
/* 筛败原因是受控词表（FK 到 screen_fail_reason），不能随手编一个字符串 */
const { rows: [sf] } = await c.query("SELECT code FROM screen_fail_reason LIMIT 1");
const { rows: [wd] } = await c.query("SELECT code FROM withdraw_reason LIMIT 1");
if (!sf || !wd) { console.error("受控词表是空的，先跑迁移"); process.exit(1); }

await c.query(`
  INSERT INTO study_site (study_id, code, hospital, dept, city, pi_name,
                          state, contracted, unit_price_cents, startup_fee_cents)
  SELECT $1,
         'PERF-' || lpad(g::text, 5, '0'),
         'PERF 医院 ' || (g % 400),
         '临床试验科', '城市' || (g % 30),
         'PERF 研究者 ' || g,
         'enrolling', 20 + (g % 30),
         500000 + (g % 100) * 1000,
         2000000
    FROM generate_series(1, $2) g`, [study.id, SITES]);

/* 受试者的状态机由 8 条 CHECK 约束把着：入组必须有随机号和入组日、
   筛败必须有筛败原因、退出必须有退出原因、非预筛必须有 ICF 日期……
   夹具也得**老老实实满足它们** —— 绕过约束造出来的数据，
   量出来的性能是另一个系统的性能。（第一版就在这里被拦下了。） */
await c.query(`
  WITH st AS (
    SELECT s.id AS site_id, s.code, g,
           (ARRAY['screening','enrolled','completed','screen_failed','withdrawn'])[1 + (g % 5)] AS state
      FROM study_site s, generate_series(1, $1) g
     WHERE s.code LIKE 'PERF-%')
  INSERT INTO subject (study_site_id, screening_no, state, randomization_no,
                       icf_signed_on, enrolled_on, screen_fail_reason, withdraw_reason)
  SELECT site_id,
         code || '-S' || lpad(g::text, 4, '0'),
         state,
         CASE WHEN state IN ('enrolled','completed','withdrawn')
              THEN 'R' || lpad(g::text, 5, '0') END,
         current_date - ((g % 300) || ' days')::interval,
         CASE WHEN state IN ('enrolled','completed','withdrawn')
              THEN current_date - ((g % 250) || ' days')::interval END,
         CASE WHEN state = 'screen_failed' THEN $2 END,
         CASE WHEN state = 'withdrawn' THEN $3 END
    FROM st`, [SUBJ_PER, sf.code, wd.code]);

/* 访视这边还有 7 条 CHECK：状态取值受限，done_pending_pi / locked 必须有
   实际完成日，locked 必须有 PI 确认人与确认时间，edc=entered 必须有录入日。
   —— 夹具第四次被约束拦下。这本身是个好消息：
   这套 schema 的不变量强到**连造假数据都绕不过去**。 */
await c.query(`
  INSERT INTO subject_visit (subject_id, study_site_id, seq, visit_code, visit_label,
                             target_date, window_days, status, actual_date,
                             edc_status, edc_entered_on)
  SELECT sub.id, sub.study_site_id, g,
         'V' || g, '第 ' || g || ' 次访视',
         current_date - (((g * 17) % 200) || ' days')::interval,
         3,
         (ARRAY['planned','done_pending_pi','missed'])[1 + (g % 3)],
         CASE WHEN g % 3 = 1
              THEN current_date - (((g * 17) % 200) || ' days')::interval END,
         CASE WHEN g % 3 = 1 THEN 'entered' ELSE 'pending' END,
         CASE WHEN g % 3 = 1
              THEN current_date - (((g * 17) % 200) || ' days')::interval END
    FROM subject sub, generate_series(1, $1) g
   WHERE sub.screening_no LIKE 'PERF-%'`, [VIS_PER]);

await c.query("COMMIT");
await c.query("ANALYZE");        // 不 ANALYZE 的话规划器还按旧统计做决定

const { rows } = await c.query(`
  SELECT 'study_site' t, count(*)::int n FROM study_site
  UNION ALL SELECT 'subject', count(*) FROM subject
  UNION ALL SELECT 'subject_visit', count(*) FROM subject_visit ORDER BY 1`);
console.log(rows.map(r => `${r.t}=${r.n}`).join("  "), `｜${((Date.now()-t0)/1000).toFixed(1)}s`);
await c.end();
