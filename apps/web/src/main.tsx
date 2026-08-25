import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider, Navigate } from "react-router-dom";
import { App } from "./shell/App.js";
import { TodayPage } from "./features/today/TodayPage.js";
import { VisitPage } from "./features/visit/VisitPage.js";
import { SitesPage } from "./features/sites/SitesPage.js";
import { SiteDetailPage } from "./features/site/SiteDetailPage.js";
import { StartupChecklistPage } from "./features/site/StartupChecklistPage.js";
import { HandoverPage } from "./features/handover/HandoverPage.js";
import { TimesheetPage } from "./features/cost/TimesheetPage.js";
import { SitePnlPage } from "./features/cost/SitePnlPage.js";
import { RateCardPage } from "./features/cost/RateCardPage.js";
import { OutboxPage } from "./features/outbox/OutboxPage.js";
import { QualityPage } from "./features/quality/QualityPage.js";
import { LoginPage } from "./features/login/LoginPage.js";
import "./shell/styles.css";

const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  {
    path: "/", element: <App />,
    children: [
      { index: true, element: <Navigate to="/today" replace /> },
      { path: "today", element: <TodayPage /> },
      { path: "visits/:id", element: <VisitPage /> },
      { path: "sites", element: <SitesPage /> },
      { path: "sites/:id", element: <SiteDetailPage /> },
      { path: "sites/:id/startup", element: <StartupChecklistPage /> },
      { path: "sites/:id/pnl", element: <SitePnlPage /> },
      { path: "handovers", element: <HandoverPage /> },
      { path: "timesheets", element: <TimesheetPage /> },
      { path: "rate-cards", element: <RateCardPage /> },
      { path: "outbox", element: <OutboxPage /> },
      { path: "quality", element: <QualityPage /> }
    ]
  }
]);

/* Phase 5 全程走 mock —— 后端接口在 Phase 6 才接。
   开关必须是**构建期**的，且必须用点号访问：`import.meta.env.VITE_USE_MOCKS`
   会被静态替换成字面量，整个分支随之成为死代码被摇掉；
   写成 `import.meta.env["VITE_USE_MOCKS"]` 就不会替换 ——
   于是 msw 的 480 kB 跟着上生产，而没有任何构建警告提醒你。 */
const USE_MOCKS = import.meta.env.DEV || import.meta.env.VITE_USE_MOCKS === "1";

/** mock 模式下用 `?as=boss` 换一个身份看同一个页面。
 *  存进 sessionStorage 是因为换页面要保持住 —— 这套界面里
 *  「同一个按钮，谁点得动」是要看得见的差别，翻一页就丢了等于没有。 */
function mockRoleFromUrl(): "crc" | "boss" {
  const q = new URLSearchParams(location.search).get("as");
  try {
    if (q === "boss" || q === "crc") { sessionStorage.setItem("sitedesk.as", q); return q; }
    const saved = sessionStorage.getItem("sitedesk.as");
    if (saved === "boss" || saved === "crc") return saved;
  } catch { /* 隐私模式下 sessionStorage 会抛 —— 退回默认身份即可 */ }
  return "crc";
}

async function boot() {
  if (USE_MOCKS) {
    const { worker, setMockRole } = await import("./mocks/browser.js");
    setMockRole(mockRoleFromUrl());
    await worker.start({ onUnhandledRequest: "bypass", quiet: true });
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode><RouterProvider router={router} /></StrictMode>
  );
}
void boot();
