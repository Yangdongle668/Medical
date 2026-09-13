/* ══════════════════════════════════════════════════════════════════════
   本地重置：把库清空，再 up 到最新，然后灌种子。生产不用（生产只进不退）。

   ── 为什么不再用 `down 99` 把库拆回去 ──────────────────────────────
   原来这里写的是 `down 99 || true`，然后 `up`，然后灌种子。
   在一个**跑过的**库上它是这样失败的：

     down 到迁移 0026（它的 Down 段里有 `DELETE FROM account WHERE login='admin'`）
       → 那个 admin 账号被 audit_entry.actor_account_id 引着
       → 23503 外键冲突，回滚停在半截
       → `|| true` 把这句报错吞了
       → `up` 接着跑，打出一句干干净净的 `Migrations complete!`
       → 灌种子时撞在 team_pkey 上：**duplicate key value**

   最后屏幕上留下的是一句关于 `team` 主键的报错，而真正出事的地方
   在它上面四十步、另一张表、另一个原因。这正是最难查的那种失败。

   而且那个外键冲突**不是 bug**：审计留痕本来就该拦住"把做过事的账号删掉"。
   0026 的 Down 段假定库里只有它自己铺的那点东西 —— 那个假定在一个
   被人用过的开发库上不成立，也不该要求它成立。

   ── 所以本地重置就该是本地重置 ────────────────────────────────────
   `down 99` 是**迁移可逆性**的断言，它有自己的地方：db/test/migration.test.js
   在测试库上跑它，从一个刚灌完种子、没人用过的库出发 —— 那里它成立。

   这里要的是另一件事：**把这个库变成空的**。DROP SCHEMA 一句就够，
   不关心它之前是什么状态、被谁用过、留下了多少条审计。

   `public` 之外还要带上 `app`（迁移 0002 起把函数都放在那儿）。
   两个都用 CASCADE，且删完立刻重建 `public` —— 少了这一步，
   下一句 CREATE TABLE 会报 "no schema has been selected"，
   而那句话读起来完全不像"schema 被删了"。

   角色（sitedesk / sitedesk_app）是集群级对象，不在任何 schema 里，
   因此 DROP SCHEMA 碰不到它们 —— 那是 db/scripts/bootstrap.sql 的事，
   一次性由 DBA 执行，重置不该动。

   **扩展不一样：它装在 schema 里，跟着 CASCADE 一起没了。**
   `btree_gist` 装在 public（bootstrap.sql 那一句），费率卡与派工的
   生效区间 EXCLUDE 约束靠它。不补回来，up 会停在迁移中途，报的是
   「data type uuid has no default operator class for access method "gist"」
   —— 一句完全不提"扩展被删了"的话。所以重建 public 之后立刻装回去。
   ══════════════════════════════════════════════════════════════════════ */
import { execSync } from "node:child_process";
import path from "node:path";
import pg from "pg";
import { loadEnv, ROOT } from "./env.mjs";
loadEnv();

const url = process.env.DATABASE_URL;
if (!url) { console.error("缺少 DATABASE_URL"); process.exit(1); }

/* 说清楚正在清空的是**哪一个**库。重置是不可逆的，而 .env 里指到哪
   一眼看不出来 —— 密码不打出来，其余照打。 */
console.log(`重置 ${url.replace(/:\/\/([^:]+):[^@]*@/, "://$1:***@")}`);

const c = new pg.Client({ connectionString: url });
await c.connect();
await c.query("DROP SCHEMA IF EXISTS app CASCADE");
await c.query("DROP SCHEMA IF EXISTS public CASCADE");
await c.query("CREATE SCHEMA public");
await c.query("CREATE EXTENSION IF NOT EXISTS btree_gist");
/* schema_migration 是 node-pg-migrate 自己建在 public 里的，刚跟着一起没了 ——
   所以下面那句 up 会从 0001 重新跑一遍，这正是要的。 */
await c.end();

const run = cmd => execSync(cmd, { stdio: "inherit", cwd: ROOT });
run("npx node-pg-migrate --migrations-dir db/migrations " +
    "--migrations-table schema_migration up");
run(`node ${path.join(ROOT, "db/scripts/seed.mjs")}`);
