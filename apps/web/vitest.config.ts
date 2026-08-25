import { defineConfig } from "vitest/config";

/* apps/web 的单元测试：只测**不需要浏览器**的那一层。
 *
 *  界面本身由 e2e（打 mock）与 integration（打真库）两层盖住，
 *  这里补的是它们够不着的地方 —— 比如发件箱的判重：
 *  界面上那一格勾不动，所以"重复入队会被折叠"这条
 *  在 e2e 里根本触发不了，只能在这一层直接验。 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"]
  }
});
