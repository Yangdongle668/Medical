import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  /* host 必须写死成 127.0.0.1。
     缺省的 "localhost" 在 GitHub runner 上先解析到 ::1，vite 于是只监听 IPv6，
     而 Playwright 的 webServer 轮询的是 http://127.0.0.1:4173 —— 永远等不到，
     60 秒后只报一句 "Timed out waiting from config.webServer"，
     看不出是地址族对不上。本机 localhost 解析到 IPv4，所以本地全绿。 */
  preview: { port: 4173, strictPort: true, host: "127.0.0.1" },
  /* 契约与设计系统以源码形式引入（workspace 内的 TS），
     不做预构建 —— 改一行契约立刻反映到前端类型上。 */
  optimizeDeps: { exclude: ["@sitedesk/contracts", "@sitedesk/ui", "@sitedesk/calc"] }
});
