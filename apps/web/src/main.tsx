import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider, Navigate } from "react-router-dom";
import { App } from "./shell/App.js";
import { ErrorBoundary } from "./shell/ErrorBoundary.js";
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
import { OrgPage } from "./features/org/OrgPage.js";
import { EnrollmentPage } from "./features/enrollment/EnrollmentPage.js";
import { ScreenPage } from "./features/enrollment/ScreenPage.js";
import { StaffPage } from "./features/staff/StaffPage.js";
import { AuditPage } from "./features/audit/AuditPage.js";
import { DashPage } from "./features/dashboard/DashPage.js";
import { PnlPage } from "./features/cost/PnlPage.js";
import { PeoplePage } from "./features/staff/PeoplePage.js";
import { SubjectsPage } from "./features/subject/SubjectsPage.js";
import { PrescreenPage } from "./features/subject/PrescreenPage.js";
import { PaymentsPage } from "./features/subject/PaymentsPage.js";
import { EthicsPage } from "./features/ethics/EthicsPage.js";
import { StartupSummaryPage } from "./features/site/StartupSummaryPage.js";
import { MaterialPage } from "./features/material/MaterialPage.js";
import { PmPage } from "./features/workbench/PmPage.js";
import { TeamPage } from "./features/workbench/TeamPage.js";
import { ApprovalsPage } from "./features/workbench/ApprovalsPage.js";
import { SchedulePage } from "./features/workbench/SchedulePage.js";
import { PiPage } from "./features/external/PiPage.js";
import { InstPage } from "./features/external/InstPage.js";
import { InstQcPage } from "./features/external/InstQcPage.js";
import { InstRegistryPage } from "./features/external/InstRegistryPage.js";
import { FeasPage } from "./features/bizdev/FeasPage.js";
import { PricePage } from "./features/bizdev/PricePage.js";
import { BidPage } from "./features/bizdev/BidPage.js";
import { ChangePage } from "./features/bizdev/ChangePage.js";
import { ComingSoon } from "./shell/ComingSoon.js";
import { MODULES } from "./shell/modules.js";
import { MOCK_ROLES, type MockRole } from "./mocks/roles.js";
import "./shell/styles.css";

/* 已经建好的页 —— 按路径登记。
   模块登记表（shell/modules.ts）里凡是没出现在这张表里的路径，
   都落到 ComingSoon：**导航照出、路由照通、页面说清自己还没建**。
   三者缺一样，"库里给了这个模块"和"界面上有这个模块"就会对不上。 */
const BUILT: Record<string, React.ReactElement> = {
  "/today": <TodayPage />,
  "/sites": <SitesPage />,
  "/handovers": <HandoverPage />,
  "/timesheets": <TimesheetPage />,
  "/quality": <QualityPage />,
  "/org": <OrgPage />,
  "/enr": <EnrollmentPage />,
  "/screen": <ScreenPage />,
  "/staff": <StaffPage />,
  "/trail": <AuditPage />,
  "/dash": <DashPage />,
  "/pnl": <PnlPage />,
  "/people": <PeoplePage />,
  "/subjects": <SubjectsPage />,
  "/prescreen": <PrescreenPage />,
  "/payments": <PaymentsPage />,
  "/ethics": <EthicsPage />,
  "/startup": <StartupSummaryPage />,
  "/material": <MaterialPage />,
  "/pm": <PmPage />,
  "/team": <TeamPage />,
  "/approvals": <ApprovalsPage />,
  "/sched": <SchedulePage />,
  "/pi": <PiPage />,
  "/inst": <InstPage />,
  "/inst/qc": <InstQcPage />,
  "/inst/registry": <InstRegistryPage />,
  "/feas": <FeasPage />,
  "/price": <PricePage />,
  "/bid": <BidPage />,
  "/change": <ChangePage />
};

/* 45 个模块的路由。同一个路径被几个模块共用是正常的
   （crc 与 cra 都是 /today，mysite / mysites / sites 都是 /sites）——
   去重，否则 react-router 会拿到重复的 path。 */
const moduleRoutes = [...new Map(MODULES.map(m => [m.path, m])).values()]
  .map(m => ({
    path: m.path.replace(/^\//, ""),
    element: BUILT[m.path] ?? <ComingSoon />
  }));

const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  {
    path: "/", element: <App />,
    children: [
      { index: true, element: <Navigate to="/today" replace /> },
      ...moduleRoutes,
      /* 详情页与不进导航的那几页。它们不属于任何模块 ——
         详情页从列表点进去，发件箱由侧栏那个角标进去。 */
      { path: "visits/:id", element: <VisitPage /> },
      { path: "sites/:id", element: <SiteDetailPage /> },
      { path: "sites/:id/startup", element: <StartupChecklistPage /> },
      { path: "sites/:id/pnl", element: <SitePnlPage /> },
      { path: "rate-cards", element: <RateCardPage /> },
      { path: "outbox", element: <OutboxPage /> },
      /* 兜底：手敲了一个不存在的路径。回首页比留在一张白页上有用。 */
      { path: "*", element: <Navigate to="/today" replace /> }
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
 *  「同一个按钮，谁点得动」是要看得见的差别，翻一页就丢了等于没有。
 *
 *  **外部两个身份（inst / pi）不是凑数的。** 它们的行范围
 *  （本院 / 本人担任研究者的中心）比内部窄，而"窄"这件事
 *  只有真的换过去看一眼才发现得了 —— 界面上少了哪几行、
 *  哪个按钮点不动。mock 里扮不了外部角色，那四页就等于没测过。 */
function mockRoleFromUrl(): MockRole {
  const q = new URLSearchParams(location.search).get("as");
  const ok = (v: string | null): v is MockRole =>
    v !== null && (MOCK_ROLES as readonly string[]).includes(v);
  try {
    if (ok(q)) { sessionStorage.setItem("sitedesk.as", q); return q; }
    const saved = sessionStorage.getItem("sitedesk.as");
    if (ok(saved)) return saved;
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
    <StrictMode>
      <ErrorBoundary scope="root">
        <RouterProvider router={router} />
      </ErrorBoundary>
    </StrictMode>
  );
}
void boot();
