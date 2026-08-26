# @sitedesk/web — 前端

React + Vite。Phase 5 全程走 MSW mock，Phase 6 才接真实接口 ——
这正是「前后端并行」的意思：前端不等后端，但也不自己编一套数据结构。

```bash
npm run web:dev          # 开发（自动挂 MSW）
npm run web:build        # 生产构建（**不含** MSW）
npm run web:e2e          # 带 mock 构建 + Playwright
```

## client 由契约派生，不是由 openapi.yaml 生成

Phase 0 的目录规划写的是「由 openapi.yaml 生成的 client」。这里少走一步：
`openapi.yaml` 本身就是由契约注册表生成的，直接读注册表等于读同一个源，
还省掉一个代码生成器和它的漂移风险。

于是有一件事变成编译期保证：**契约里没有的端点，前端调不出来。**
`operationId` 打错一个字母，`tsc` 立刻报错，而不是运行时 404。

## MSW 是两层

| 层 | 内容 | 为什么 |
|---|---|---|
| 场景层 `mocks/scenario.ts` | CRC 那条业务流，**有状态、前后连贯** | 契约示例各自随机，拼不成一条流程：勾掉的任务下一次请求又是未勾的 |
| 兜底层 `mocks/handlers.ts` | 其余端点回 `examples.json` | 白拿的覆盖面，且跟着契约走 —— 新增端点立刻有 mock，不需要有人记得来补 |

**路径必须转成正则再交给 MSW。** path-to-regexp 会把 `:done` 当成路径参数，
于是 `/v1/subject-visits/{id}/tasks/{seq}:done` 这类 L2 命令路径匹配不上，
请求悄悄落到兜底层、返回一份静态示例 ——
症状是「点了勾没反应」，而控制台一条错误都没有。见 `pathToRegExp()`。

## 两条构建期纪律

1. **mock 开关必须用点号访问**：`import.meta.env.VITE_USE_MOCKS` 会被静态替换，
   整个分支随之成为死代码被摇掉。写成 `import.meta.env["VITE_USE_MOCKS"]` 就不会 ——
   于是 MSW 的 480 kB 跟着上生产，而没有任何构建警告。CI 直接 grep 产物来兜底。
2. **业务代码不得 import mock**（`arch:check` 强制）。

## 横向溢出：两道防线，别搞错哪道在受力

横向滚动条在 390px 上等于「这个页面没做手机」，而 CRC 一半时间是在
医院走廊上用手机看的。

- **`.table-wrap { overflow-x: auto }` 是承重的那道。** 去掉它，390px 上
  立刻溢出 185px（实测）。宽表格应该在自己的容器里滚，而不是把整页拖着滚。
- `minmax(0, 1fr)` 是第二道。有了第一道之后它并不吃力，但留着 ——
  下一个宽组件未必记得给自己加滚动容器。

`e2e/layout.spec.ts` 在 390 / 834 / 1500 三个宽度 × 三个路由上量
`documentElement.scrollWidth`，溢出时**指出是哪个元素撑开的** ——
只报「溢出了 12px」没法修。

## 上线怎么跑：`server.mjs`，不是 `vite preview`

`vite preview` 是开发工具（Vite 自己的文档写着不要用于生产）。
生产托管在 `server.mjs`，它负责四件**缺了不会报错**的事：

- **SPA 回退** —— react-router 用 history 路由，刷新 `/sites/abc`
  服务器上没有这个文件。不回退就是 404：开发环境永远正常，
  上线之后"一刷新就白屏"。
  但**带扩展名的路径不回退** —— 少一个 js 却回一份 HTML，
  浏览器报的是 `Unexpected token '<'`，指向完全错误的方向。
- **缓存方向** —— `assets/` 带内容哈希，一年 + `immutable`；
  `index.html` 只能 `no-cache`（配 ETag，代价是一次 304）。
  反过来做一次，用户手里的旧 index.html 会去要一个已经删掉的哈希文件：
  白屏，而且清不掉，因为那份 index.html 自己就在缓存里。
- **同源反代 `/v1`** —— 于是没有 CORS，也不用把 API 地址编译进产物。
- **安全响应头** —— CSP / nosniff / frame-ancestors。
  CSP 是照着真实产物写的：`script-src 'self'` 成立（产物里没有内联脚本），
  但 index.html 里有 Google Fonts 的两个外部域，写死 `'self'`
  会让字体**静默失效**（页面照常显示，只是全部回退到系统字体）。
  **加了新的外部资源就要同步改 CSP**，否则它会被静默拦掉。

运行时零 npm 依赖，只用 Node 内置模块。

```bash
npm run build:live -w @sitedesk/web              # 产物 → dist/
PORT=8080 SITEDESK_API_ORIGIN=http://api:3000 \
  node apps/web/server.mjs
```

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8080 | |
| `HOST` | 0.0.0.0 | |
| `SITEDESK_WEB_ROOT` | `./dist` | 静态目录 |
| `SITEDESK_API_ORIGIN` | `http://127.0.0.1:3000` | `/v1` 反代到哪 |
| `SITEDESK_LOG_FORMAT` | 生产 json / 其余 pretty | |
| `SITEDESK_LOG_LEVEL` | info | `debug` 打开探针与静态产物的访问日志 |
| `SITEDESK_DRAIN_MS` | 未设 → 5000 | 收到 SIGTERM 后 `/healthz` 转 503，等这么久再关。畸形的值**拒绝启动** |
| `SITEDESK_LB_PROBE_MS` | 未设 | 填 LB 的探测间隔，排空时长由它 × 失败阈值算出来 |
| `SITEDESK_LB_PROBE_FAILURES` | 2 | 连续几次探测失败才摘掉 |
| `SITEDESK_HSTS_MAX_AGE` | 未设（关） | 秒。**只在 `X-Forwarded-Proto: https` 时发** |
| `SITEDESK_HSTS_PRELOAD` | 未设 | `1` 时在 HSTS 头上加 `; preload` |
| `SITEDESK_FORCE_HTTPS` | 未设（关） | 明文请求 308 到 https（`/healthz` 除外） |

`npm run preview` 起的就是它（只是换成测试用的 4173 端口），
所以 e2e 与 integration 走的是**真正要上线的那条路径**。

**TLS 握手**交给前面那层 ingress，限流归 API。其余两件这个进程自己做：

**预压缩**：`npm run build` 之后跑 `scripts/precompress.mjs`，产出 `.br` / `.gz`
（452 kB 的 js → 117 kB）。这里只做协商：按 `Accept-Encoding` 挑一份发出去，
带上 `Vary: Accept-Encoding`，ETag 按**实际发出去的那份**算 ——
三种编码共用一个 ETag 是缓存投毒的经典形状。没有预压缩产物就发原文，
那是正常情况（小文件不值得压），不是错误。

**HSTS / 强制 https**：默认关，因为打开它们造成的破坏不可回滚 ——
对着一个没有证书的域名发一次 HSTS，浏览器会把它锁到 `max-age` 过期。
判断"这一跳在不在 TLS 后面"只看 `X-Forwarded-Proto` 的**最左**一段：
多层代理时那才是浏览器真正用的协议。强制跳转用 308（301/302 允许客户端
把 POST 改写成 GET，请求体会被静默丢掉），且**探针不跟着跳** ——
健康检查通常不带 `X-Forwarded-Proto`，跟着跳等于把自己摘掉。
