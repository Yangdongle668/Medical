/* ════════════════════════════════════════════════════════════════════
   浏览器侧的入口。

   **与 src/index.ts 分开是有意的**：那个入口导出 tokens.ts，而
   tokens.ts 读 `node:fs`（它在构建/测试时解析 tokens.css，不另抄一份）。
   两个入口合成一个的话，前端一 import 组件就把 node:fs 拖进了浏览器包。

   所以：`@sitedesk/ui` = 令牌的 Node 视图（测试用）；
        `@sitedesk/ui/react` = 组件（前端用）。
   ════════════════════════════════════════════════════════════════════ */
export { LineChart, Spark, HBars, Diverging, Legend } from "./Chart.js";
export type { Series, BarRow } from "./Chart.js";
export { Drawer, Modal } from "./Overlay.js";
export { ToastHost, useToast } from "./Toast.js";
export { useTip, TipRow } from "./Tip.js";
export { useWidth } from "./useWidth.js";
