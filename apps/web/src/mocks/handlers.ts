import { http, HttpResponse } from "msw";
import { allEndpoints, SITE_STATES, DEFAULT_HANDOVER_ITEMS } from "@sitedesk/contracts";
import { siteRevenue, siteCost, siteMargin, CALC_VERSION,
  saeTimeliness, saeReportHours, type CostEntry } from "@sitedesk/calc";
import { fieldGates } from "@sitedesk/contracts";
import { maskFields } from "@sitedesk/policy";
import examples from "@sitedesk/contracts/mocks/examples.json";
import { makeScenario, SITES_LIST, STAFF_LIST, mkTimesheet, WORK_TYPE_META,
  type Scenario, type MockVisit, type MockHandover, type MockRateCard,
  type MockTimesheet } from "./scenario.js";

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

/** mock 身份。切换它可以看到「同一个接口，不同的人看到不同的列、
 *  以及同一个按钮，不同的人点不点得动」。
 *  由 URL 上的 `?as=boss` 驱动（见 main.tsx），所以 e2e 里换个人只要换个地址。 */
let mockRole: "crc" | "boss" = "crc";
export const setMockRole = (r: "crc" | "boss") => { mockRole = r; };

/** 与种子里的 role_action / role_field **逐字**同一套口径。
 *
 *  抹平任何一条，界面上最要紧的差别就在 mock 上消失了，
 *  而真库上一登录就撞见 —— 这套 mock 存在的意义正是提前撞见它们：
 *
 *  · **CRC 没有 advance**：清单做完了，最后那一下也不归他按
 *  · **CRC 没有 cost**：他填工时，却看不到自己值多少钱
 *  · **只有 boss 有 rateWrite**：费率卡是经营层的事
 *  · **boss 没有 subject**：钱看得全，受试者明细反而看不到 */
const ROLE = {
  crc: {
    id: "a-wutong", login: "wutong", name: "吴桐",
    role: { id: "r-crc", code: "crc", name: "临床协调员 CRC" },
    rowRule: "assigned", fields: ["subject"],
    actions: ["ethics", "subjRead", "subjWrite", "timeWrite"],
    /* **module_key，不是路径。** 这里曾经写的是 ["today","sites",…]，
       而真接口给的是 role_module 里的键 —— 两者恰好长得像，
       所以在导航还是写死数组的时候看不出区别。侧栏改成按模块出之后，
       一份路径清单会让 mock 模式下的导航整个空掉。
       取值与迁移 0026 里 crc 的授予一致。 */
    modules: ["crc", "mysite", "startup", "sched", "subj", "prescreen", "ethics",
      "query", "capa", "isf", "material", "pay", "handover", "time"]
  },
  boss: {
    id: "a-lingyuan", login: "lingyuan", name: "凌远",
    role: { id: "r-boss", code: "boss", name: "经营层" },
    rowRule: "all", fields: ["cost", "margin", "price", "staff"],
    actions: ["advance", "approve", "bid", "manage", "rateWrite",
      "subjRead", "timeWrite"],
    modules: ["dash", "intake", "sites", "enr", "screen", "client", "cash", "bid",
      "change", "staff", "people", "time", "pnl", "bill", "qa", "mon", "price",
      "org", "trail"]
  }
} as const;


