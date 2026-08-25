/* 执行计划守卫 —— 在**真数据量**下断言规划器走的是索引，而不是全表扫。
 *
 *  ── 为什么需要单独一个 job ────────────────────────────────────────
 *  Phase 8b 量到访视列表 48 秒 → 16 毫秒，靠的是一条表达式索引。
 *  但既有测试只能断言「索引还在」—— 挡不住真正会发生的那种退化：
 *  索引还在，查询改了一个字，计划悄悄退回全表扫。
 *
 *  而这件事在开发库上**测不出来**：15 个中心、600 条访视，
 *  规划器对两种计划都选得飞快，EXPLAIN 长得一样。
 *  所以这个脚本自己建库、自己灌量、自己量 —— 慢，但它是唯一说得清的方式。
 *
 *  ── 判据是「用了哪条索引」，不是「跑了多少毫秒」 ──────────────────
 *  耗时依赖机器，放进 CI 必然变成 flaky。
 *  计划形状不依赖机器：Seq Scan 就是 Seq Scan。
 *
 *  用法：node db/scripts/check-plans.mjs
 */
import { execSync } from "node:child_process";
import pg from "pg";
import { loadEnv, ROOT } from "./env.mjs";
loadEnv();

const BASE = process.env.TEST_DATABASE_URL;
const APP  = process.env.APP_TEST_DATABASE_URL;
if (!BASE || !APP) {
  console.error("缺少 TEST_DATABASE_URL / APP_TEST_DATABASE_URL");
  process.exit(1);
}
const DB = "sitedesk_plans";
const withDb = (url, db) => url.replace(/\/[^/?]+(\?|$)/, `/${db}$1`);

/* ── 每个角色一条待测查询 ──────────────────────────────────────────
   加一条新的路径 = 往这个数组里加一项。
   `mustUse` 写索引名：既断言"没退回全表扫"，也钉死"走的是哪一条" ——
   后者更重要，因为换了一条索引往往意味着排序键悄悄变了。 */
const CASES = [
  {
    name: "访视列表：默认（不筛状态），经营层看全部",
    sql: `SELECT v.id FROM subject_visit v
           ORDER BY upper(v.visit_window), v.id DESC LIMIT 51`,
    mustUse: "visit_feed_idx",
    why: "没有它就是全表扫 18 万行，而 RLS 行谓词是每行一次函数调用 —— 实测 48 秒"
  },
  {
    name: "访视列表：限定到一个中心",
    sql: (ctx) => `SELECT v.id FROM subject_visit v
                    WHERE v.study_site_id = '${ctx.site}'
                    ORDER BY upper(v.visit_window), v.id DESC LIMIT 51`,
    mustNotSeqScan: "subject_visit",
    why: "限定中心之后仍然不该扫全表"
  },
  {
    name: "受试者列表：按中心 + 游标",
    sql: (ctx) => `SELECT s.id FROM subject s
                    WHERE s.study_site_id = '${ctx.site}'
                    ORDER BY s.screening_no LIMIT 51`,
    mustNotSeqScan: "subject",
    why: "3 万受试者时按中心筛必须走索引"
  },
  {
    name: "中心列表：按 code 游标",
    sql: `SELECT s.id FROM study_site s ORDER BY s.code LIMIT 51`,
    mustNotSeqScan: "study_site",
    why: "分页游标的排序键必须索引可用"
  }
];

/* execSync 失败时默认把 stdout/stderr 以 Buffer 形式塞进异常，
   打印出来是一屏字节数组 —— 真正的原因（"连接被拒绝"）就埋在里面。
   包一层，让失败自己说得清。 */
function run(cmd, env, what) {
  try {
    execSync(cmd, { cwd: ROOT, env: { ...process.env, ...env }, stdio: "pipe" });
  } catch (e) {
    const err = (e.stderr?.toString() || e.stdout?.toString() || String(e)).trim();
    console.error(`✗ ${what} 失败：\n  ${err.split("\n").join("\n  ")}`);
    process.exit(1);
  }
}
const sh = (cmd, env) => run(cmd, env, cmd.split(" ").slice(0, 3).join(" "));
/* SQL 必须压成一行再交给 psql -c：多行字符串经 JSON.stringify 之后，
   换行成了字面的 \n，psql 在那儿报语法错，而错误指向的位置毫无意义。
   （apps/api/test/harness.ts 里已经栽过一次并写下了这条，我又踩了一遍 ——
   所以这次修在**辅助函数**里，让调用方没有机会再踩。） */
