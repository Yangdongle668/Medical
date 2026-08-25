import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** 真实后端地址。不设就默认本机 3000。 */
const API = process.env["VITE_API_ORIGIN"] ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react()],
  /* Phase 6 起前端可以打真实后端。
     走 vite 代理而不是让浏览器直连 :3000 —— 同源之后就没有 CORS 这件事，
     生产上前端与 API 也本来就该同源（一个反向代理后面）。 */
  server: { port: 5173, strictPort: true, proxy: { "/v1": API } },
  /* host 必须写死成 127.0.0.1。
     缺省的 "localhost" 在 GitHub runner 上先解析到 ::1，vite 于是只监听 IPv6，
     而 Playwright 的 webServer 轮询的是 http://127.0.0.1:4173 —— 永远等不到，
     60 秒后只报一句 "Timed out waiting from config.webServer"，
     看不出是地址族对不上。本机 localhost 解析到 IPv4，所以本地全绿。 */
  preview: { port: 4173, strictPort: true, host: "127.0.0.1", proxy: { "/v1": API } },
  /* 契约与设计系统以源码形式引入（workspace 内的 TS），
     不做预构建 —— 改一行契约立刻反映到前端类型上。 */
  optimizeDeps: { exclude: ["@sitedesk/contracts", "@sitedesk/ui", "@sitedesk/calc"] }
});
