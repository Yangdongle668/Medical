import { http, HttpResponse } from "msw";
import { allEndpoints } from "@sitedesk/contracts";
import examples from "@sitedesk/contracts/mocks/examples.json";
import { makeScenario, SITES_LIST, type Scenario, type MockVisit } from "./scenario.js";

/* ════════════════════════════════════════════════════════════════════
   MSW 处理器 = 两层。

   ① **场景层**：CRC 那条业务流，有状态、前后连贯（见 scenario.ts）。
   ② **契约兜底层**：其余端点一律回 examples.json 里的示例。

   兜底层是白拿的覆盖面，而且它跟着契约走 —— 新增一个端点，
   前端立刻有 mock 可用，不需要有人记得来补。
   顺序要紧：场景层在前，兜底在后。
   ════════════════════════════════════════════════════════════════════ */

/** 契约路径 → 正则。
 *  不能直接把契约路径交给 MSW：path-to-regexp 把 `:done` 当成路径参数，
 *  于是 `/v1/subject-visits/{id}/tasks/{seq}:done` 这类 L2 命令路径**匹配不上**，
 *  请求悄悄落到兜底处理器上，返回一份静态示例 ——
 *  症状是「点了勾没反应」，而控制台一条错误都没有。
 *  MSW 的正则是拿去比对**整个 URL**的，所以结尾要允许查询串。 */
export function pathToRegExp(path: string): RegExp {
  const body = path
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")   // 先转义正则元字符（含 { } 与 ?）
    .replace(/\\\{(\w+)\\\}/g, "[^/]+");     // 再把 {id} 还原成一段通配
  return new RegExp(body + "(\\?|$)");
}

type Example = {
  method: string; path: string; status: number;
  body?: unknown; bodyWithoutFieldPermission?: unknown;
};
const EX = examples as unknown as Record<string, Example>;

let scenario: Scenario = makeScenario();
export const resetScenario = () => { scenario = makeScenario(); };
export const currentScenario = () => scenario;

/** mock 身份。切换它可以看到「同一个接口，不同的人看到不同的列」。 */
let mockRole: "crc" | "boss" = "crc";
export const setMockRole = (r: "crc" | "boss") => { mockRole = r; };

const ME = {
  account: {
    id: "a-wutong", login: "wutong", displayName: "吴桐",
    role: { id: "r-crc", code: "crc", name: "临床协调员 CRC", isExternal: false },
    team: { id: "t1", code: "G-01", name: "华东华南组" },
    isExternal: false, orgRef: null, status: "active",
    joinedOn: "2024-03-01", disabledAt: null, disabledReason: null,
    lastLoginAt: new Date().toISOString()
  },
  scopeLabel: "2 个中心 · 1 个项目",
  visibleSiteIds: SITES_LIST.map(s => s.id),
  permissions: {
    rowRule: "assigned", fields: ["subject"],
    actions: ["subjRead", "subjWrite", "timeWrite", "ethics"],
    modules: ["today", "sites", "subjects", "timesheets"]
  }
};

const daysBetween = (a: string, b: string) =>
  Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000);
const todayStr = () => new Date().toISOString().slice(0, 10);

/** 按窗口关闭日升序 —— CRC 每天第一件事是看「今天谁到期」 */
const byWindow = (a: MockVisit, b: MockVisit) => a.windowTo.localeCompare(b.windowTo);

const withDaysLeft = (v: MockVisit): MockVisit => ({
  ...v,
  daysLeft: v.actualDate ? null : daysBetween(todayStr(), v.windowTo),
  outOfWindow: v.outOfWindow ||
    (v.status === "planned" && daysBetween(todayStr(), v.windowTo) < 0)
});