const me = () => {
  const r = ROLE[mockRole];
  return {
    account: {
      id: r.id, login: r.login, displayName: r.name,
      role: { ...r.role, isExternal: false },
      team: { id: "t1", code: "G-01", name: "华东华南组" },
      isExternal: false, orgRef: null, status: "active",
      joinedOn: "2024-03-01", disabledAt: null, disabledReason: null,
      lastLoginAt: new Date().toISOString()
    },
    scopeLabel: `${SITES_LIST.length} 个中心 · 1 个项目`,
    permissions: {
      rowRule: r.rowRule, fields: [...r.fields],
      actions: [...r.actions], modules: [...r.modules]
    },
    /* mock 里的人是用一次性链接进来的，没有口令 —— 于是也不会挂那条红条。
       要看红条长什么样，把 passwordIsInitial 改成 true。 */
    credentials: { hasPassword: false, passwordIsInitial: false }
  };
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
  http.get(pathToRegExp("/v1/me"), () => HttpResponse.json(me())),

  http.post(pathToRegExp("/v1/auth/dev-session"), () =>
    HttpResponse.json({ token: "mock-token", expiresAt: new Date(Date.now() + 8 * 3600e3).toISOString() })),

  /* 口令登录。**不能落到兜底处理器上** —— 那一层照契约回一份示例，
     于是"随便打个口令都能登进去"，而这个端点存在的全部意义就是拦住那件事。
     mock 里认一对：admin/admin（出厂管理员）。其余一律 401，
     且**三种失败一个说法** —— 和真后端一致，否则前端会照着 mock 的
     区分去写提示文案，上真库就对不上。 */
  http.post(pathToRegExp("/v1/auth/password-session"), async ({ request }) => {
    const b = await request.json() as { login: string; password: string };
    if (b.login === "admin" && b.password === "admin")
      return HttpResponse.json(
        { token: "mock-token", expiresAt: new Date(Date.now() + 8 * 3600e3).toISOString() });
    return HttpResponse.json(
      problem("unauthenticated", 401, "登录名或口令不对"), { status: 401 });
  }),

  /* ── 组织与权限 ────────────────────────────────────────────────
     这几个**必须有场景处理器**，不能落到兜底层。兜底层照契约回一份示例，
     于是这一页看起来能用、点什么都不生效 —— 建了账号列表不变、
     勾了权限矩阵不动。那比一张空页更难看出问题。 */
  http.get(pathToRegExp("/v1/accounts"), () =>
    HttpResponse.json({ items: scenario.accounts, nextCursor: null })),

  http.post(pathToRegExp("/v1/accounts"), async ({ request }) => {
    const b = await request.json() as {
      login: string; displayName: string; roleId: string;
      teamId?: string | null; orgRef?: string | null };
    if (scenario.accounts.some(a => a.login === b.login))
      return HttpResponse.json(
        problem("validation-failed", 422, `登录名 ${b.login} 已存在`), { status: 422 });
    const role = scenario.roles.find(r => r.id === b.roleId)!;
    const team = scenario.teams.find(t => t.id === b.teamId) ?? null;
    const acc = {
      id: `a-${b.login}`, login: b.login, displayName: b.displayName,
      role: { id: role.id, code: role.code, name: role.name, isExternal: role.isExternal },
      team: team ? { id: team.id, code: team.code, name: team.name } : null,
      isExternal: role.isExternal, orgRef: b.orgRef ?? null,
      status: "active" as const, joinedOn: todayStr(),
      disabledAt: null, disabledReason: null, lastLoginAt: null
    };
    scenario.accounts.push(acc);
    return HttpResponse.json(acc, { status: 201 });
  }),

  http.patch(pathToRegExp("/v1/accounts/{id}"), async ({ request }) => {
    const [, id] = new URL(request.url).pathname.match(/\/accounts\/([^/?]+)/) ?? [];
    const a = scenario.accounts.find(x => x.id === id);
    if (!a) return HttpResponse.json(problem("not-found", 404, "账号不存在"), { status: 404 });
    const b = await request.json() as {
      roleId?: string; teamId?: string | null; orgRef?: string | null };
    if (b.roleId) {
      const role = scenario.roles.find(r => r.id === b.roleId)!;
      a.role = { id: role.id, code: role.code, name: role.name, isExternal: role.isExternal };
      a.isExternal = role.isExternal;
      /* 和真后端同一条拦截：hospital 规则没有 orgRef，人登得进来一行都看不到 */
      if (role.rowRule === "hospital" && !(b.orgRef ?? a.orgRef))
        return HttpResponse.json(problem("invariant-violated", 422,
          "该角色按「本院承接的项目」切行，必须同时给出 orgRef，" +
          "否则这个账号登得进来却一行数据都看不到"), { status: 422 });
    }
    if (b.teamId !== undefined) {
      const team = scenario.teams.find(t => t.id === b.teamId) ?? null;
      a.team = team ? { id: team.id, code: team.code, name: team.name } : null;
    }
    if (b.orgRef !== undefined) a.orgRef = b.orgRef;
    return HttpResponse.json(a);
  }),

  http.post(pathToRegExp("/v1/accounts/{id}:disable"), async ({ request }) => {
    const [, id] = new URL(request.url).pathname.match(/\/accounts\/([^/:]+):disable/) ?? [];
    const a = scenario.accounts.find(x => x.id === id);
    if (!a) return HttpResponse.json(problem("not-found", 404, "账号不存在"), { status: 404 });
    const b = await request.json() as { reason: string };
    a.status = "disabled"; a.disabledAt = new Date().toISOString(); a.disabledReason = b.reason;
    return HttpResponse.json({ data: a, sideEffects: [
      { type: "AccountDisabled", summary: `${a.displayName} 已停用，历史记录与审计轨迹保留` }
    ] }, { status: 201 });
  }),

  http.post(pathToRegExp("/v1/accounts/{id}:enable"), async ({ request }) => {
    const [, id] = new URL(request.url).pathname.match(/\/accounts\/([^/:]+):enable/) ?? [];
    const a = scenario.accounts.find(x => x.id === id);
    if (!a) return HttpResponse.json(problem("not-found", 404, "账号不存在"), { status: 404 });
    a.status = "active"; a.disabledAt = null; a.disabledReason = null;
    return HttpResponse.json({ data: a, sideEffects: [
      { type: "AccountEnabled",
        summary: `${a.displayName} 已恢复登录 —— 停用时交接出去的中心不会自动回来` }
    ] }, { status: 201 });
  }),

  http.post(pathToRegExp("/v1/accounts/{id}:set-password"), () =>
    new HttpResponse(null, { status: 204 })),

  http.get(pathToRegExp("/v1/teams"), () =>
    HttpResponse.json({ items: scenario.teams.map(t => ({
      ...t,
      memberCount: scenario.accounts.filter(
        a => a.team?.id === t.id && a.status === "active").length
    })) })),

  http.post(pathToRegExp("/v1/teams"), async ({ request }) => {
    const b = await request.json() as
      { code: string; name: string; leadAccountId?: string | null };
    if (scenario.teams.some(t => t.code === b.code))
      return HttpResponse.json(
        problem("validation-failed", 422, `分组代号 ${b.code} 已存在`), { status: 422 });
    const lead = scenario.accounts.find(a => a.id === b.leadAccountId);
    const t = {
      id: `t-${b.code}`, code: b.code, name: b.name,
      lead: lead ? { id: lead.id, displayName: lead.displayName } : null,
      memberCount: 0, studyCount: 0
    };
    scenario.teams.push(t);
    return HttpResponse.json(t, { status: 201 });
  }),

  http.get(pathToRegExp("/v1/roles"), () => HttpResponse.json({ items: scenario.roles })),

  http.patch(pathToRegExp("/v1/roles/{id}"), async ({ request }) => {
    const [, id] = new URL(request.url).pathname.match(/\/roles\/([^/?]+)/) ?? [];
    const r = scenario.roles.find(x => x.id === id);
    if (!r) return HttpResponse.json(problem("not-found", 404, "角色不存在"), { status: 404 });
    const b = await request.json() as {
      rowRule?: string; visibleFields?: string[];
      allowedActions?: string[]; modules?: string[] };
    if (b.rowRule) r.rowRule = b.rowRule;
    if (b.visibleFields) r.visibleFields = b.visibleFields;
    if (b.allowedActions) r.allowedActions = b.allowedActions;
    if (b.modules) r.modules = b.modules;
    return HttpResponse.json(r);
  }),

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

  /* 详情页取的是**这一条**。放在列表处理器后面没关系：
     pathToRegExp 结尾锚了 `(\?|$)`，`/v1/subject-visits` 那条匹配不到带 id 的路径。 */
  http.get(pathToRegExp("/v1/subject-visits/{id}"), ({ request }) => {
    const [, id] = new URL(request.url).pathname.match(/\/subject-visits\/([^/?]+)/) ?? [];
    const v = scenario.visits.find(x => x.id === id);
    if (!v) return HttpResponse.json(problem("not-found", 404, "访视不存在"), { status: 404 });
    return HttpResponse.json(withDaysLeft(v));
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

    /* PostVisitTimesheet：完成访视自动生成一条工时，标记 autoGenerated。
       它和手工填报走同一个数据形状 —— 台账上看得见它是自动来的，
       也照样能作废（访视填错了，成本得能退回来）。 */
    const tsId = `ts-${Date.now().toString(36)}`;
    const site = SITES_LIST.find(x => x.code === v.siteCode)!;
    scenario.timesheets.unshift(mkTimesheet(
      tsId, site, b.actualDate, "visit_support", b.hours,
      /* note 与服务端逐字一致 —— 差一个字，界面在 mock 上和真库上就不一样 */
      { auto: true, note: "由完成访视自动生成" }));
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

    /* pending 现在是空的：七个订阅者全接上了。
       这个字段**没有删** —— 下一个"暂时接不上"的订阅者出现时，
       界面上那块地方还在，不用重新长一遍。 */
    return HttpResponse.json({
      data: withDaysLeft(v), sideEffects: effects, pending: []
    }, { status: 201 });
  }),

  /* ── SAE 台账与 24 小时及时率（I6） ────────────────────────────
     及时率**在 mock 里也由 @sitedesk/calc 算**，不写一个好看的常数：
     那正是这条不变量当初被违反的方式。 */
  http.get(pathToRegExp("/v1/study-sites/{id}/sae"), ({ request }) => {
    const id = seg(request.url, /\/study-sites\/([^/]+)\/sae/);
    const rows = scenario.qualityEvents.filter(
      q => q.kind === "sae" && q.studySiteId === id);
    const now = new Date();
    const t = saeTimeliness(
      rows.map(r => ({ occurredAt: r.occurredAt!, reportedAt: r.reportedAt ?? null })), now);
    return HttpResponse.json({
      items: rows.map(r => ({
        ...r,
        reportHours: saeReportHours({
          occurredAt: r.occurredAt!, reportedAt: r.reportedAt ?? null })
      })),
      nextCursor: null,
      timeliness: { ...t, calcVersion: CALC_VERSION }
    });
  }),

  http.get(pathToRegExp("/v1/study-sites/{id}/ip-movements"), ({ request }) => {
    const id = seg(request.url, /\/study-sites\/([^/]+)\/ip-movements/);
    const items = scenario.ipMovements.filter(m => m.studySiteId === id);
    /* 与后端 app.ip_balance() 同一条口径：收进来的加，发出去的减。
       **算出来的，不存** —— mock 里存一个 balance，界面就会在两种数据源下
       显示两个数，而那种差别正是集成测试之外没人会发现的。 */
    const balance = items.reduce(
      (n, m) => n + (["receipt", "return"].includes(m.kind) ? m.quantity : -m.quantity), 0);
    return HttpResponse.json({
      items, nextCursor: null, balance, blocksClose: balance !== 0
    });
  }),

  http.get(pathToRegExp("/v1/quality-events"), () =>
    HttpResponse.json({ items: scenario.qualityEvents, nextCursor: null })),

  http.get(pathToRegExp("/v1/study-sites"), ({ request }) => {
    const only = new URL(request.url).searchParams.get("startupInvalidated");
    const items = SITES_LIST.map(s => siteDto(s.id)!)
      .filter(s => only === null || s.startupInvalidated === (only === "true"));
    return HttpResponse.json({ items, nextCursor: null });
  }),

  /* ── 中心详情 · 闸门 · 推进 ─────────────────────────────────────
     具体路径排在 `/v1/study-sites/{id}` 前面。
     严格说不排也行 —— `[^/]+(\?|$)` 里的 `[^/]+` 跨不过斜杠，
     所以 `/v1/study-sites/s3/gate` 匹配不上那条通配。
     但顺序是**一眼能看出来**的，那条推理不是；
     哪天路径正则改一个字符，靠推理成立的那一版会静默走错分支。 */
  http.get(pathToRegExp("/v1/study-sites/{id}/gate"), ({ request }) => {
    const id = seg(request.url, /\/study-sites\/([^/]+)\/gate/);
    const g = gateFor(id);
    if (!g) return HttpResponse.json(
      problem("validation-failed", 422, "已是状态机的最后一个节点"), { status: 422 });
    return HttpResponse.json(g);
  }),

  http.get(pathToRegExp("/v1/study-sites/{id}/startup-items"), ({ request }) => {
    const id = seg(request.url, /\/study-sites\/([^/]+)\/startup-items/);
    return HttpResponse.json(checklistFor(id));
  }),

  http.post(pathToRegExp("/v1/study-sites/{id}:advance"), async ({ request }) => {
    const id = seg(request.url, /\/study-sites\/([^/:]+):advance/);
    const b = await request.json() as { to: string; reason?: string };
    const g = gateFor(id);
    if (!g || g.to !== b.to) return HttpResponse.json(
      problem("validation-failed", 422, "只能推进到状态机的下一节点"), { status: 422 });
    if (!g.satisfied) return HttpResponse.json(
      { ...problem("gate-not-satisfied", 422,
          `不能推进到「${b.to}」：还有 ${g.unmet.length} 项前置条件未满足`),
        unmet: g.unmet }, { status: 422 });
    /* 与策略层同一条规则：推进是敏感动作，**每一次**都要写原因。
       mock 上放行一次真库会拒绝的提交，等于把这条规则藏到集成测试才暴露。 */
    if (!b.reason || b.reason.trim().length < 4) return HttpResponse.json(
      { ...problem("validation-failed", 422,
          "「推进中心阶段」是敏感动作，必须写明变更原因（至少 4 字）"),
        issues: [{ path: "/body/reason", message: "必填，至少 4 字" }] }, { status: 422 });

    const from = scenario.siteState[id]!;
    scenario.siteState[id] = b.to;
    /* 真库上推进到 siv 会回填 siv_on，界面上的"实际 SIV"随之有值。
       mock 不跟着做的话，同一个页面在两种数据源下长得不一样，
       而那种差别正是集成测试之外没人会发现的。 */
    if (b.to === "siv") scenario.sivOn[id] = todayStr();
    if (b.to === "enrolling") scenario.fpiOn[id] = todayStr();
    return HttpResponse.json({
      data: siteDto(id),
      sideEffects: [{ type: "SiteStateChanged", ref: id, studySiteId: id,
        summary: `${siteDto(id)!.hospital} 状态由「${from}」推进至「${b.to}」` }]
    }, { status: 201 });
  }),

  http.get(pathToRegExp("/v1/study-sites/{id}"), ({ request }) => {
    const id = seg(request.url, /\/study-sites\/([^/?]+)/);
    const dto = siteDto(id);
    return dto ? HttpResponse.json(dto)
      : HttpResponse.json(problem("not-found", 404, "中心不存在"), { status: 404 });
  }),

  /* ── 启动清单项 ──────────────────────────────────────────────── */
  http.post(pathToRegExp("/v1/startup-items/{id}:complete"), ({ request }) => {
    const id = seg(request.url, /\/startup-items\/([^/:]+):complete/);
    const it = scenario.startupItems.find(x => x.id === id);
    if (!it) return HttpResponse.json(
      problem("not-found", 404, "启动清单项不存在"), { status: 404 });
    if (it.doneAt) return HttpResponse.json(
      problem("conflict-version", 409, `「${it.item}」已被标记完成`), { status: 409 });
    it.doneAt = new Date().toISOString(); it.doneByName = "吴桐"; it.overdueDays = null;

    const blocked = scenario.startupItems.filter(
      x => x.studySiteId === it.studySiteId && x.isBlocking && !x.doneAt).length;
    return HttpResponse.json({
      data: it,
      sideEffects: it.isBlocking && blocked === 0
        ? [{ type: "SiteStateChanged", ref: it.studySiteId, studySiteId: it.studySiteId,
             summary: "最后一个启动阻塞项已清零 —— 该中心现在可以推进到「SIV启动」" }]
        : []
    }, { status: 201 });
  }),

  http.post(pathToRegExp("/v1/startup-items/{id}:reopen"), ({ request }) => {
    const id = seg(request.url, /\/startup-items\/([^/:]+):reopen/);
    const it = scenario.startupItems.find(x => x.id === id);
    if (!it?.doneAt) return HttpResponse.json(
      problem("conflict-version", 409, "该项本来就未完成"), { status: 409 });
    it.doneAt = null; it.doneByName = null;
    /* 撤销一个阻塞项，且中心已经过了 SIV —— 后端会警告"当初的启动条件
       现在不成立"，mock 不跟着做的话，这条提示只有集成测试见得到。 */
    const site = siteDto(it.studySiteId);
    const sideEffects = it.isBlocking && site?.startupInvalidated
      ? [{ type: "SiteStateChanged", ref: it.studySiteId, studySiteId: it.studySiteId,
           summary: `注意：${site.code} 已处于「${site.state}」，` +
             "但一个启动阻塞项被撤回 —— 该中心当初的启动条件现在不成立" }]
      : [];
    return HttpResponse.json({ data: it, sideEffects }, { status: 201 });
  }),

  /* ── 工时 · 费率卡 · 损益 ────────────────────────────────────── */
  http.get(pathToRegExp("/v1/timesheets"), ({ request }) => {
    const q = new URL(request.url).searchParams;
    const items = scenario.timesheets
      .filter(t => q.get("includeVoided") === "true" || !t.voidedAt)
      /* 已作废的不该出现在待审里 —— 它已经不在成本里了 */
      .filter(t => q.get("unapprovedOnly") !== "true" || (!t.approvedAt && !t.voidedAt))
      .map(stripCost);
    return HttpResponse.json({ items, nextCursor: null });
  }),

  http.post(pathToRegExp("/v1/timesheets"), async ({ request }) => {
    const b = await request.json() as {
      studySiteId: string; workDate: string; workType: string;
      hours: number; travelCents?: number; note?: string };
    const site = SITES_LIST.find(s => s.id === b.studySiteId);
    if (!site) return HttpResponse.json(
      problem("not-found", 404, "中心不存在"), { status: 404 });
    /* 与后端同一条不变量：不能给未来的日期填报 */
    if (b.workDate > todayStr()) return HttpResponse.json(
      { ...problem("invariant-violated", 422, "不能给未来的日期填报工时"),
        invariant: "timesheet-not-future" }, { status: 422 });
    if (!WORK_TYPE_META[b.workType]) return HttpResponse.json(
      problem("not-found", 404, "工作类型不存在"), { status: 404 });

    const t = mkTimesheet(`ts-${Date.now().toString(36)}`, site,
      b.workDate, b.workType, b.hours,
      { travel: b.travelCents ?? 0, ...(b.note ? { note: b.note } : {}) });
    scenario.timesheets.unshift(t);
    return HttpResponse.json(stripCost(t), { status: 201 });
  }),

  http.post(pathToRegExp("/v1/timesheets/{id}:approve"), ({ request }) => {
    const id = seg(request.url, /\/timesheets\/([^/:]+):approve/);
    const t = scenario.timesheets.find(x => x.id === id);
    if (!t) return HttpResponse.json(
      problem("not-found", 404, "工时不存在"), { status: 404 });
    if (t.voidedAt) return HttpResponse.json(
      { ...problem("invariant-violated", 422,
          "这条工时已作废 —— 它已经不在成本里了，不需要审"),
        invariant: "timesheet-voided-needs-no-approval" }, { status: 422 });
    if (t.approvedAt) return HttpResponse.json(
      problem("conflict-version", 409, "这条工时已经审过"), { status: 409 });
    /* 不能审自己填的 —— 这条是**契约声明的 invariant**，
       前端要能在 mock 上就看到它长什么样。 */
    if (t.accountId === me().account.id) return HttpResponse.json(
      { ...problem("invariant-violated", 422,
          "不能审自己填的工时 —— 审批的全部价值在于第二个人看过"),
        invariant: "timesheet-no-self-approve" }, { status: 422 });

    t.approvedAt = new Date().toISOString();
    t.approvedByName = me().account.displayName;
    return HttpResponse.json({
      data: stripCost(t),
      sideEffects: [{ type: "TimesheetApproved", ref: t.id, studySiteId: t.studySiteId,
        summary: `${t.personName} ${t.workDate} 的 ${t.hours} 小时已审 —— ` +
          "**成本没有变化**：审批只是说这一笔被第二个人看过了" }]
    }, { status: 201 });
  }),

  http.post(pathToRegExp("/v1/timesheets/{id}:void"), async ({ request }) => {
    const id = seg(request.url, /\/timesheets\/([^/:]+):void/);
    const b = await request.json() as { reason: string };
    const t = scenario.timesheets.find(x => x.id === id);
    if (!t) return HttpResponse.json(
      problem("not-found", 404, "工时不存在"), { status: 404 });
    if (t.voidedAt) return HttpResponse.json(
      { ...problem("invariant-violated", 422, "该工时已作废"),
        invariant: "timesheet-already-voided" }, { status: 422 });
    t.voidedAt = new Date().toISOString();
    t.voidedByName = me().account.displayName;
    t.voidReason = b.reason;
    return HttpResponse.json({
      data: stripCost(t),
      /* 文案与服务端逐字一致 —— 界面就是照着这句话渲染的 */
      sideEffects: [{ type: "CostPosted", ref: t.id,
        summary: `成本已冲回 ${(t.costCents / 100).toFixed(2)} 元 —— ` +
          "工时不删除，只作废；报表不会因此和昨天不一样" }]
    }, { status: 201 });
  }),

  http.get(pathToRegExp("/v1/rate-cards"), () =>
    HttpResponse.json({
      items: scenario.rateCards.map(mask),
      nextCursor: null
    })),

  http.post(pathToRegExp("/v1/rate-cards"), async ({ request }) => {
    const b = await request.json() as {
      roleKind: string; level?: string | null; dayCostCents: number;
      validFrom: string; validTo?: string | null; note?: string };
    /* 区间重叠在真库上由 EXCLUDE 约束直接拒绝。mock 也拦一次 ——
       不拦的话，「调价是两步」这条规则只有到了真库才第一次被强制。 */
    const clash = scenario.rateCards.find(c =>
      c.roleKind === b.roleKind && (c.level ?? null) === (b.level ?? null) &&
      (c.validTo === null || c.validTo >= b.validFrom));
    if (clash) return HttpResponse.json(
      { ...problem("invariant-violated", 422,
          `与 ${clash.validFrom} ~ ${clash.validTo ?? "至今"} 那张卡的生效区间重叠 ——` +
          `请先给它收口，再从次日开新卡`),
        invariant: "rate-card-overlap" }, { status: 422 });

    const card: MockRateCard = {
      id: `rc-${Date.now().toString(36)}`, roleKind: b.roleKind,
      level: b.level ?? null, dayCostCents: b.dayCostCents,
      validFrom: b.validFrom, validTo: b.validTo ?? null, note: b.note ?? null
    };
    scenario.rateCards.unshift(card);
    return HttpResponse.json(mask(card), { status: 201 });
  }),

  http.post(pathToRegExp("/v1/rate-cards/{id}:close"), async ({ request }) => {
    const id = seg(request.url, /\/rate-cards\/([^/:]+):close/);
    const b = await request.json() as { validTo: string };
    const c = scenario.rateCards.find(x => x.id === id);
    if (!c) return HttpResponse.json(
      problem("not-found", 404, "费率卡不存在"), { status: 404 });
    if (b.validTo < c.validFrom) return HttpResponse.json(
      { ...problem("invariant-violated", 422, "收口日不能早于生效起始日"),
        invariant: "rate-card-close-before-start" }, { status: 422 });
    c.validTo = b.validTo;
    /* **服务端这里返回空数组**，mock 不许自己发明一条。
       发明出来的副作用会让界面长出一个真库上不存在的反馈，
       测试还会照着它写断言 —— 于是 mock 绿、真库红。
       收口的反馈来自数据本身：那一行的生效区间不再是「至今」。 */
    return HttpResponse.json({ data: mask(c), sideEffects: [] }, { status: 201 });
  }),

  /* 分月要排在通配的 `/pnl` 前面：`[^/]+` 跨不过斜杠，所以严格说
     不排也匹配不上，但顺序是一眼能看出来的，那条推理不是。 */
  http.get(pathToRegExp("/v1/study-sites/{id}/pnl/monthly"), ({ request }) => {
    const id = seg(request.url, /\/study-sites\/([^/]+)\/pnl\/monthly/);
    const dto = siteDto(id);
    if (!dto) return HttpResponse.json(
      problem("not-found", 404, "中心不存在"), { status: 404 });
    const n = Number(new URL(request.url).searchParams.get("months") ?? 12);
    return HttpResponse.json(trendFor(id, dto, n));
  }),

  http.get(pathToRegExp("/v1/study-sites/{id}/pnl"), ({ request }) => {
    const id = seg(request.url, /\/study-sites\/([^/]+)\/pnl/);
    const dto = siteDto(id);
    if (!dto) return HttpResponse.json(
      problem("not-found", 404, "中心不存在"), { status: 404 });
    return HttpResponse.json(pnlFor(id, dto));
  }),

  /* ── 人员与交接 ──────────────────────────────────────────────── */
  http.get(pathToRegExp("/v1/staff"), () =>
    HttpResponse.json({ items: STAFF_LIST, nextCursor: null })),

  http.get(pathToRegExp("/v1/handovers"), () =>
    HttpResponse.json({ items: scenario.handovers.map(handoverDto), nextCursor: null })),

  http.post(pathToRegExp("/v1/handovers"), async ({ request }) => {
    const b = await request.json() as {
      toAccountId: string; studySiteIds: string[]; reason: string; plannedOn: string };
    const to = STAFF_LIST.find(s => s.accountId === b.toAccountId);
    const mine = STAFF_LIST.find(s => s.accountId === me().account.id);
    /* 同工种校验放在 mock 里，是因为它是**契约声明的 invariant**，
       不是后端的实现细节：前端要能在 mock 上就看到这条错误长什么样。 */
    if (!to) return HttpResponse.json(
      problem("validation-failed", 422, "接手人不存在或已停用"), { status: 422 });
    if (mine && to.roleKind !== mine.roleKind) return HttpResponse.json(
      { ...problem("invariant-violated", 422,
          `接手人是 ${to.roleKind}，与你的工种 ${mine.roleKind} 不同 —— CRA 与 CRC 不能互相顶替`),
        invariant: "handover-same-role-kind" }, { status: 422 });

    const h: MockHandover = {
      id: `h-${scenario.handovers.length + 1}`,
      fromAccountId: me().account.id, fromName: me().account.displayName,
      toAccountId: to.accountId, toName: to.displayName,
      reason: b.reason, plannedOn: b.plannedOn, status: "pending", completedAt: null,
      sites: b.studySiteIds.map(id => {
        const s = SITES_LIST.find(x => x.id === id)!;
        return { id, code: s.code, hospital: s.hospital };
      }),
      items: DEFAULT_HANDOVER_ITEMS.map((item, seq) => ({
        seq, item, doneAt: null, doneByName: null }))
    };
    scenario.handovers.unshift(h);
    return HttpResponse.json(handoverDto(h), { status: 201 });
  }),

  http.post(pathToRegExp("/v1/handovers/{id}/items/{seq}:done"), ({ request }) => {
    const m = new URL(request.url).pathname
      .match(/\/handovers\/([^/]+)\/items\/([^/:]+):done/);
    const h = scenario.handovers.find(x => x.id === m?.[1]);
    const it = h?.items.find(x => x.seq === Number(m?.[2]));
    if (!h || !it || it.doneAt) return HttpResponse.json(
      problem("not-found", 404, "交接清单项不存在或已确认"), { status: 404 });
    it.doneAt = new Date().toISOString(); it.doneByName = "吴桐";
    const open = h.items.filter(x => !x.doneAt).length;
    return HttpResponse.json({
      data: handoverDto(h),
      sideEffects: open === 0
        ? [{ type: "SiteStateChanged", ref: h.id,
             summary: `${h.items.length} 项清单已全部确认 —— 现在可以完成这笔交接` }]
        : []
    }, { status: 201 });
  }),

  http.post(pathToRegExp("/v1/handovers/{id}:complete"), ({ request }) => {
    const id = seg(request.url, /\/handovers\/([^/:]+):complete/);
    const h = scenario.handovers.find(x => x.id === id);
    if (!h) return HttpResponse.json(
      problem("not-found", 404, "交接单不存在"), { status: 404 });
    const open = h.items.filter(i => !i.doneAt);
    if (open.length) return HttpResponse.json({
      ...problem("gate-not-satisfied", 422, `交接清单还有 ${open.length} 项未确认`),
      unmet: open.map(i => ({
        code: "handover-item-open", message: i.item, module: "handover" }))
    }, { status: 422 });
    h.status = "completed"; h.completedAt = new Date().toISOString();
    /* 真库上这一步会把派工从原负责人转到接手人，双方的行范围当场改变；
       转不动一个中心时整笔交接会回滚（invariant handover-must-move-assignments）。
       mock 不模拟派工表，但**副作用的文案必须一致** ——
       前端就是照着这句话渲染的，两边不一样等于 mock 在演一个别的系统。 */
    return HttpResponse.json({
      data: handoverDto(h),
      sideEffects: h.sites.map(s => ({
        type: "SiteStateChanged",
        summary: `${s.code} 的派工已由 ${h.fromName} 转至 ${h.toName} —— 双方的可见范围随即改变`
      }))
    }, { status: 201 });
  })
];

