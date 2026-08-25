import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  /* 契约与设计系统以源码形式引入（workspace 内的 TS），
     不做预构建 —— 改一行契约立刻反映到前端类型上。 */
  optimizeDeps: { exclude: ["@sitedesk/contracts", "@sitedesk/ui", "@sitedesk/calc"] }
});
