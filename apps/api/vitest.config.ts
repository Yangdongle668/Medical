import { defineConfig } from "vitest/config";
import swc from "unplugin-swc";
/* NestJS 的依赖注入依赖 emitDecoratorMetadata，而 esbuild 不支持它。
   用 SWC 转译测试，保证 DI 在测试里与生产行为一致。 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: "es6" } })],
  test: {
    include: ["test/**/*.test.ts"], testTimeout: 60_000, fileParallelism: false,
    /* 每个请求一行访问日志，跑起来是几百行 —— 会把 reporter 的输出淹掉。
       降到 warn：告警和错误照样看得见，日志本身由 log.test.ts 单独验
       （那个文件在 beforeEach 里把这个变量删掉，用的是真实默认值）。 */
    env: { SITEDESK_LOG_LEVEL: "warn" }
  }
});