/** 从 URL 里抠出一段路径参数。正则各处不同，所以由调用方传进来。 */
function seg(url: string, re: RegExp): string {
  return new URL(url).pathname.match(re)?.[1] ?? "";
}

/** 状态机顺序取自契约，不在 mock 里另立一份。 */
const nextState = (cur: string) => SITE_STATES[SITE_STATES.indexOf(cur as never) + 1] ?? null;

function siteDto(id: string) {
  const s = SITES_LIST.find(x => x.id === id);
  if (!s) return null;
  return {
    id: s.id, code: s.code,
    study: { id: "st1", code: "HJ-2024-017", shortName: "艾瑞替尼 III" },
    hospital: s.hospital, dept: "肝胆外科", city: "北京",
    piName: "陈国栋", piAccountId: null,
    state: scenario.siteState[s.id] ?? s.state, contracted: 30,
    irbApprovedOn: "2024-10-18",
    sivOn: scenario.sivOn[s.id] ?? null,
    /* 有启动清单的那个中心才排了 SIV —— 清单项的到期日就是相对它算的。
       不要按 state 判断：推进之后 state 就变了，而计划日不会因此消失。 */
    sivPlannedOn: scenario.startupItems.some(i => i.studySiteId === s.id)
      ? scenario.sivPlannedOn : null,
    fpiOn: scenario.fpiOn[s.id] ?? null,
    /* 与后端 INVALIDATED 同一条判定式：已过 SIV，却还挂着未完成的阻塞项。
       mock 里也**算出来**而不是写死 —— 撤销一个阻塞项之后，
       这一栏要立刻跟着变，否则界面在两种数据源下长得不一样。 */
    startupInvalidated: PAST_SIV.includes(scenario.siteState[s.id] ?? s.state)
      && scenario.startupItems.some(
        i => i.studySiteId === s.id && i.isBlocking && !i.doneAt),
    ...(mockRole === "boss"
      ? { unitPriceCents: 5800000, startupFeeCents: 17600000 } : {})
  };
}

