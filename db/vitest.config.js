import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.js"],
    include: ["test/**/*.test.js"],
    testTimeout: 30_000,
    fileParallelism: false          // 共用一个测试库，串行执行
  }
});
