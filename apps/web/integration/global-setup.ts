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

/** 集成测试跑的必须是 **live 构建**（不带 MSW）。
 *
 *  踩过一次：直接 `playwright test -c playwright.integration.config.ts`
 *  而没先 `build:live`，`dist/` 里还是上一次的 mock 构建 ——
 *  于是"集成测试"整套打在 MSW 上，**一条契约也没验到，还全绿**。
 *  （那次是因为登录后显示的是 mock 里的吴桐、中心 id 是 s1 才发现的。）
 *
 *  这类错误不会自己响，所以在这里量产物：dist 里出现 msw 就直接停。 */
function assertLiveBuild() {
  const dir = path.join(ROOT, "apps/web/dist/assets");
  if (!fs.existsSync(dir))
    throw new Error("apps/web/dist 不存在 —— 集成测试前要先 npm run build:live");
  const withMsw = fs.readdirSync(dir)
    .filter(f => f.endsWith(".js"))
    .filter(f => fs.readFileSync(path.join(dir, f), "utf8").includes("msw"));
  if (withMsw.length)
    throw new Error(
      `dist 里带着 MSW（${withMsw.join(", ")}）—— 这是 mock 构建，不是 live。\n` +
      "集成测试必须打真实后端：请用 `npm run integration -w @sitedesk/web`，" +
      "它会先跑 build:live。");
}

export default function globalSetup() {
  loadEnv();
  assertLiveBuild();
  const url = process.env["TEST_DATABASE_URL"];
  if (!url) throw new Error("缺少 TEST_DATABASE_URL —— 集成测试必须跑在测试库上");
  const env = { ...process.env, DATABASE_URL: url };
  const M = "npx node-pg-migrate --migrations-dir db/migrations --migrations-table schema_migration";
  execSync(`${M} down 99`, { cwd: ROOT, env, stdio: "pipe" });
  execSync(`${M} up`, { cwd: ROOT, env, stdio: "pipe" });
  execSync("node db/scripts/seed.mjs", { cwd: ROOT, env, stdio: "pipe" });
}
