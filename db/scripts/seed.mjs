/* 灌演示数据。以 owner 身份执行（绕过 RLS），仅用于本地与测试库。 */
import fs from "node:fs";
import pg from "pg";
import path from "node:path";
import { loadEnv, ROOT as REPO } from "./env.mjs";
loadEnv();
const ROOT = path.join(REPO, "db");
const url = process.env.SEED_DATABASE_URL || process.env.DATABASE_URL;
if (!url) { console.error("缺少 DATABASE_URL"); process.exit(1); }
const c = new pg.Client({ connectionString: url });
await c.connect();
for (const f of fs.readdirSync(path.join(ROOT, "seeds")).filter(x => x.endsWith(".sql")).sort()) {
  await c.query(fs.readFileSync(path.join(ROOT, "seeds", f), "utf8"));
  console.log(`✓ ${f}`);
}
const { rows } = await c.query(`
  select 'role' t, count(*)::int n from role
  union all select 'account', count(*) from account
  union all select 'team', count(*) from team
  union all select 'study', count(*) from study
  union all select 'study_site', count(*) from study_site
  union all select 'site_assignment', count(*) from site_assignment
  order by 1`);
console.log(rows.map(r => `${r.t}=${r.n}`).join("  "));
await c.end();
