import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider, Navigate } from "react-router-dom";
import { App } from "./shell/App.js";
import { TodayPage } from "./features/today/TodayPage.js";
import { VisitPage } from "./features/visit/VisitPage.js";
import { SitesPage } from "./features/sites/SitesPage.js";
import { QualityPage } from "./features/quality/QualityPage.js";
import "./shell/styles.css";

const router = createBrowserRouter([
  {
    path: "/", element: <App />,
    children: [
      { index: true, element: <Navigate to="/today" replace /> },
      { path: "today", element: <TodayPage /> },
      { path: "visits/:id", element: <VisitPage /> },
      { path: "sites", element: <SitesPage /> },
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

async function boot() {
  if (USE_MOCKS) {
    const { worker } = await import("./mocks/browser.js");
    await worker.start({ onUnhandledRequest: "bypass", quiet: true });
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode><RouterProvider router={router} /></StrictMode>
  );
}
void boot();
