import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { owner } from "./helpers.js";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const M = "npx node-pg-migrate --migrations-dir db/migrations --migrations-table schema_migration";
const run = args => execSync(`${M} ${args}`, {
  cwd: ROOT, stdio: "pipe",
  env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL }
});

let o;
beforeAll(async () => { o = owner(); await o.connect(); });
afterAll(async () => { await o.end(); });

const tables = async () => {
  const { rows } = await o.query(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1");
  return rows.map(r => r.tablename);
};

describe("迁移：本地可重复执行（生产只进不退）", () => {
  /* 断言"前后集合一致"而不是某个数字 —— 数字会让每加一张表都要改测试，
     而改测试去迁就实现，正是测试开始失效的那一刻。 */
  let before = [];

  it("down 到底后只剩迁移记录表", async () => {
    before = await tables();
    expect(before.length).toBeGreaterThan(10);
    run("down 99");
    expect(await tables()).toEqual(["schema_migration"]);
  });

  it("再 up 能完整恢复，且表集合与之前**逐一**一致", async () => {
    run("up");
    const after = await tables();
    expect(after).toEqual(before);
    expect(after).toContain("study_site");
    expect(after).toContain("audit_entry");
  });

  it("重复 up 是幂等的", async () => {
    const a = await tables();
    run("up");
    expect(await tables()).toEqual(a);
  });

  it("恢复后种子可再次灌入", () => {
    execSync("node db/scripts/seed.mjs", {
      cwd: ROOT, stdio: "pipe",
      env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL }
    });
  });

  /* 不再硬编码表名清单：每加一张表都要改测试，改着改着就会有人顺手把新表从清单里
     "临时"去掉。改为自维护的规则 —— 凡是带 tenant_id 的表，必须启用 RLS。 */
  it("凡是带 tenant_id 的表都启用了 RLS（down/up 不会悄悄丢掉策略）", async () => {
    const { rows } = await o.query(`
      SELECT c.relname FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND EXISTS (SELECT 1 FROM information_schema.columns col
                      WHERE col.table_name = c.relname AND col.column_name = 'tenant_id')
         AND c.relname <> 'tenant'
         AND NOT c.relrowsecurity
       ORDER BY 1`);
    expect(rows.map(r => r.relname), "这些表带租户列却没开 RLS").toEqual([]);
  });

  it("每张启用了 RLS 的表都至少有一条策略 —— 启用而无策略等于全部拒绝，会静默出事", async () => {
    const { rows } = await o.query(`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname='public' AND c.relrowsecurity
         AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)`);
    expect(rows.map(r => r.relname)).toEqual([]);
  });
});
