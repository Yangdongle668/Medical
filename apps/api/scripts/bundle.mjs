/* 生产打包 —— 把 API 打成一个可以直接 `node` 起来的文件。
 *
 *  ── 为什么之前起不来 ────────────────────────────────────────────
 *  `tsc -p tsconfig.build.json` 只编译 apps/api 自己。
 *  而 workspace 依赖是以 **TS 源码** 导出的（`"main": "./src/index.ts"`），
 *  于是产物里 `import "@sitedesk/contracts"` 指到 `packages/contracts/src/index.ts`，
 *  那个文件内部又写着 `./kernel/primitives.js` —— 那是 TS 的 ESM 写法，
 *  磁盘上根本没有对应的 .js：
 *
 *      Error [ERR_MODULE_NOT_FOUND]:
 *        Cannot find module .../packages/contracts/src/kernel/primitives.js
 *
 *  这条从 Phase 6a 就记在已知问题里，因为在此之前没有人真的 `node dist/main.js` 过 ——
 *  测试走 vitest（有转译），开发走 @swc-node/register（也有转译）。
 *  **一条从来没被走过的路径，不会有任何东西提醒你它是断的。**
 *
 *  ── 为什么是"打包"而不是"把每个包也编译成 dist" ──────────────────
 *  后者要动四个包的 exports，而那四个包同时被 vite、vitest、swc 消费着 ——
 *  一个生产问题不该让开发路径全部改道。
 *  这里只内联 `@sitedesk/*`，其余（@nestjs、pg、rxjs、zod）保持外部依赖，
 *  照常由 npm 安装。影响面止于 apps/api。
 *
 *  ── 为什么要先 tsc 再 esbuild ───────────────────────────────────
 *  esbuild **不支持 emitDecoratorMetadata**，而 NestJS 的依赖注入正靠它。
 *  所以顺序是：tsc 先把 apps/api 编出带元数据的 JS，
 *  esbuild 只负责把 workspace 依赖（纯 TS，无装饰器）内联进来。
 *  反过来做的话，DI 会在运行时报"找不到可注入的类型"。
 */
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = path.resolve(HERE, "..");

/** 只内联 @sitedesk/*；其余裸导入一律外部。 */
const externalExceptWorkspace = {
  name: "external-except-workspace",
  setup(b) {
    b.onResolve({ filter: /^[^./]|^\.[^./]|^\.\.[^/]/ }, args => {
      if (args.path.startsWith("@sitedesk/")) return null;   // 交给默认解析 → 内联
      return { path: args.path, external: true };
    });
  }
};

const out = path.join(API, "build", "server.mjs");
await build({
  entryPoints: [path.join(API, "dist", "main.js")],
  outfile: out,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  /* Nest 在运行时会去 require 一些可选依赖（各种平台适配器）。
     保持它们外部即可 —— 它们本来就在 node_modules 里。 */
  plugins: [externalExceptWorkspace],
  logLevel: "warning"
});

console.log(`✓ 已打包：${path.relative(process.cwd(), out)}`);
