import { defineConfig } from "vitest/config";
import swc from "unplugin-swc";
/* NestJS 的依赖注入依赖 emitDecoratorMetadata，而 esbuild 不支持它。
   用 SWC 转译测试，保证 DI 在测试里与生产行为一致。 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: "es6" } })],
  test: { include: ["test/**/*.test.ts"], testTimeout: 60_000, fileParallelism: false }
});
