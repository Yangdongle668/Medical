import { defineConfig, devices } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/** 找到本机已装的 Chromium。
 *  不写死构建号（chromium-1194）—— 镜像更新一次就得改一次配置，
 *  而那时的报错是「executable doesn't exist」，看不出是配置过期了。 */
function chromiumPath(): string | undefined {
  const root = process.env["PLAYWRIGHT_BROWSERS_PATH"];
  if (!root || !fs.existsSync(root)) return undefined;
  const dir = fs.readdirSync(root)
    .filter(d => /^chromium-\d+$/.test(d))
    .sort().at(-1);
  if (!dir) return undefined;
  const exe = path.join(root, dir, "chrome-linux", "chrome");
  return fs.existsSync(exe) ? exe : undefined;
}
const EXE = chromiumPath();

/* Phase 5 的两条退出标准都只能在真实浏览器里验：
   ② 390 / 834 / 1500px 零横向溢出
   ③ 用 mock 走通一条完整业务流
   所以 E2E 跑在构建产物上（带 MSW），不是 dev server ——
   dev 与 prod 的模块解析不同，只测 dev 等于没测发出去的那份。

   Phase 9e 起，`npm run preview` 起的是**生产托管服务器**
   （apps/web/server.mjs），不再是 vite preview。于是这两层测试
   顺带把上线要走的那条路径也走了一遍：SPA 回退、CSP、同源反代
   一旦配错，这里就是白屏或者满屏 CSP 报错。 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  retries: 0,
  reporter: process.env["CI"] ? "list" : "line",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    ...(EXE ? { launchOptions: { executablePath: EXE } } : {})
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run preview",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env["CI"],
    /* CI 上冷启动比本机慢；给足时间，超时只会让人去查错的方向 */
    timeout: 120_000,
    /* 让 preview 自己的输出可见 —— 否则起不来时只有一句 "Timed out"，
       而真正的原因（端口占用、dist 不存在、地址族不对）全被吞了 */
    stdout: "pipe",
    stderr: "pipe"
  }
});
