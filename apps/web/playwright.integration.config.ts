import { defineConfig, devices } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/* ════════════════════════════════════════════════════════════════════
   Phase 6 的集成测试：**前端 + 真实后端 + 真实数据库**，没有 MSW。

   这和 Phase 5 的 E2E 是两件事，所以是两份配置：
     · e2e/          打 mock，验的是「界面这条路走得通」
     · integration/  打真库，验的是「契约两侧真的对得上」

   后者才会暴露那类最贵的问题：字段名两边差一个字母、
   分页游标形状不一致、空数组与 null 的处理不同 ——
   它们在 mock 上永远不会出现，因为 mock 是照着同一份契约写的。
   ════════════════════════════════════════════════════════════════════ */

function chromiumPath(): string | undefined {
  const root = process.env["PLAYWRIGHT_BROWSERS_PATH"];
  if (!root || !fs.existsSync(root)) return undefined;
  const dir = fs.readdirSync(root).filter(d => /^chromium-\d+$/.test(d)).sort().at(-1);
  if (!dir) return undefined;
  const exe = path.join(root, dir, "chrome-linux", "chrome");
  return fs.existsSync(exe) ? exe : undefined;
}
const EXE = chromiumPath();

/* 后端必须连**测试库**，且以非 owner 角色连接 —— 用 owner 连的话
   RLS 形同虚设，集成测试会全绿而什么也没证明。 */
function apiEnv(): Record<string, string> {
  const f = path.resolve(import.meta.dirname, "../../.env");
  const env: Record<string, string> = {};
  if (fs.existsSync(f))
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z][A-Z0-9_]*)=(.*)$/);
      if (m) env[m[1]!] = m[2]!.trim();
    }
  const app = process.env["APP_TEST_DATABASE_URL"] ?? env["APP_TEST_DATABASE_URL"];
  if (!app) throw new Error("缺少 APP_TEST_DATABASE_URL");
  return { ...env, APP_DATABASE_URL: app, SITEDESK_DEV_LOGIN: "1", PORT: "3000" };
}

export default defineConfig({
  testDir: "./integration",
  globalSetup: "./integration/global-setup.ts",
  fullyParallel: false,          // 共用一个数据库，串行才有确定的起点
  workers: 1,
  forbidOnly: !!process.env["CI"],
  reporter: process.env["CI"] ? "list" : "line",
  timeout: 60_000,
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    ...(EXE ? { launchOptions: { executablePath: EXE } } : {})
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      /* 真实后端。SITEDESK_DEV_LOGIN=1 让开发登录端点存在 —— 集成测试
         不该去解析邮件里的链接，那是 Phase 8 的端到端才做的事。 */
      /* 用 tsx 直接跑源码，不用先 tsc 再 node dist/main.js。
         原因：workspace 依赖（contracts / policy / calc）以 TS 源码形式导出，
         而 apps/api 的 tsc 只编译自己 —— dist/main.js 里 import 的仍然是 .ts，
         Node 跑不起来（ERR_MODULE_NOT_FOUND，报的是找不到 primitives.js）。
         生产打包怎么解决是 Phase 9 的事，已记在已知问题里。 */
      command: "npm run serve -w @sitedesk/api",
      cwd: path.resolve(import.meta.dirname, "../.."),
      url: "http://127.0.0.1:3000/v1/me",
      /* 未登录时 /v1/me 返回 401 —— 对「服务起来了」来说这就是成功信号 */
      ignoreHTTPSErrors: true,
      reuseExistingServer: !process.env["CI"],
      timeout: 180_000,
      stdout: "pipe", stderr: "pipe",
      env: apiEnv()
    },
    {
      command: "npm run preview",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: !process.env["CI"],
      timeout: 120_000,
      stdout: "pipe", stderr: "pipe"
    }
  ]
});