/** 「已经启动过了」的那几个状态 —— 与后端 site.service.ts 的 INVALIDATED 同源。 */
const PAST_SIV = ["siv", "enrolling", "enrolled", "followup", "closed"];

function checklistFor(siteId: string) {
  const items = scenario.startupItems.filter(i => i.studySiteId === siteId);
  const s = SITES_LIST.find(x => x.id === siteId);
  return {
    studySiteId: siteId, siteCode: s?.code ?? "", hospital: s?.hospital ?? "",
    state: scenario.siteState[siteId] ?? s?.state ?? "",
    sivPlannedOn: scenario.sivPlannedOn,
    daysToSiv: Math.round(
      (new Date(scenario.sivPlannedOn).getTime() - new Date(todayStr()).getTime())
      / 86_400_000),
    total: items.length,
    done: items.filter(i => i.doneAt).length,
    blockingOpen: items.filter(i => i.isBlocking && !i.doneAt).length,
    overdue: items.filter(i => i.overdueDays !== null).length,
    items
  };
}

/** 闸门：只有推进到 siv 才有检查项，与后端 REGISTRY 一致。 */
function gateFor(siteId: string) {
  const from = scenario.siteState[siteId];
  if (!from) return null;
  const to = nextState(from);
  if (!to) return null;
  if (to !== "siv") return { from, to, satisfied: true, unmet: [] };

  const open = scenario.startupItems.filter(
    i => i.studySiteId === siteId && i.isBlocking && !i.doneAt);
  return open.length === 0
    ? { from, to, satisfied: true, unmet: [] }
    : { from, to, satisfied: false, unmet: [{
        code: "startup-blockers", module: "startup",
        message: `启动清单仍有 ${open.length} 项阻塞未完成：` +
          open.slice(0, 5).map(i => i.item).join("；") + (open.length > 5 ? " 等" : "")
      }] };
}

