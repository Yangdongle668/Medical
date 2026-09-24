import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { owner } from "./helpers.js";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* ════════════════════════════════════════════════════════════════════
   0054：一线侧栏重排。它最容易做错的一件事是**替管理员做决定**。

   0052 补模块的写法是把 CRA / CRC 两行整行重发 —— 管理员在
   「组织与权限」里勾掉的模块，跑一次迁移就又回来了；
   管理员给 CRC 额外加的模块，排序被挤得乱七八糟。
   0054 只重排、只补 CRA 的三项。下面把这三句话各钉一遍。
   ════════════════════════════════════════════════════════════════════ */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const M = "npx node-pg-migrate --migrations-dir db/migrations --migrations-table schema_migration";
const run = args => execSync(`${M} ${args}`, {
  cwd: ROOT, stdio: "pipe",
  env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL }
});

/* 退到 0054 之前要退几步 —— 0054 之后每加一条迁移，这个数就多一。
   写死成 1 的话，下一条迁移一来，"退一步"退掉的就是那一条，而这里测的不再是 0054。 */
const STEPS_TO_BEFORE_0054 = fs.readdirSync(path.join(ROOT, "db/migrations"))
  .filter(f => f.endsWith(".sql") && f >= "0054").length;

let o;
beforeAll(async () => { o = owner(); await o.connect(); });
afterAll(async () => { await o.end(); });

/** 默认租户上某个角色的模块，按侧栏顺序。 */
const modules = async code => (await o.query(
  `SELECT m.module_key, m.sort_order FROM role_module m JOIN role r ON r.id = m.role_id
    WHERE r.code = $1 AND r.tenant_id = '00000000-0000-0000-0000-000000000001'
    ORDER BY m.sort_order`, [code])).rows;

const roleId = async code => (await o.query(
  `SELECT id FROM role WHERE code = $1 AND tenant_id = '00000000-0000-0000-0000-000000000001'`,
  [code])).rows[0].id;

describe("0054 一线侧栏", () => {
  it("CRC / CRA 的前六项是每天用的那几项", async () => {
    expect((await modules("crc")).slice(0, 6).map(r => r.module_key))
      .toEqual(["crc", "subj", "sched", "query", "mysite", "capa"]);
    expect((await modules("cra")).slice(0, 6).map(r => r.module_key))
      .toEqual(["cra", "sched", "mon", "mysites", "query", "capa"]);
  });

  it("CRA 补上了日程、中心文件、伦理，原有的一项没少", async () => {
    const keys = (await modules("cra")).map(r => r.module_key);
    for (const k of ["sched", "isf", "ethics", "feas", "screen", "instac", "trail"]) {
      expect(keys).toContain(k);
    }
  });

  it("不替管理员做决定：勾掉的不加回来，自己加的留着且排在后面", async () => {
    const crc = await roleId("crc");
    const cra = await roleId("cra");
    run(`down ${STEPS_TO_BEFORE_0054}`);
    try {
      /* 在 0054 之前，管理员给 CRC 加了「经营驾驶舱」，给 CRA 勾掉了「可行性调查」 */
      await o.query(`INSERT INTO role_module (role_id, module_key, sort_order) VALUES ($1, 'dash', 3)`, [crc]);
      await o.query(`DELETE FROM role_module WHERE role_id = $1 AND module_key = 'feas'`, [cra]);
      run("up");

      const c = await modules("crc");
      const dash = c.find(r => r.module_key === "dash");
      expect(dash, "管理员加的模块被删了").toBeDefined();
      expect(dash.sort_order, "管理员加的模块应排在目录之后").toBe(103);
      expect(c.slice(0, 6).map(r => r.module_key))
        .toEqual(["crc", "subj", "sched", "query", "mysite", "capa"]);

      expect((await modules("cra")).map(r => r.module_key), "勾掉的模块被加回来了")
        .not.toContain("feas");
    } finally {
      /* 收回到干净的 0054 状态 —— 同一个测试库后面还有别的文件在用 */
      await o.query(`DELETE FROM role_module WHERE role_id = $1 AND module_key = 'dash'`, [crc]);
      await o.query(
        `INSERT INTO role_module (role_id, module_key, sort_order) VALUES ($1, 'feas', 13)
         ON CONFLICT (role_id, module_key) DO UPDATE SET sort_order = 13`, [cra]);
      run("up");
    }
  });

  it("新开的租户与现存租户拿到同一份顺序", async () => {
    await o.query("SELECT app.provision_tenant_roles('nav54', '侧栏测试')");
    try {
      const { rows } = await o.query(`
        SELECT r.code, string_agg(m.module_key, ',' ORDER BY m.sort_order) AS keys
          FROM role r JOIN tenant t ON t.id = r.tenant_id JOIN role_module m ON m.role_id = r.id
         WHERE t.code = 'nav54' AND r.code IN ('cra', 'crc') GROUP BY r.code ORDER BY r.code`);
      const cur = async code => (await modules(code)).map(r => r.module_key).join(",");
      expect(rows).toEqual([
        { code: "cra", keys: await cur("cra") },
        { code: "crc", keys: await cur("crc") }
      ]);
    } finally {
      await o.query(`DELETE FROM role_module WHERE role_id IN
        (SELECT r.id FROM role r JOIN tenant t ON t.id = r.tenant_id WHERE t.code = 'nav54')`);
      for (const t of ["role_action", "role_field"]) {
        await o.query(`DELETE FROM ${t} WHERE role_id IN
          (SELECT r.id FROM role r JOIN tenant t ON t.id = r.tenant_id WHERE t.code = 'nav54')`);
      }
      await o.query(`DELETE FROM role WHERE tenant_id IN (SELECT id FROM tenant WHERE code = 'nav54')`);
      await o.query(`DELETE FROM tenant WHERE code = 'nav54'`);
    }
  });
});