const psql = (url, sql) => {
  const oneLine = sql.replace(/\s+/g, " ").trim();
  run(`psql "${url}" -v ON_ERROR_STOP=1 -c ${JSON.stringify(oneLine)}`, {},
      `psql: ${oneLine.slice(0, 60)}`);
};

console.log("① 建一个干净的性能库…");
const admin = withDb(BASE, "postgres");
psql(admin, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
              WHERE datname = '${DB}' AND pid <> pg_backend_pid()`);
psql(admin, `DROP DATABASE IF EXISTS ${DB}`);
psql(admin, `CREATE DATABASE ${DB}`);
psql(withDb(BASE, DB), "CREATE EXTENSION IF NOT EXISTS btree_gist");

const url = withDb(BASE, DB);
const M = "npx node-pg-migrate --migrations-dir db/migrations --migrations-table schema_migration";
sh(`${M} up`, { DATABASE_URL: url });
sh("node db/scripts/seed.mjs", { DATABASE_URL: url });

console.log("② 灌到看得出问题的量级…");
sh("node db/scripts/inflate.mjs", { DATABASE_URL: url });

console.log("③ 以应用角色（RLS 生效）量执行计划…\n");
const c = new pg.Client({ connectionString: withDb(APP, DB) });
await c.connect();

const owner = new pg.Client({ connectionString: url });
await owner.connect();
const { rows: [boss] } =
  await owner.query("SELECT id FROM account WHERE login = 'lingyuan'");
const { rows: [site] } =
  await owner.query("SELECT id FROM study_site WHERE code LIKE 'PERF-%' LIMIT 1");
await owner.end();
const ctx = { site: site.id };

/* RLS 必须真的生效 —— 用 owner 量出来的计划是另一回事：
   owner 绕过 RLS，行谓词那一层的开销根本不会出现。 */
await c.query("BEGIN");
await c.query("SELECT set_config('app.account_id', $1, true)", [boss.id]);

let bad = 0;
for (const t of CASES) {
  const sql = typeof t.sql === "function" ? t.sql(ctx) : t.sql;
  const { rows } = await c.query(`EXPLAIN (ANALYZE, TIMING OFF, SUMMARY OFF) ${sql}`);
  const plan = rows.map(r => r["QUERY PLAN"]).join("\n");

  const problems = [];
  if (t.mustUse && !plan.includes(t.mustUse))
    problems.push(`没有用上索引 ${t.mustUse}`);
  if (t.mustNotSeqScan && new RegExp(`Seq Scan on ${t.mustNotSeqScan}\\b`).test(plan))
    problems.push(`对 ${t.mustNotSeqScan} 做了全表扫`);

  if (problems.length) {
    bad++;
    console.log(`✗ ${t.name}`);
    for (const p of problems) console.log(`    ${p}`);
    console.log(`    为什么要紧：${t.why}`);
    console.log(plan.split("\n").map(l => "    │ " + l).join("\n"));
  } else {
    const node = plan.split("\n").find(l => /Index (Only )?Scan|Bitmap/.test(l))?.trim();
    console.log(`✓ ${t.name}\n    ${node ?? "(计划中没有扫描节点)"}`);
  }
}
await c.query("ROLLBACK");
await c.end();

console.log();
if (bad) {
  console.error(`✗ ${bad}/${CASES.length} 条查询的执行计划退化了。\n` +
    "  计划退化不会让任何功能测试变红 —— 它只是变慢，而且是在数据长起来之后。\n" +
    "  改了查询就来这里核一遍，别等线上。");
  process.exit(1);
}
console.log(`✓ ${CASES.length} 条查询的执行计划都走索引。`);