/** 按**契约声明的列权限**删字段 —— 与服务端 MaskInterceptor 同一条路径：
 *  `fieldGates()`（契约派生）+ `maskFields()`（policy 的纯函数）。
 *
 *  自己手抄一份"哪些字段该删"的清单是行不通的：契约里加一个 gated 字段，
 *  mock 不会跟着变，于是它在 mock 上照常显示、到真库上才消失。
 *
 *  语义也要一致：`maskFields` 是**按叶子键名递归删除**，
 *  所以 `revenue` 那一块会变成 `{}` 而不是整块消失 ——
 *  界面据此判断"有没有这一块"，两边差一点都会露馅。 */
const GATES = fieldGates();
const mask = <T,>(v: T): T =>
  maskFields({ active: true, fields: ROLE[mockRole].fields }, GATES, v);

/** 成本三件套受 cost 列权限管辖 —— 一线填工时，但看不到自己值多少钱。 */
const stripCost = (t: MockTimesheet) => mask(t);

/** 单中心损益。
 *
 *  **算式来自 `@sitedesk/calc`，mock 不另写一份。**
 *  前端 mock 里手搓一遍 I8'，等于给这个系统开了第三套口径
 *  （服务端一套、calc 一套、mock 一套），而三套迟早分叉。
 *  分叉那天，界面在 mock 上是对的、在真库上是错的，最难查。 */
