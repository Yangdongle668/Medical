/* 每次测试前把测试库重建到已知状态：迁移 + 种子。
   测试断言的是 schema 与策略的行为，必须从确定起点出发。 */
import { execSync } from "node:child_process";
import { loadEnv, ROOT } from "../scripts/env.mjs";
loadEnv();

export async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("缺少 TEST_DATABASE_URL");
  const env = { ...process.env, DATABASE_URL: url };
  const M = "npx node-pg-migrate --migrations-dir db/migrations --migrations-table schema_migration";
  execSync(`${M} down 99`, { cwd: ROOT, env, stdio: "pipe" });
  execSync(`${M} up`,      { cwd: ROOT, env, stdio: "pipe" });
  execSync(`node db/scripts/seed.mjs`, { cwd: ROOT, env, stdio: "pipe" });
}
