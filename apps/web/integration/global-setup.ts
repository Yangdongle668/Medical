import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/* 集成测试跑在**测试库**上，且每次从确定起点开始：迁移到底、重灌种子。
   不这么做的话，上一轮完成的那次访视会让下一轮找不到可完成的行 ——
   而那种失败看起来像功能坏了，其实是数据没重置。 */

const ROOT = path.resolve(import.meta.dirname, "../../..");

function loadEnv() {
  const f = path.join(ROOT, ".env");
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim();
  }
}

export default function globalSetup() {
  loadEnv();
  const url = process.env["TEST_DATABASE_URL"];
  if (!url) throw new Error("缺少 TEST_DATABASE_URL —— 集成测试必须跑在测试库上");
  const env = { ...process.env, DATABASE_URL: url };
  const M = "npx node-pg-migrate --migrations-dir db/migrations --migrations-table schema_migration";
  execSync(`${M} down 99`, { cwd: ROOT, env, stdio: "pipe" });
  execSync(`${M} up`, { cwd: ROOT, env, stdio: "pipe" });
  execSync("node db/scripts/seed.mjs", { cwd: ROOT, env, stdio: "pipe" });
}