function pnlFor(siteId: string, dto: NonNullable<ReturnType<typeof siteDto>>) {
  const enrolled = scenario.visits.filter(v => v.studySiteId === siteId).length;
  /* 场景里没有筛败与脱落的建模，给两个固定值 —— 但**四项一项不少地算**，
     这样"少了哪一项"在界面上仍然看得出来。 */
  const revenue = siteRevenue({
    startupFeeCents: 17600000, unitPriceCents: 5800000,
    enrolled, screenFailed: 1, screenFailFeeRate: 0.3,
    dropouts: [{ visitsDone: 2, visitsPlanned: 8 }]
  });
  const entries: CostEntry[] = scenario.timesheets
    .filter(t => t.studySiteId === siteId)
    .map(t => ({ costCents: t.costCents, billable: t.billable,
      hours: t.hours, voided: !!t.voidedAt }));
  const cost = siteCost(entries, 0.18);
  const margin = siteMargin(revenue.total, cost.totalCents, enrolled);

  return mask({
    studySiteId: siteId, siteCode: dto.code, hospital: dto.hospital,
    state: scenario.siteState[siteId] ?? "",
    enrolled, screenFailed: 1, withdrawn: 1, contracted: dto.contracted,
    revenue: {
      startupCents: revenue.startup,
      enrollmentCents: revenue.enrollment,
      dropoutDeductionCents: revenue.dropoutDeduction,
      screenFailFeeCents: revenue.screenFailFee,
      revenueCents: revenue.total
    },
    cost: {
      directCostCents: cost.directCents,
      billableCostCents: cost.billableCents,
      nonBillableCostCents: cost.nonBillableCents,
      overheadCents: cost.overheadCents,
      totalCostCents: cost.totalCents,
      /* 待审的那一部分**已经在合计里了**（D4）：这一栏只说
         "其中有多少还没被第二个人看过"。 */
      unapprovedCostCents: scenario.timesheets
        .filter(t => t.studySiteId === siteId && !t.voidedAt && !t.approvedAt)
        .reduce((n, t) => n + t.costCents, 0),
      personDays: cost.personDays,
      /* 「没有分母」时省略，与"无权限时消失"用同一种表达 ——
         客户端只需要处理"它不在"这一种情况。 */
      ...(cost.nonBillableShare !== null
        ? { nonBillableShare: cost.nonBillableShare } : {}),
      ...(margin.costPerEnrolledCents !== null
        ? { costPerEnrolledCents: margin.costPerEnrolledCents } : {})
    },
    grossProfitCents: margin.grossProfitCents,
    ...(margin.grossMargin !== null ? { grossMargin: margin.grossMargin } : {}),
    calcVersion: CALC_VERSION
  });
}