export const scenarioHandlers = [
  http.get(pathToRegExp("/v1/me"), () => HttpResponse.json(ME)),

  http.post(pathToRegExp("/v1/auth/dev-session"), () =>
    HttpResponse.json({ token: "mock-token", expiresAt: new Date(Date.now() + 8 * 3600e3).toISOString() })),

  http.get(pathToRegExp("/v1/subject-visits"), ({ request }) => {
    const q = new URL(request.url).searchParams;
    let items = scenario.visits.map(withDaysLeft);
    const subjectId = q.get("subjectId");
    if (subjectId) items = items.filter(v => v.subjectId === subjectId);
    if (q.get("outOfWindow") === "true") items = items.filter(v => v.outOfWindow);
    const status = q.getAll("status");
    if (status.length) items = items.filter(v => status.includes(v.status));
    items.sort(byWindow);
    return HttpResponse.json({ items, nextCursor: null });
  }),

  http.post(pathToRegExp("/v1/subject-visits/{id}/tasks/{seq}:done"), ({ request }) => {
    const [, id, seq] = new URL(request.url).pathname
      .match(/\/subject-visits\/([^/]+)\/tasks\/([^/:]+):done/) ?? [];
    const v = scenario.visits.find(x => x.id === id);
    if (!v) return HttpResponse.json(problem("not-found", 404, "访视不存在"), { status: 404 });
    const t = v.tasks.find(x => x.seq === Number(seq));
    if (t && !t.doneAt) t.doneAt = new Date().toISOString();
    return HttpResponse.json({ data: withDaysLeft(v), sideEffects: [] }, { status: 201 });
  }),

  http.post(pathToRegExp("/v1/subject-visits/{id}:complete"), async ({ request }) => {
    const [, id] = new URL(request.url).pathname
      .match(/\/subject-visits\/([^/:]+):complete/) ?? [];
    const v = scenario.visits.find(x => x.id === id);
    if (!v) return HttpResponse.json(problem("not-found", 404, "访视不存在"), { status: 404 });
    const b = await request.json() as {
      actualDate: string; hours: number; outOfWindowReason?: string };

    const open = v.tasks.filter(t => !t.doneAt);
    if (open.length)
      return HttpResponse.json({
        ...problem("gate-not-satisfied", 422, `本次访视还有 ${open.length} 项任务未完成`),
        unmet: open.slice(0, 5).map(t => ({
          code: "visit-task-open", module: "clinical", message: t.task }))
      }, { status: 422 });

    const outOfWindow = b.actualDate < v.windowFrom || b.actualDate > v.windowTo;
    if (outOfWindow && !b.outOfWindowReason)
      return HttpResponse.json({
        ...problem("invariant-violated", 422,
          `实际完成日 ${b.actualDate} 落在窗口 ${v.windowFrom} ~ ${v.windowTo} 之外，必须说明原因`),
        invariant: "out-of-window-needs-reason"
      }, { status: 422 });

    v.status = "done_pending_pi";
    v.actualDate = b.actualDate;
    v.outOfWindow = outOfWindow;

    /* 一次调用触发一串后果 —— 这正是 L2 命令层存在的理由 */
    const effects: {
      type: string; summary: string; ref?: string; amountCents?: number;
    }[] = [];

    if (outOfWindow) {
      const code = `DEV-${Date.now().toString(36).toUpperCase()}`;
      scenario.qualityEvents.unshift({
        id: code, code, siteCode: v.siteCode, kind: "deviation",
        severity: Math.abs(daysBetween(v.windowTo, b.actualDate)) > 7 ? "major" : "minor",
        state: "open", title: `访视超窗：${v.visitLabel}`,
        detail: `窗口 ${v.windowFrom} ~ ${v.windowTo}，实际完成 ${b.actualDate}。` +
          `填报原因：${b.outOfWindowReason}`,
        autoGenerated: true, raisedBy: "system", raisedOn: b.actualDate, ageDays: 0
      });
      effects.push({ type: "DeviationDetected", ref: code,
        summary: `已生成方案偏离 ${code} —— 超窗不是打个招呼就过去了，它进质量台账` });
    }

    effects.push({ type: "CompensationDue", amountCents: 20000,
      summary: "受试者补偿 200.00 元待发放" });

    const tsId = `ts-${Date.now().toString(36)}`;
    scenario.timesheets.unshift({
      id: tsId, siteCode: v.siteCode, workDate: b.actualDate, hours: b.hours });
    effects.push({ type: "TimesheetPosted", ref: tsId, summary: `已记 ${b.hours} 小时工时` });
    effects.push({ type: "CostPosted", amountCents: Math.round(b.hours / 8 * 129800),
      summary: `成本已归集到 ${v.siteCode}` });

    /* 按 SOA 排下一次 */
    const next: MockVisit = {
      ...v, id: `${v.id}-n${v.seq + 1}`, seq: v.seq + 1,
      visitCode: `V-${v.seq + 1}`, visitLabel: `C${v.seq + 1}D1 第 ${v.seq + 1} 周期给药`,
      targetDate: addDays(b.actualDate, 21),
      windowFrom: addDays(b.actualDate, 21 - v.windowDays),
      windowTo: addDays(b.actualDate, 21 + v.windowDays),
      actualDate: null, status: "planned", edcStatus: "pending",
      outOfWindow: false, daysLeft: null,
      tasks: v.tasks.map(t => ({ ...t, doneAt: null }))
    };
    scenario.visits.push(next);
    effects.push({ type: "NextVisitScheduled", ref: next.id,
      summary: `已排下一次访视：${next.visitLabel}，目标日 ${next.targetDate}，` +
        `窗口 ±${v.windowDays} 天` });

    return HttpResponse.json({
      data: withDaysLeft(v), sideEffects: effects,
      pending: [{ name: "RefreshProjections", what: "刷新入组漏斗与驾驶舱投影",
        phase: "Phase 6" }]
    }, { status: 201 });
  }),

  http.get(pathToRegExp("/v1/quality-events"), () =>
    HttpResponse.json({ items: scenario.qualityEvents, nextCursor: null })),

  http.get(pathToRegExp("/v1/study-sites"), () =>
    HttpResponse.json({
      items: SITES_LIST.map(s => ({
        id: s.id, code: s.code,
        study: { id: "st1", code: "HJ-2024-017", shortName: "艾瑞替尼 III" },
        hospital: s.hospital, dept: "肝胆外科", city: "北京",
        piName: "陈国栋", piAccountId: null, state: s.state, contracted: 30,
        irbApprovedOn: "2024-10-18", sivOn: "2024-12-06",
        sivPlannedOn: null, fpiOn: "2024-12-27",
        ...(mockRole === "boss"
          ? { unitPriceCents: 5800000, startupFeeCents: 17600000 } : {})
      })),
      nextCursor: null
    }))
];

function addDays(d: string, n: number): string {
  const x = new Date(d); x.setDate(x.getDate() + n);
  return x.toISOString().slice(0, 10);
}

function problem(code: string, status: number, detail: string) {
  return {
    type: `https://sitedesk.dev/problems/${code}`,
    title: code, status, code, detail
  };
}

/** 契约兜底：注册表里的每个端点都有 mock，新增端点不需要有人记得来补。 */
export const contractHandlers = allEndpoints().map(e => {
  const ex = EX[e.id];
  const path = pathToRegExp(e.path);
  const fn = () => {
    if (!ex) return new HttpResponse(null, { status: 501 });
    const body = mockRole === "crc" && ex.bodyWithoutFieldPermission
      ? ex.bodyWithoutFieldPermission : ex.body;
    return body === undefined
      ? new HttpResponse(null, { status: ex.status })
      : HttpResponse.json(body, { status: ex.status });
  };
  return e.method === "get" ? http.get(path, fn)
       : e.method === "post" ? http.post(path, fn)
       : e.method === "patch" ? http.patch(path, fn)
       : http.delete(path, fn);
});

export const handlers = [...scenarioHandlers, ...contractHandlers];
