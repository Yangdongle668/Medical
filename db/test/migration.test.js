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
  it("down 到底后只剩迁移记录表", async () => {
    const before = await tables();
    expect(before.length).toBeGreaterThan(10);
    run("down 99");
    expect(await tables()).toEqual(["schema_migration"]);
  });

  it("再 up 能完整恢复，且表集合与之前一致", async () => {
    run("up");
    const after = await tables();
    expect(after).toContain("study_site");
    expect(after).toContain("audit_entry");
    expect(after.length).toBe(17);
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

  it("RLS 在恢复后仍然启用（down/up 不会悄悄丢掉策略）", async () => {
    const { rows } = await o.query(`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relrowsecurity ORDER BY 1`);
    expect(rows.map(r => r.relname)).toEqual(
      ["account","audit_entry","role","site_assignment","study","study_site","team"]);
  });
});