const handoverDto = (h: MockHandover) => ({
  ...h,
  doneCount: h.items.filter(i => i.doneAt).length,
  totalCount: h.items.length
});

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

/** 分月损益的 mock。**要有一个亏钱的月份** ——
 *  负毛利是这一页最该被看见的东西，而只摆赚钱的月份，
 *  那根往左长的柱子就永远画不出来，也就没人会发现它其实没写对。 */
function trendFor(id: string, dto: { code: string; hospital: string }, months: number) {
  const now = new Date();
  const axis: string[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    axis.push(d.toISOString().slice(0, 7));
  }
  /* 一条编出来但形状真实的曲线：启动那两个月成本先出去、收入还没进来
     （负毛利），入组起来之后转正。 */
  const shape = [
    { enrolled: 0, rev: 0,        cost: 4_20_000 },
    { enrolled: 0, rev: 17_60_000, cost: 9_80_000 },
    { enrolled: 2, rev: 11_60_000, cost: 8_40_000 },
    { enrolled: 3, rev: 17_40_000, cost: 9_20_000 },
    { enrolled: 1, rev: 5_80_000,  cost: 7_60_000 },
    { enrolled: 4, rev: 23_20_000, cost: 10_40_000 }
  ];
  return {
    studySiteId: id, siteCode: dto.code, hospital: dto.hospital,
    months: axis.map((month, i) => {
      const k = shape[i % shape.length]!;
      const base = {
        month, enrolled: k.enrolled, screenFailed: 0, withdrawn: 0
      };
      /* 与真实后端同一套列权限：一线看得到例数，看不到钱 */
      return mockRole === "boss" ? {
        ...base, revenueCents: k.rev, costCents: k.cost,
        personDays: k.cost / 2_11_200,
        grossProfitCents: k.rev - k.cost
      } : base;
    }),
    calcVersion: CALC_VERSION
  };
}
