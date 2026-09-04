import { http, HttpResponse } from "msw";
import { allEndpoints, SITE_STATES, DEFAULT_HANDOVER_ITEMS } from "@sitedesk/contracts";
import { feasibilityScore, feasibilityBias, reviewBids, scopeCreep, changeDays,
  arAging, cashFlow, roundCents, WORKDAYS_PER_MONTH, DAYS_PER_MONTH, type CashIn }
  from "@sitedesk/calc";
import { siteRevenue, siteCost, siteMargin, CALC_VERSION,
  saeTimeliness, saeReportHours, type CostEntry } from "@sitedesk/calc";
import { queryLoad, siteQueryDensity, densityVerdict, QUERY_STALE_DAYS }
  from "@sitedesk/calc";
import { monitorPlan, monitorDue, mvrLoad, mvrLagDays, travelEstimateCents, MVR_DUE_DAYS }
  from "@sitedesk/calc";
import { gradeSite, capaEffectiveness } from "@sitedesk/calc";
import { intakeMath, filingGap, INTAKE_GM_GATE } from "@sitedesk/calc";
import { isfVerdict, isfSummary, isfRank, type IsfCategory } from "@sitedesk/calc";
import { fieldGates } from "@sitedesk/contracts";
import { maskFields } from "@sitedesk/policy";
import examples from "@sitedesk/contracts/mocks/examples.json";
import { IDENTITIES, type MockRole } from "./roles.js";
import type { MockFeas, MockBid, MockChange, MockMilestone, MockQuery,
  MockMonitorVisit, MockAudit, MockIntake,
  MockAcceptance, MockIsf } from "./scenario.js";
import { CLIENTS } from "./scenario.js";
import { makeScenario, SITES_LIST, STAFF_LIST, SITE_STAFF, FUNNELS, AUDIT_ENTRIES,
  mkTimesheet, WORK_TYPE_META,
  type MockSubject, type MockPayment,
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
export const resetScenario = () => {
  scenario = makeScenario();
  /* 建档出来的中心也要清掉 —— 它们不在 scenario 里，在 SITES_LIST 上。 */
  SITES_LIST.length = SEED_SITES;
};
export const currentScenario = () => scenario;

/** mock 身份。切换它可以看到「同一个接口，不同的人看到不同的列、
 *  以及同一个按钮，不同的人点不点得动」。
 *  由 URL 上的 `?as=boss` 驱动（见 main.tsx），所以 e2e 里换个人只要换个地址。
 *
 *  四个身份的目录在 `mocks/roles.ts`，与迁移 0026 逐字同源。 */
let mockRole: MockRole = "crc";
export const setMockRole = (r: MockRole) => { mockRole = r; };
const identity = () => IDENTITIES[mockRole];

/** mock 的行范围。
 *
 *  **只对 hospital 与 pi 两条规则生效。** assigned（CRC / CRA）在这里
 *  演不出来：mock 没有 site_assignment 那张表，而硬编一份"吴桐带哪几个"
 *  会凭空立起第四套口径。所以内部身份照旧看到全部三个中心 ——
 *  这一点写在这里，免得有人把它当成"mock 里 RLS 是通的"。
 *
 *  外部两条必须是真的：机构工作台与研究者工作台**整页的内容就是"看得窄"**，
 *  看不窄，那两页画得出来也说不出话。 */
function visibleSiteIds(): Set<string> {
  const me = identity();
  const keep =
    me.rowRule === "hospital" ? SITES_LIST.filter(s => s.hospital === me.orgRef)
    : me.rowRule === "pi"     ? SITES_LIST.filter(s => s.piAccountId === me.id)
    : SITES_LIST;
  return new Set(keep.map(s => s.id));
}
const siteInScope = (id: string) => visibleSiteIds().has(id);
/** 范围内的中心本身。**不要拿 inScope() 去筛它们** ——
 *  中心行上那两个键叫 `id` / `code`，不叫 `studySiteId` / `siteCode`，
 *  于是 inScope 会走到"两个键都没有，原样放行"那一支，
 *  一行都不筛而且不报错。 */
function visibleSites() {
  const ids = visibleSiteIds();
  return SITES_LIST.filter(s => ids.has(s.id));
}
/** 按中心代号收敛一批行 —— 范围外的**不是空值，是不存在**。 */
function inScope<T extends { studySiteId?: string; siteCode?: string }>(xs: T[]): T[] {
  const ids = visibleSiteIds();
  const codes = new Set(SITES_LIST.filter(s => ids.has(s.id)).map(s => s.code));
  return xs.filter(x =>
    x.studySiteId !== undefined ? ids.has(x.studySiteId)
    : x.siteCode !== undefined  ? codes.has(x.siteCode)
    : true);
}


/** 看得见的数据质疑。**外部方一条都没有** ——
 *  行策略上就关掉了（迁移 0032），不是靠"没有这个模块"挡着。 */
function visibleQueries() {
  if (identity().isExternal) return [];
  return inScope(scenario.dataQueries);
}

/** 按 id 取一条质疑，顺带把"范围外 = 不存在"这条统一掉。 */
function findQuery(url: string, re: RegExp):
  { q: MockQuery } | { problem: Response } {
  const id = seg(url, re);
  const q = visibleQueries().find(x => x.id === id);
  return q ? { q } : { problem: HttpResponse.json(
    problem("not-found", 404, "数据质疑不存在"), { status: 404 }) };
}

/** 不变量被破坏时的那个 422。**invariant 名字要带上** ——
 *  界面靠它区分"缺材料"和"存根只读"，靠 detail 文案区分是做不到的。 */
function invariant(name: string, detail: string) {
  return HttpResponse.json(
    { ...problem("invariant-violated", 422, detail), invariant: name },
    { status: 422 });
}

/** 看得见的立项受理。
 *
 *  **这一张跟质疑、监查相反：外部方不但看得见，它本来就是给对方看的。**
 *  但行那一维照旧收敛 —— 机构办按医院，我方按派工 / 分组。
 *
 *  而且**不能用 inScope()**：受理发生在建档之前，
 *  那两条 studySiteId 为空的记录会被 inScope 当成"两个键都没有"原样放行，
 *  于是机构办能看到别家医院递的材料。这里按医院与中心两条路各判各的。 */
function visibleAcceptances(): MockAcceptance[] {
  const me = identity();
  const ids = visibleSiteIds();
  const hospitals = new Set(visibleSites().map(s => s.hospital));
  /* 机构办的行范围是"本院"—— 它认的是医院名，不是中心 id，
     所以那两条还没建档的受理它照样看得到。 */
  if (me.rowRule === "hospital")
    return scenario.acceptances.filter(a => a.hospital === me.orgRef);
  if (me.rowRule === "all") return scenario.acceptances;
  return scenario.acceptances.filter(a =>
    (a.studySiteId !== null && ids.has(a.studySiteId)) || hospitals.has(a.hospital));
}
function findAcceptance(url: string, re: RegExp):
  { a: MockAcceptance } | { problem: Response } {
  const id = seg(url, re);
  const a = visibleAcceptances().find(x => x.id === id);
  return a ? { a } : { problem: HttpResponse.json(
    problem("not-found", 404, "立项受理不存在"), { status: 404 }) };
}
function acceptanceDto(a: MockAcceptance) {
  return {
    ...a,
    presentDocs: a.docs.filter(d => d.present).length,
    /* **缺的是哪几份 —— 名字，不是数目。** 补正通知要写的正是这几个名字。 */
    missingDocs: a.docs.filter(d => !d.present).map(d => d.name)
  };
}

/** 看得见的中心文件。**机构办翻得到本院那摞纸** ——
 *  研究者文件夹本来就放在医院里，对它藏起来，
 *  系统里的台账和现场那一摞就对不上了。 */
function visibleIsf(): MockIsf[] { return inScope(scenario.isf); }

/** 状态是**算出来的**，mock 也要算 —— 写死在 fixture 里，
 *  跑到下个季度它就开始撒谎，而页面看起来一切正常。 */
function isfDto(i: MockIsf) {
  return { ...i, ...isfVerdict({
    category: i.category as IsfCategory, present: i.present,
    expiresOn: i.expiresOn, leadDays: null,
    quantity: i.quantity, reorderAt: i.reorderAt
  }, TODAY_STR) };
}

/** 看得见的监查访视。**外部方一条都没有** ——
 *  监查策略不能交给被监查的一方（迁移 0033 的行策略）。 */
function visibleMonitorVisits() {
  if (identity().isExternal) return [];
  return inScope(scenario.monitorVisits);
}
function findVisit(url: string, re: RegExp):
  { v: MockMonitorVisit } | { problem: Response } {
  const id = seg(url, re);
  const v = visibleMonitorVisits().find(x => x.id === id);
  return v ? { v } : { problem: HttpResponse.json(
    problem("not-found", 404, "监查访视不存在"), { status: 404 }) };
}
/** 服务端算出来的那几个派生字段 —— mock 也要算，否则页面在两边不一样。 */
function monitorDto(v: MockMonitorVisit) {
  const lag = mvrLagDays(
    { performedOn: v.performedOn, reportSubmittedOn: v.reportSubmittedOn }, TODAY_STR);
  const notYetThere = v.state === "proposed" || v.state === "scheduled";
  const over = notYetThere
    ? Math.round((Date.parse(TODAY_STR) - Date.parse(v.plannedOn)) / 86_400_000) : 0;
  return mask({
    ...v,
    openItems: v.items.filter(i => i.doneAt === null).length,
    mvrLagDays: lag,
    mvrOverdue: v.reportSubmittedOn === null && lag !== null && lag > MVR_DUE_DAYS,
    visitOverdueDays: over > 0 ? over : null
  });
}

/** 看得见的内部稽查。**外部方一条都没有** ——
 *  把自查报告给被查方看，下一次自查就查不出东西了。 */
function visibleAudits() {
  if (identity().isExternal) return [];
  return inScope(scenario.audits);
}
function findAudit(url: string, re: RegExp):
  { a: MockAudit } | { problem: Response } {
  const id = seg(url, re);
  const a = visibleAudits().find(x => x.id === id);
  return a ? { a } : { problem: HttpResponse.json(
    problem("not-found", 404, "内部稽查不存在"), { status: 404 }) };
}
const auditDto = (a: MockAudit) => ({
  ...a,
  openFindings: a.findings.filter(f => f.state === "open").length,
  repeatFindings: a.findings.filter(f => f.repeatOf !== null).length
});

/** 质量事件的 CAPA 派生字段 —— 服务端算什么，这里算什么。 */
function qualityDto(e: Scenario["qualityEvents"][number]) {
  const over = e.capaDueOn && e.state !== "closed"
    ? Math.round((Date.parse(TODAY_STR) - Date.parse(e.capaDueOn)) / 86_400_000) : 0;
  return {
    ...e,
    category: e.category ?? null,
    capaPlan: e.capaPlan ?? null,
    capaOwnerAccountId: e.capaOwnerAccountId ?? null,
    capaOwnerName: e.capaOwnerName ?? null,
    capaDueOn: e.capaDueOn ?? null,
    capaOverdueDays: over > 0 ? over : null,
    /* **已指派、还没写措施** —— 它不是「正在整改」，是有人欠着一份措施。 */
    owesCapaPlan: !!e.capaOwnerAccountId && !e.capaPlan
  };
}

/** 立项申请的派生字段 —— 毛利率与保本合同额由 calc 算，mock 不另写一份。
 *  **毛利率尤其不能是行上的一个数**：能自己报毛利率的申请，门槛就形同虚设。 */
function intakeDto(x: MockIntake) {
  const m = intakeMath({
    contractCents: x.contractCents, estimatedCostCents: x.estimatedCostCents,
    plannedSubjects: x.plannedSubjects, plannedSites: x.plannedSites
  });
  return mask({
    ...x,
    grossCents: m.grossCents,
    ...(m.grossMargin !== null ? { grossMargin: m.grossMargin } : {}),
    belowGate: m.belowGate,
    ...(m.perSubjectCents !== null ? { perSubjectCents: m.perSubjectCents } : {}),
    breakEvenContractCents: m.breakEvenContractCents,
    subjectsPerSite: m.subjectsPerSite
  });
}
/** 立项对外部方整表关闭 —— 看得到我们按什么毛利率接项目，下一轮就不用谈了。 */
const visibleIntake = () => identity().isExternal ? [] : scenario.intake;

const TODAY_STR = new Date().toISOString().slice(0, 10);

const me = () => {
  const r = identity();
  const scope = visibleSiteIds();
  return {
    account: {
      id: r.id, login: r.login, displayName: r.name,
      role: { ...r.role, isExternal: r.isExternal },
      /* 外部方**没有分组** —— 分组是我方承接项目的单位，
         给机构办安一个「华东华南组」会让"我的团队"那一页凭空成立。 */
      team: r.isExternal ? null : { id: "t1", code: "G-01", name: "华东华南组" },
      isExternal: r.isExternal, orgRef: r.orgRef, status: "active",
      joinedOn: "2024-03-01", disabledAt: null, disabledReason: null,
      lastLoginAt: new Date().toISOString()
    },
    scopeLabel: `${scope.size} 个中心 · 1 个项目`,
    permissions: {
      rowRule: r.rowRule, fields: [...r.fields],
      actions: [...r.actions], modules: [...r.modules]
    },
    /* mock 里的人是用一次性链接进来的，没有口令 —— 于是也不会挂那条红条。
       要看红条长什么样，把 passwordIsInitial 改成 true。 */
    credentials: { hasPassword: false, passwordIsInitial: false }
  };
};

/* 列权限在 mock 里也要**删字段**，不是置 null。
   置 null 的话前端会写成 `?? "—"`，而真库上那个字段根本不在 ——
   `undefined ?? "—"` 也是 "—"，看起来一样；
   但"整列不画"和"画一列横杠"是两种不同的界面，
   只有真库那一侧会暴露出来。 */
const canSeeSubject = () => identity().fields.includes("subject");

function maskSubject(s: MockSubject) {
  if (canSeeSubject()) return { ...s, randomizationNo: s.randomizationNo ?? undefined };
  const { screeningNo: _n, randomizationNo: _r, ...rest } = s;
  return rest as Omit<MockSubject, "screeningNo" | "randomizationNo">;
}
function maskPayment(p: MockPayment) {
  if (canSeeSubject()) return p;
  const { screeningNo: _n, ...rest } = p;
  return rest as Omit<MockPayment, "screeningNo">;
}
const subjectFrom = (request: Request, re: RegExp) => {
  const [, id] = new URL(request.url).pathname.match(re) ?? [];
  return scenario.subjects.find(x => x.id === id);
};
const notFoundSubject = () =>
  HttpResponse.json(problem("not-found", 404, "受试者不存在"), { status: 404 });

const daysBetween = (a: string, b: string) =>
  Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000);
const todayStr = () => new Date().toISOString().slice(0, 10);
/** 某个日期往后 n 天。**用 UTC 算** —— 本地时区在夏令时切换那两天会差一天。 */
const shiftStr = (from: string, n: number) =>
  new Date(Date.parse(from + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);

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
    let items = inScope(scenario.visits).map(withDaysLeft);
    const subjectId = q.get("subjectId");
    if (subjectId) items = items.filter(v => v.subjectId === subjectId);
    if (q.get("outOfWindow") === "true") items = items.filter(v => v.outOfWindow);
    const status = q.getAll("status");
    if (status.length) items = items.filter(v => status.includes(v.status));
    /* 待 PI 确认 = 已完成、但还没签字。**在服务端筛** ——
       前端取一页回来自己挑，访视上了几百条之后第一页全是历史，
       研究者工作台就永远是空的。 */
    if (q.get("pendingPi") === "true")
      items = items.filter(v => v.status === "done" && !v.piConfirmedAt);
    items.sort(byWindow);
    return HttpResponse.json({ items, nextCursor: null });
  }),

  /* 详情页取的是**这一条**。放在列表处理器后面没关系：
     pathToRegExp 结尾锚了 `(\?|$)`，`/v1/subject-visits` 那条匹配不到带 id 的路径。 */
  http.get(pathToRegExp("/v1/subject-visits/{id}"), ({ request }) => {
    const [, id] = new URL(request.url).pathname.match(/\/subject-visits\/([^/?]+)/) ?? [];
    const v = scenario.visits.find(x => x.id === id);
    /* 范围之外与不存在**同样是 404** —— 给 403 等于承认"它存在但不给你看"，
       那本身就是一条信息。 */
    if (!v || !siteInScope(v.studySiteId))
      return HttpResponse.json(problem("not-found", 404, "访视不存在"), { status: 404 });
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

  /* PI 确认。**只有该中心的 PI 本人能按** —— 服务端那条 I3 在这里
     演成两半：别的角色没有 piConfirm 动作（按钮画不出来），
     范围外的访视 404（连行都看不到）。 */
  http.post(pathToRegExp("/v1/subject-visits/{id}:confirm"), ({ request }) => {
    const id = seg(request.url, /\/subject-visits\/([^/:]+):confirm/);
    const v = scenario.visits.find(x => x.id === id);
    if (!v || !siteInScope(v.studySiteId)) return HttpResponse.json(
      problem("not-found", 404, "访视不存在"), { status: 404 });
    if (!identity().actions.includes("piConfirm")) return HttpResponse.json(
      problem("forbidden", 403, "只有该中心的研究者可以确认访视"), { status: 403 });
    if (v.status !== "done") return HttpResponse.json(
      problem("invariant-violated", 422, "访视尚未完成，没有可确认的内容"), { status: 422 });
    v.piConfirmedAt = new Date().toISOString();
    v.piConfirmedByName = identity().name;
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

  http.post(pathToRegExp("/v1/study-sites/{id}/ip-movements"), async ({ request }) => {
    const id = seg(request.url, /\/study-sites\/([^/]+)\/ip-movements/);
    const b = await request.json() as {
      kind: string; quantity: number; movedOn?: string;
      subjectRef?: string; refNo?: string; note?: string };
    const m = {
      id: `ip-${scenario.ipMovements.length + 1}`, studySiteId: id!,
      movedOn: b.movedOn ?? todayStr(), kind: b.kind, quantity: b.quantity,
      subjectRef: b.subjectRef ?? null, refNo: b.refNo ?? null, note: b.note ?? null
    };
    /* **只追加。** mock 里也不提供改与删 —— 提供了的话，
       前端迟早会长出一个"编辑"按钮，而真后端根本没有那个入口。 */
    scenario.ipMovements.push(m);
    return HttpResponse.json(m, { status: 201 });
  }),

  /* ── 生物样本 ──────────────────────────────────────────────────── */
  http.get(pathToRegExp("/v1/study-sites/{id}/specimens"), ({ request }) => {
    const id = seg(request.url, /\/study-sites\/([^/]+)\/specimens/);
    const q = new URL(request.url).searchParams;
    let items = scenario.specimens.filter(x => x.studySiteId === id);
    if (q.get("openOnly") === "true") items = items.filter(x => !x.closed);
    return HttpResponse.json({ items, nextCursor: null });
  }),

  http.post(pathToRegExp("/v1/study-sites/{id}/specimens"), async ({ request }) => {
    const id = seg(request.url, /\/study-sites\/([^/]+)\/specimens/);
    const b = await request.json() as {
      subjectRef: string; kind: string; collectedOn: string; trackingNo?: string };
    const x = {
      id: `sp-${scenario.specimens.length + 1}`, studySiteId: id!,
      subjectRef: b.subjectRef, kind: b.kind, collectedOn: b.collectedOn,
      shippedOn: null, receivedOn: null, discardedOn: null,
      trackingNo: b.trackingNo ?? null, closed: false
    };
    scenario.specimens.push(x);
    return HttpResponse.json(x, { status: 201 });
  }),

  http.post(pathToRegExp("/v1/specimens/{id}:advance"), async ({ request }) => {
    const id = seg(request.url, /\/specimens\/([^/:]+):advance/);
    const x = scenario.specimens.find(y => y.id === id);
    if (!x) return HttpResponse.json(problem("not-found", 404, "样本不存在"), { status: 404 });
    const b = await request.json() as { stage: string; on: string };
    if (b.stage === "shipped") x.shippedOn = b.on;
    if (b.stage === "received") x.receivedOn = b.on;
    if (b.stage === "discarded") x.discardedOn = b.on;
    /* 闭环 = 收到 **或** 销毁。两个都没有就是在路上不知去向 ——
       这个布尔是算出来的，不是存的，和后端同一条口径。 */
    x.closed = !!(x.receivedOn || x.discardedOn);
    return HttpResponse.json({ data: x, sideEffects: [] }, { status: 201 });
  }),

  /* ── 启动清单汇总 ──────────────────────────────────────────────── */
  http.get(pathToRegExp("/v1/startup-checklists"), ({ request }) => {
    const q = new URL(request.url).searchParams;
    /* **走同一个 checklistFor** —— 汇总另算一遍的话，
       汇总页和详情页会在"逾期"这一栏上对不上，
       而那正是这条端点的测试里花了最多力气钉住的东西。 */
    let items = visibleSites().map(s => {
      const { items: _items, ...summary } = checklistFor(s.id);
      return summary;
    });
    if (q.get("blockedOnly") === "true") items = items.filter(x => x.blockingOpen > 0);
    return HttpResponse.json({ items, nextCursor: null });
  }),

  http.get(pathToRegExp("/v1/quality-events"), ({ request }) => {
    const q = new URL(request.url).searchParams;
    let items = inScope(scenario.qualityEvents);
    const kinds = q.getAll("kind");
    if (kinds.length) items = items.filter(e => kinds.includes(e.kind));
    return HttpResponse.json({ items: items.map(qualityDto), nextCursor: null });
  }),

  /* 写整改措施。**写措施的人不能自己验证关闭** ——
     这里是 capaWrite，关闭是 closeQA（上面那个端点）。 */
  http.post(pathToRegExp("/v1/quality-events/{id}:capa"), async ({ request }) => {
    const id = seg(request.url, /\/quality-events\/([^/:]+):capa/);
    const b = await request.json() as { plan?: string; dueOn?: string };
    const e = inScope(scenario.qualityEvents).find(x => x.id === id);
    if (!e) return HttpResponse.json(
      problem("not-found", 404, "质量事件不存在"), { status: 404 });
    if (!identity().actions.includes("capaWrite")) return HttpResponse.json(
      problem("forbidden", 403, "你的角色不能写整改措施"), { status: 403 });
    /* 质疑有自己的闭环（回复 → 判定），不挂 CAPA。 */
    if (e.kind === "query") return HttpResponse.json(
      problem("invariant-violated", 422,
        `${e.code} 是数据质疑 —— 它走回复与判定，不走 CAPA`), { status: 422 });
    if ((b.plan ?? "").trim().length < 10) return HttpResponse.json(
      problem("validation-failed", 422, "请求参数不符合契约：整改措施至少 10 个字"),
      { status: 422 });
    if (b.dueOn && b.dueOn < e.raisedOn) return HttpResponse.json(
      problem("invariant-violated", 422,
        `整改期限 ${b.dueOn} 早于问题提出日 ${e.raisedOn}`), { status: 422 });
    e.capaPlan = b.plan!.trim();
    e.capaDueOn = b.dueOn ?? null;
    e.capaOwnerAccountId = identity().id;
    e.capaOwnerName = identity().name;
    return HttpResponse.json({
      data: qualityDto(e),
      sideEffects: [{ type: "CapaPlanned", ref: e.id,
        summary: `${e.code} 的整改措施已提交，期限 ${b.dueOn} —— ` +
          "验证关闭在 QA 那边，写措施的人不能自己关" }]
    }, { status: 201 });
  }),

  /* 关闭质量事件。**机构提出的由机构关** —— 这条规则在服务端，
     这里只演它的另一半：没有 closeQA 的角色连按钮都看不到，
     而带着 closeQA 的机构办按下去要真的让那一行从"未了结"里消失。 */
  http.post(pathToRegExp("/v1/quality-events/{id}:close"), async ({ request }) => {
    const id = seg(request.url, /\/quality-events\/([^/:]+):close/);
    const b = await request.json() as { reason?: string };
    const q = scenario.qualityEvents.find(x => x.id === id);
    if (!q || (q.studySiteId !== undefined && !siteInScope(q.studySiteId)))
      return HttpResponse.json(
        problem("not-found", 404, "质量事件不存在"), { status: 404 });
    if (!identity().actions.includes("closeQA")) return HttpResponse.json(
      problem("forbidden", 403, "你的角色不能关闭质量事件"), { status: 403 });
    /* 整改说明是**必填**（契约里的 WithReason，最短 4 个字）。
       mock 上放行一次真库会拒的提交，等于把这条规则藏到集成测试才暴露。 */
    if (!b.reason || b.reason.trim().length < 4) return HttpResponse.json(
      problem("validation-failed", 422, "请求参数不符合契约：整改说明至少 4 个字"),
      { status: 422 });
    q.state = "closed";
    return HttpResponse.json({ data: q, sideEffects: [] }, { status: 201 });
  }),

  /* ── 立项与建档 ──────────────────────────────────────────────── */
  http.get(pathToRegExp("/v1/intake-applications/board"), () => {
    const open = visibleIntake().filter(x => x.state === "submitted").map(intakeDto);
    const studies = (identity().isExternal ? [] : scenario.studies).map(st => {
      const g = filingGap(st.plannedSites, st.builtSites);
      return mask({
        studyId: st.id, studyCode: st.code, shortName: st.shortName,
        clientName: st.clientName, phase: st.phase,
        plannedSubjects: st.plannedSubjects,
        plannedSites: g.plannedSites, builtSites: g.builtSites,
        missingSites: g.missing, filedRatio: g.filedRatio,
        contractCents: st.contractCents
      });
    }).sort((a, b) => b.missingSites - a.missingSites
      || a.studyCode.localeCompare(b.studyCode));
    return HttpResponse.json(mask({
      open: open.length,
      belowGate: open.filter(x => x.belowGate).length,
      openContractCents: visibleIntake()
        .filter(x => x.state === "submitted")
        .reduce((n, x) => n + x.contractCents, 0),
      gmGate: INTAKE_GM_GATE,
      studies,
      missingSites: studies.reduce((n, s) => n + s.missingSites, 0),
      calcVersion: CALC_VERSION
    }));
  }),

  http.get(pathToRegExp("/v1/intake-applications"), ({ request }) => {
    const q = new URL(request.url).searchParams;
    let items = visibleIntake().map(intakeDto);
    const states = q.getAll("state");
    if (states.length) items = items.filter(x => states.includes(x.state));
    if (q.get("mine") === "true")
      items = items.filter(x => x.submittedBy === identity().id);
    if (q.get("belowGateOnly") === "true") items = items.filter(x => x.belowGate);
    /* 越线的排最前 —— 按提交日排的话它会沉在底下。 */
    items = [...items].sort((a, b) => Number(b.belowGate) - Number(a.belowGate)
      || b.submittedOn.localeCompare(a.submittedOn));
    return HttpResponse.json({ items, nextCursor: null });
  }),

  http.post(pathToRegExp("/v1/intake-applications"), async ({ request }) => {
    const b = await request.json() as Record<string, never> & {
      drug: string; sponsorName: string; phase: string; indication: string;
      plannedSites: number; plannedSubjects: number; enrollMonths: number;
      contractCents: number; estimatedCostCents: number; note?: string;
    };
    if (!identity().actions.includes("bid")) return HttpResponse.json(
      problem("forbidden", 403, "你的角色不能提交立项申请"), { status: 403 });
    const me = identity();
    const row: MockIntake = {
      id: `np-${scenario.intake.length + 1}`,
      code: `NP-2026-${String(20 + scenario.intake.length).slice(-3)}`,
      drug: b.drug, sponsorName: b.sponsorName, phase: b.phase,
      indication: b.indication,
      plannedSites: b.plannedSites, plannedSubjects: b.plannedSubjects,
      enrollMonths: b.enrollMonths,
      contractCents: b.contractCents, estimatedCostCents: b.estimatedCostCents,
      note: b.note ?? null,
      submittedBy: me.id, submittedByName: me.name, submittedOn: TODAY_STR,
      state: "submitted", decidedByName: null, decidedOn: null,
      decisionNote: null, studyId: null, studyCode: null
    };
    scenario.intake.unshift(row);
    const m = intakeMath({
      contractCents: b.contractCents, estimatedCostCents: b.estimatedCostCents,
      plannedSubjects: b.plannedSubjects, plannedSites: b.plannedSites
    });
    return HttpResponse.json({
      data: intakeDto(row),
      sideEffects: [{ type: "IntakeSubmitted", ref: row.id,
        summary: m.belowGate
          ? `${row.code} 已提交 —— 测算毛利率低于 ` +
            `${Math.round(INTAKE_GM_GATE * 100)}% 门槛，必须过经营层那一关`
          : `${row.code} 已提交，等待经营层审批` }]
    }, { status: 201 });
  }),

  http.post(pathToRegExp("/v1/intake-applications/{id}:decide"), async ({ request }) => {
    const id = seg(request.url, /\/intake-applications\/([^/:]+):decide/);
    const b = await request.json() as { result: string; reason?: string };
    const x = visibleIntake().find(a => a.id === id);
    if (!x) return HttpResponse.json(
      problem("not-found", 404, "立项申请不存在"), { status: 404 });
    if (!identity().actions.includes("approve")) return HttpResponse.json(
      problem("forbidden", 403, "你的角色不能审批立项"), { status: 403 });
    if (x.state !== "submitted") return HttpResponse.json(
      problem("invariant-violated", 422,
        `${x.code} 已经${x.state === "approved" ? "批准" : "退回"}过了`), { status: 422 });
    /* **提交人不能批准自己的申请** —— 与工时审批同一条规矩。 */
    if (x.submittedBy === identity().id) return HttpResponse.json(
      problem("invariant-violated", 422,
        `${x.code} 是你自己提交的 —— 立项审批不能自己批自己`), { status: 422 });

    if (b.result === "returned") {
      if (!b.reason || b.reason.trim().length < 4) return HttpResponse.json(
        problem("invariant-violated", 422,
          "退回必须写理由 —— 不说为什么，提交人只能猜"), { status: 422 });
      x.state = "returned";
      x.decidedByName = identity().name;
      x.decidedOn = TODAY_STR;
      x.decisionNote = b.reason.trim();
      return HttpResponse.json({
        data: intakeDto(x),
        sideEffects: [{ type: "IntakeReturned", ref: x.id,
          summary: `${x.code} 已退回 ${x.submittedByName} —— ${b.reason.trim()}` }]
      }, { status: 201 });
    }

    /* 批准 = 同时建出项目档案。约束上两者互为充要条件，
       所以这里也不能只走一半 —— 否则 mock 上跑得通的流程到真库上会被拒。 */
    const code = `HJ-2026-${String(100 + scenario.studies.length).slice(-3)}`;
    scenario.studies.push({
      id: `st-${scenario.studies.length + 1}`, code,
      shortName: x.drug.slice(0, 8), clientName: x.sponsorName, phase: x.phase,
      plannedSubjects: x.plannedSubjects, plannedSites: x.plannedSites,
      builtSites: 0, contractCents: x.contractCents
    });
    x.state = "approved";
    x.decidedByName = identity().name;
    x.decidedOn = TODAY_STR;
    x.decisionNote = b.reason ?? null;
    x.studyId = `st-${scenario.studies.length}`;
    x.studyCode = code;
    return HttpResponse.json({
      data: intakeDto(x),
      sideEffects: [{ type: "IntakeApproved", ref: x.id,
        summary: `${x.drug} 已批准立项，方案编号 ${code} —— ` +
          `合同写了 ${x.plannedSites} 个中心，现在一个都还没建档` }]
    }, { status: 201 });
  }),

  /* ── 内部稽查 ────────────────────────────────────────────────────
     机构质控是医院查我们，稽查是我们自己查自己。**对外部方整表关闭。** */
  http.get(pathToRegExp("/v1/internal-audits/board"), () => {
    const as_ = visibleAudits();
    const evs = inScope(scenario.qualityEvents).filter(e => e.kind !== "query");
    const cat = (e: typeof evs[number]) => e.category ?? e.kind;

    const repeats = as_.flatMap(a => a.findings)
      .filter(f => f.repeatOf !== null)
      .map(f => {
        const src = scenario.qualityEvents.find(e => e.id === f.repeatOf);
        return {
          category: src ? cat(src) : "未知",
          sourceClosed: src ? src.state === "closed" : false
        };
      });

    const sites = visibleSites().map(site => {
      const q = inScope(scenario.qualityEvents).filter(e => e.studySiteId === site.id);
      const stale = scenario.dataQueries.filter(
        d => d.studySiteId === site.id && d.state === "open" && d.ageDays > QUERY_STALE_DAYS);
      const input = {
        severeOpen: q.filter(e => e.state !== "closed" && e.kind !== "sae_late"
          && (e.severity === "major" || e.severity === "critical")).length,
        minorOpen: q.filter(e => e.state !== "closed" && e.kind !== "sae_late"
          && e.severity === "minor").length,
        saeLate: q.filter(e => e.state !== "closed" && e.kind === "sae_late").length,
        staleQueries: stale.length,
        capaRepeats: as_.filter(a => a.studySiteId === site.id)
          .flatMap(a => a.findings).filter(f => f.repeatOf !== null).length
      };
      return {
        studySiteId: site.id, siteCode: site.code, hospital: site.hospital,
        ...gradeSite(input), ...input
      };
    }).sort((a, b) => b.penalty - a.penalty || a.siteCode.localeCompare(b.siteCode));

    const capaEvents = evs.map(e => ({
      category: cat(e),
      closed: e.state === "closed",
      owesPlan: !!e.capaOwnerAccountId && !e.capaPlan
    }));
    return HttpResponse.json({
      openAudits: as_.filter(a => a.state !== "closed").length,
      openFindings: as_.flatMap(a => a.findings).filter(f => f.state === "open").length,
      repeatFindings: repeats.length,
      owesCapaPlan: capaEvents.filter(e => e.owesPlan).length,
      capa: capaEffectiveness(capaEvents, repeats),
      sites, calcVersion: CALC_VERSION
    });
  }),

  http.get(pathToRegExp("/v1/internal-audits"), ({ request }) => {
    const q = new URL(request.url).searchParams;
    let items = visibleAudits();
    const kinds = q.getAll("kind");
    if (kinds.length) items = items.filter(a => kinds.includes(a.kind));
    if (q.get("openOnly") === "true") items = items.filter(a => a.state !== "closed");
    items = [...items].sort((a, b) => b.auditedOn.localeCompare(a.auditedOn));
    return HttpResponse.json({ items: items.map(auditDto), nextCursor: null });
  }),

  http.post(pathToRegExp("/v1/internal-audits"), async ({ request }) => {
    const b = await request.json() as {
      studySiteId: string; kind: string; auditedOn?: string; scope: string;
    };
    /* **audit 不是 closeQA。** 机构办有 closeQA —— 借它来发起内部稽查，
       等于让被稽查的一方能对我方发起稽查。 */
    if (!identity().actions.includes("audit")) return HttpResponse.json(
      problem("forbidden", 403, "只有质量保证能发起内部稽查"), { status: 403 });
    const site = SITES_LIST.find(x => x.id === b.studySiteId);
    if (!site || !siteInScope(site.id)) return HttpResponse.json(
      problem("not-found", 404, "中心不存在"), { status: 404 });
    if ((b.scope ?? "").trim().length < 4) return HttpResponse.json(
      problem("validation-failed", 422,
        "请求参数不符合契约：稽查范围至少 4 个字 —— 空范围的稽查等于没查"),
      { status: 422 });

    const me = identity();
    const row: MockAudit = {
      id: `au-${scenario.audits.length + 1}`,
      code: `AU-2026-${String(100 + scenario.audits.length).slice(-3)}`,
      studySiteId: site.id, siteCode: site.code, hospital: site.hospital,
      kind: b.kind, auditedOn: b.auditedOn ?? TODAY_STR,
      auditorAccountId: me.id, auditorName: me.name,
      scope: b.scope.trim(), state: "open", closedAt: null, findings: []
    };
    scenario.audits.unshift(row);
    return HttpResponse.json({
      data: auditDto(row),
      sideEffects: [{ type: "InternalAuditOpened", ref: row.id,
        summary: `${row.code} 已对 ${site.code} 发起 —— 发现项逐条记，全部关闭时自动结案` }]
    }, { status: 201 });
  }),

  http.post(pathToRegExp("/v1/internal-audits/{id}:finding"), async ({ request }) => {
    const r = findAudit(request.url, /\/internal-audits\/([^/:]+):finding/);
    if ("problem" in r) return r.problem;
    const b = await request.json() as {
      severity: string; finding: string; repeatOf?: string;
    };
    if (!identity().actions.includes("audit")) return HttpResponse.json(
      problem("forbidden", 403, "只有质量保证能记稽查发现"), { status: 403 });
    if (r.a.state === "closed") return HttpResponse.json(
      problem("invariant-violated", 422,
        `${r.a.code} 已结案 —— 新发现要新开一次稽查`), { status: 422 });
    if ((b.finding ?? "").trim().length < 10) return HttpResponse.json(
      problem("validation-failed", 422, "请求参数不符合契约：发现描述至少 10 个字"),
      { status: 422 });

    const src = b.repeatOf
      ? scenario.qualityEvents.find(e => e.id === b.repeatOf) : undefined;
    if (b.repeatOf && !src) return HttpResponse.json(
      problem("not-found", 404, "质量事件不存在"), { status: 404 });
    /* 源事件必须早于本次稽查 —— 指向一条今天才提出的，那不是复发，
       而"复发"这个判定会把整类问题判成 CAPA 无效。 */
    if (src && src.raisedOn >= r.a.auditedOn) return HttpResponse.json(
      problem("invariant-violated", 422,
        `${src.code} 提出于 ${src.raisedOn}，不早于本次稽查 ${r.a.auditedOn} —— 那不是复发`),
      { status: 422 });

    const seq = r.a.findings.length;
    r.a.findings.push({
      seq, severity: b.severity, finding: b.finding.trim(),
      repeatOf: b.repeatOf ?? null, repeatOfCode: src?.code ?? null,
      repeatAfterClose: src ? src.state === "closed" : null,
      state: "open", verification: null, closedAt: null
    });
    if (r.a.state === "open") r.a.state = "remediating";
    return HttpResponse.json({
      data: auditDto(r.a),
      sideEffects: [{ type: "AuditFindingAdded", ref: r.a.id,
        summary: b.repeatOf
          ? `${r.a.code} 记下一条复发发现 —— 同类问题的 CAPA 判定会因此变成「无效」`
          : `${r.a.code} 已记下第 ${seq + 1} 条发现` }]
    }, { status: 201 });
  }),

  http.post(pathToRegExp("/v1/internal-audits/{id}/findings/{seq}:close"),
    async ({ request }) => {
      const r = findAudit(request.url, /\/internal-audits\/([^/]+)\/findings\//);
      if ("problem" in r) return r.problem;
      const seq = Number(seg(request.url, /\/findings\/(\d+):close/));
      const b = await request.json() as { verification?: string };
      if (!identity().actions.includes("audit")) return HttpResponse.json(
        problem("forbidden", 403, "只有质量保证能验证关闭"), { status: 403 });
      /* 「已整改」三个字不是验证 —— 核查时看的是"你怎么确认它真的改了"。 */
      if ((b.verification ?? "").trim().length < 10) return HttpResponse.json(
        problem("validation-failed", 422,
          "请求参数不符合契约：验证说明至少 10 个字 —— 「已整改」三个字不是验证"),
        { status: 422 });
      const f = r.a.findings.find(x => x.seq === seq);
      if (!f) return HttpResponse.json(
        problem("not-found", 404, "稽查发现不存在"), { status: 404 });
      if (f.state === "closed") return HttpResponse.json(
        problem("invariant-violated", 422,
          `${r.a.code} 第 ${seq + 1} 条已经关闭`), { status: 422 });
      f.state = "closed";
      f.verification = b.verification!.trim();
      f.closedAt = new Date().toISOString();
      const left = r.a.findings.filter(x => x.state === "open").length;
      if (left === 0) { r.a.state = "closed"; r.a.closedAt = new Date().toISOString(); }
      return HttpResponse.json({
        data: auditDto(r.a),
        sideEffects: [{ type: "AuditFindingClosed", ref: r.a.id,
          summary: left === 0
            ? `${r.a.code} 全部发现项已验证关闭，稽查自动结案`
            : `${r.a.code} 第 ${seq + 1} 条已验证关闭，还剩 ${left} 条` }]
      }, { status: 201 });
    }),

  /* ── 监查访视 ────────────────────────────────────────────────────
     **外部方一条都看不到**（迁移 0033 的行策略）：一个机构办看得到
     我们打算什么时候去、抽多少比例，等于把监查策略交给了被监查的一方。 */
  /* ── 立项受理 ──────────────────────────────────────────────── */

  http.get(pathToRegExp("/v1/site-acceptances"), ({ request }) => {
    const q = new URL(request.url).searchParams;
    let items = visibleAcceptances();
    const states = q.getAll("state");
    if (states.length) items = items.filter(a => states.includes(a.state));
    if (q.get("openOnly") === "true") items = items.filter(a => a.state !== "accepted");
    if (q.get("studyId")) items = items.filter(a => a.studyId === q.get("studyId"));
    items = [...items].sort((a, b) => b.submittedOn.localeCompare(a.submittedOn));
    return HttpResponse.json({ items: items.map(acceptanceDto), nextCursor: null });
  }),

  /* 递交立项材料。**要排在 {id}/docs 那几条之前**，否则
     `/v1/site-acceptances` 这条通配会先吃掉带 id 的路径。
     （严格说 `[^/]+` 跨不过斜杠所以不排也行，但顺序是一眼看得出来的，
     那条推理不是 —— 哪天正则改一个字符，靠推理成立的那一版会静默走错。） */
  http.post(pathToRegExp("/v1/site-acceptances"), async ({ request }) => {
    const b = await request.json() as {
      studyId: string; hospital: string; docs: string[];
    };
    if (!identity().actions.includes("advance")) return HttpResponse.json(
      problem("forbidden", 403, "你的角色不能递交立项材料"), { status: 403 });
    if (scenario.acceptances.some(
      a => a.studyId === b.studyId && a.hospital === b.hospital))
      return HttpResponse.json(problem("invariant-violated", 422,
        `${b.hospital} 这个项目已经递过了`), { status: 422 });

    const me = identity();
    const row: MockAcceptance = {
      id: `ac-new-${scenario.acceptances.length + 1}`,
      code: `AC-2026-${String(30 + scenario.acceptances.length).slice(-3)}`,
      studyId: b.studyId, studyCode: "HJ-2024-017",
      drug: "艾瑞替尼", sponsorName: "恒瑞医药", phase: "III 期",
      hospital: b.hospital, studySiteId: null, siteCode: null,
      submittedByName: me.name, submittedOn: TODAY_STR,
      state: "review", origin: "in_system", amendNote: null,
      acceptedOn: null, acceptedByName: null,
      /* **一律未勾** —— 勾是机构办形式审查的动作。 */
      docs: b.docs.map((name, seq) => ({ seq, name, present: false }))
    };
    scenario.acceptances.unshift(row);
    return HttpResponse.json(acceptanceDto(row), { status: 201 });
  }),

  http.post(pathToRegExp("/v1/site-acceptances/{id}/docs/{seq}:set"),
    async ({ request }) => {
      const found = findAcceptance(request.url, /site-acceptances\/([^/]+)\/docs/);
      if ("problem" in found) return found.problem;
      const { a } = found;
      if (a.origin === "registered")
        return invariant("acceptance-registered-readonly",
          `${a.code} 是系统外受理的登记存根，不能在这里勾材料清单 —— ` +
          "它记的是一件已经发生过的事");
      if (a.state === "accepted")
        return invariant("acceptance-frozen",
          `${a.code} 已受理，材料清单不能再改 —— 受理通知已经发出去了`);
      const seqNo = Number(request.url.match(/docs\/(\d+):set/)?.[1] ?? -1);
      const doc = a.docs.find(d => d.seq === seqNo);
      if (!doc) return HttpResponse.json(
        problem("not-found", 404, "立项材料不存在"), { status: 404 });
      doc.present = ((await request.json()) as { present: boolean }).present;
      return HttpResponse.json(
        { data: acceptanceDto(a), sideEffects: [] }, { status: 201 });
    }),

  http.post(pathToRegExp("/v1/site-acceptances/{id}:accept"), ({ request }) => {
    const found = findAcceptance(request.url, /site-acceptances\/([^:]+):accept/);
    if ("problem" in found) return found.problem;
    const { a } = found;
    if (a.origin === "registered")
      return invariant("acceptance-registered-readonly",
        `${a.code} 是系统外受理的登记存根，不能在这里再受理一次`);
    if (a.state === "accepted")
      return invariant("acceptance-already", `${a.code} 已经受理过了`);
    /* **材料不齐不予受理，而且要列出缺的那几份的名字** ——
       一句"材料不齐"会让递交方把八份重寄一遍，而重寄之后缺的还是那两份。 */
    const missing = a.docs.filter(d => !d.present).map(d => d.name);
    if (missing.length)
      return invariant("acceptance-docs-missing",
        `尚缺 ${missing.length} 项材料，不予受理：${missing.join("、")}`);
    a.state = "accepted";
    a.acceptedOn = TODAY_STR;
    a.acceptedByName = identity().name;
    return HttpResponse.json({
      data: acceptanceDto(a),
      sideEffects: [{
        type: "SiteAccepted",
        summary: `${a.code} 已受理并转伦理审查 —— ` +
          (a.studySiteId
            ? "该中心现在可以推进到「伦理递交」"
            : "**该中心还没进台账** —— 受理了但没建档，成本已经在发生"),
        ref: a.id
      }]
    }, { status: 201 });
  }),

  http.post(pathToRegExp("/v1/site-acceptances/{id}:amend"), async ({ request }) => {
    const found = findAcceptance(request.url, /site-acceptances\/([^:]+):amend/);
    if ("problem" in found) return found.problem;
    const { a } = found;
    if (a.origin === "registered")
      return invariant("acceptance-registered-readonly",
        `${a.code} 是系统外受理的登记存根，不能在这里发补正通知`);
    if (a.state === "accepted")
      return invariant("acceptance-already", `${a.code} 已经受理，不能再发补正通知`);
    const b = await request.json() as { reason: string };
    a.state = "amend";
    a.amendNote = b.reason;
    const missing = a.docs.filter(d => !d.present).map(d => d.name);
    return HttpResponse.json({
      data: acceptanceDto(a),
      sideEffects: [{
        type: "AcceptanceAmendRequested",
        summary: `已向 ${a.submittedByName} 发出补正通知` +
          (missing.length ? `：${missing.join("、")}` : ""),
        ref: a.id
      }]
    }, { status: 201 });
  }),

  /* ── 中心文件与物资 ────────────────────────────────────────── */

  http.get(pathToRegExp("/v1/isf-items"), ({ request }) => {
    const q = new URL(request.url).searchParams;
    const cats = q.getAll("category");
    let rows = visibleIsf();
    if (q.get("studySiteId")) rows = rows.filter(i => i.studySiteId === q.get("studySiteId"));
    if (cats.length) rows = rows.filter(i => cats.includes(i.category));
    let items = rows.map(isfDto);
    /* 齐备率按**全部清单**算，不按筛过之后的 —— 只看不齐备的那一栏时，
       齐备率会变成 0%，而那个数字毫无意义。 */
    const summary = { ...isfSummary(items), calcVersion: CALC_VERSION };
    if (q.get("openOnly") === "true") items = items.filter(i => i.status !== "ok");
    items = [...items].sort((a, b) => isfRank(a) - isfRank(b)
      || a.siteCode.localeCompare(b.siteCode)
      || a.item.localeCompare(b.item));
    return HttpResponse.json({ items, summary });
  }),

  http.post(pathToRegExp("/v1/isf-items/{id}:update"), async ({ request }) => {
    const id = seg(request.url, /isf-items\/([^:]+):update/);
    const i = visibleIsf().find(x => x.id === id);
    if (!i) return HttpResponse.json(
      problem("not-found", 404, "中心文件不存在"), { status: 404 });
    const b = await request.json() as {
      present?: boolean; expiresOn?: string | null;
      quantity?: number | null; note?: string;
    };
    const present = b.present ?? i.present;
    const expiresOn = b.expiresOn !== undefined ? b.expiresOn : i.expiresOn;
    /* 不在的东西没有到期日 —— 缺失与过期是两种缺，混起来会互相顶替。 */
    if (!present && expiresOn)
      return invariant("isf-missing-has-expiry",
        `${i.item} 标为缺失，就不该还有到期日 —— 先决定它到底在不在`);
    if (b.quantity != null && i.reorderAt === null)
      return invariant("isf-stock-needs-reorder",
        `${i.item} 没有补货线 —— 填了库存也判不出够不够`);
    i.present = present;
    i.expiresOn = expiresOn;
    if (b.quantity !== undefined) i.quantity = b.quantity;
    if (b.note) i.note = b.note;
    i.checkedOn = TODAY_STR;
    i.checkedByName = identity().name;
    const items = visibleIsf().filter(x => x.studySiteId === i.studySiteId).map(isfDto);
    return HttpResponse.json({
      data: {
        items: [...items].sort((a, b2) => isfRank(a) - isfRank(b2)
          || a.item.localeCompare(b2.item)),
        summary: { ...isfSummary(items), calcVersion: CALC_VERSION }
      },
      sideEffects: []
    }, { status: 201 });
  }),

  http.get(pathToRegExp("/v1/monitor-visits/board"), () => {
    const vs = visibleMonitorVisits();
    const sites = visibleSites().map(site => {
      /* 风险信号从 mock 已有的两本台账里取 —— 手搓一份"这个中心几分"
         等于给这个系统开第三套口径。 */
      const q = scenario.qualityEvents.filter(
        e => e.studySiteId === site.id && e.state !== "closed");
      const stale = scenario.dataQueries.filter(
        d => d.studySiteId === site.id && d.state === "open" && d.ageDays > QUERY_STALE_DAYS);
      const plan = monitorPlan({
        severeOpen: q.filter(e => e.kind !== "sae_late"
          && (e.severity === "major" || e.severity === "critical")).length,
        minorOpen: q.filter(e => e.kind !== "sae_late" && e.severity === "minor").length,
        saeLate: q.filter(e => e.kind === "sae_late").length,
        staleQueries: stale.length,
        daysSinceEnroll: FUNNELS.find(f => f.studySiteId === site.id)?.enrolled ? 10 : null
      });
      const mine = vs.filter(v => v.studySiteId === site.id);
      const last = mine.filter(v => v.performedOn)
        .map(v => v.performedOn!).sort().at(-1) ?? null;
      return {
        studySiteId: site.id, siteCode: site.code, hospital: site.hospital,
        siteState: site.state,
        band: plan.band, riskScore: plan.score,
        intervalDays: plan.intervalDays, sdvSamplePct: plan.sdvSamplePct,
        reasons: plan.reasons,
        lastVisitOn: last,
        ...monitorDue(last, plan.intervalDays, TODAY_STR),
        neverVisited: last === null,
        openVisits: mine.filter(v => v.state !== "reported").length
      };
    }).sort((a, b) =>
      (b.overdueDays ?? -1) - (a.overdueDays ?? -1)
      || Number(b.neverVisited) - Number(a.neverVisited)
      || b.riskScore - a.riskScore
      || a.siteCode.localeCompare(b.siteCode));

    const upcoming = vs.filter(v =>
      (v.state === "proposed" || v.state === "scheduled")
      && Date.parse(v.plannedOn) <= Date.now() + 28 * 86_400_000);
    return HttpResponse.json(mask({
      load: mvrLoad(vs.map(v => ({
        performedOn: v.performedOn, reportSubmittedOn: v.reportSubmittedOn
      })), TODAY_STR),
      sites,
      upcomingVisits: upcoming.length,
      upcomingDays: upcoming.reduce((n, v) => n + v.days, 0),
      travelEstimateCents: travelEstimateCents(upcoming.length, 285_000),
      calcVersion: CALC_VERSION
    }));
  }),

  http.get(pathToRegExp("/v1/monitor-visits"), ({ request }) => {
    const q = new URL(request.url).searchParams;
    let items = visibleMonitorVisits();
    const kinds = q.getAll("kind"), states = q.getAll("state");
    if (kinds.length) items = items.filter(v => kinds.includes(v.kind));
    if (states.length) items = items.filter(v => states.includes(v.state));
    if (q.get("mine") === "true")
      items = items.filter(v => v.monitorAccountId === identity().id);
    if (q.get("openOnly") === "true") items = items.filter(v => v.state !== "reported");
    items = [...items].sort((a, b) => a.plannedOn.localeCompare(b.plannedOn));
    return HttpResponse.json({ items: items.map(monitorDto), nextCursor: null });
  }),

  http.post(pathToRegExp("/v1/monitor-visits"), async ({ request }) => {
    const b = await request.json() as {
      studySiteId: string; kind: string; plannedOn: string;
      days: number; sdvSamplePct?: number; note?: string; items: string[];
    };
    if (!identity().actions.includes("monitor")) return HttpResponse.json(
      problem("forbidden", 403, "你的角色不能排监查访视"), { status: 403 });
    const site = SITES_LIST.find(x => x.id === b.studySiteId);
    if (!site || !siteInScope(site.id)) return HttpResponse.json(
      problem("not-found", 404, "中心不存在"), { status: 404 });
    if (site.state === "closed") return HttpResponse.json(
      problem("invariant-violated", 422,
        `${site.code} 已关闭 —— 关闭之后还要去，说明关闭那一步没做完`), { status: 422 });

    const me = identity();
    const row: MockMonitorVisit = {
      id: `mv-${scenario.monitorVisits.length + 1}`,
      code: `MV-2026-${String(100 + scenario.monitorVisits.length).slice(-3)}`,
      studySiteId: site.id, siteCode: site.code, hospital: site.hospital,
      studyShortName: "艾瑞替尼 III",
      kind: b.kind, plannedOn: b.plannedOn,
      monitorAccountId: me.id, monitorName: me.name,
      days: b.days, state: "proposed",
      confirmedOn: null, performedOn: null, reportSubmittedOn: null,
      sdvSamplePct: b.sdvSamplePct ?? null, note: b.note ?? null,
      items: b.items.map((task, seq) => ({ seq, task, doneAt: null, doneByName: null }))
    };
    scenario.monitorVisits.push(row);
    return HttpResponse.json({
      data: monitorDto(row),
      sideEffects: [{ type: "MonitorVisitPlanned", ref: row.id,
        summary: `${row.code} 已排到 ${b.plannedOn}（${b.items.length} 项跟进项）` +
          " —— 还要与中心确认时间" }]
    }, { status: 201 });
  }),

  http.post(pathToRegExp("/v1/monitor-visits/{id}:confirm"), async ({ request }) => {
    const r = findVisit(request.url, /\/monitor-visits\/([^/:]+):confirm/);
    if ("problem" in r) return r.problem;
    if (!identity().actions.includes("monitor")) return HttpResponse.json(
      problem("forbidden", 403, "你的角色不能改监查排期"), { status: 403 });
    if (r.v.state !== "proposed") return HttpResponse.json(
      problem("invariant-violated", 422, `${r.v.code} 已经确认过了`), { status: 422 });
    r.v.state = "scheduled";
    r.v.confirmedOn = TODAY_STR;
    return HttpResponse.json({
      data: monitorDto(r.v),
      sideEffects: [{ type: "MonitorVisitConfirmed", ref: r.v.id,
        summary: `${r.v.code} 已与 ${r.v.hospital} 确认 ${r.v.plannedOn}` }]
    }, { status: 201 });
  }),

  http.post(pathToRegExp("/v1/monitor-visits/{id}:perform"), async ({ request }) => {
    const r = findVisit(request.url, /\/monitor-visits\/([^/:]+):perform/);
    if ("problem" in r) return r.problem;
    if (!identity().actions.includes("monitor")) return HttpResponse.json(
      problem("forbidden", 403, "你的角色不能登记到现场"), { status: 403 });
    if (r.v.state === "proposed") return HttpResponse.json(
      problem("invariant-violated", 422,
        `${r.v.code} 还没与中心确认时间 —— 先确认`), { status: 422 });
    if (r.v.state !== "scheduled") return HttpResponse.json(
      problem("invariant-violated", 422, `${r.v.code} 已经登记过到现场`), { status: 422 });
    r.v.state = "done";
    r.v.performedOn = TODAY_STR;
    return HttpResponse.json({
      data: monitorDto(r.v),
      sideEffects: [{ type: "MonitorVisitPerformed", ref: r.v.id,
        summary: `${r.v.code} 已登记到现场（${TODAY_STR}）—— ` +
          `监查报告请在 ${MVR_DUE_DAYS} 天内提交` }]
    }, { status: 201 });
  }),

  http.post(pathToRegExp("/v1/monitor-visits/{id}/items/{seq}:done"),
    async ({ request }) => {
      const r = findVisit(request.url, /\/monitor-visits\/([^/]+)\/items\//);
      if ("problem" in r) return r.problem;
      const seq = Number(seg(request.url, /\/items\/(\d+):done/));
      const b = await request.json() as { done: boolean };
      if (!identity().actions.includes("monitor")) return HttpResponse.json(
        problem("forbidden", 403, "你的角色不能改跟进项"), { status: 403 });
      /* 报告交上去之后跟进项冻结 —— 交上去的报告和台账对不上，
         比台账上少一项严重得多。 */
      if (r.v.state === "reported") return HttpResponse.json(
        problem("invariant-violated", 422,
          `${r.v.code} 的报告已提交，跟进项不能再改 —— 要改就出一份补充报告`),
        { status: 422 });
      const it = r.v.items.find(x => x.seq === seq);
      if (!it) return HttpResponse.json(
        problem("not-found", 404, "跟进项不存在"), { status: 404 });
      it.doneAt = b.done ? new Date().toISOString() : null;
      it.doneByName = b.done ? identity().name : null;
      return HttpResponse.json({ data: monitorDto(r.v), sideEffects: [] }, { status: 201 });
    }),

  http.post(pathToRegExp("/v1/monitor-visits/{id}:report"), async ({ request }) => {
    const r = findVisit(request.url, /\/monitor-visits\/([^/:]+):report/);
    if ("problem" in r) return r.problem;
    if (!identity().actions.includes("monitor")) return HttpResponse.json(
      problem("forbidden", 403, "你的角色不能提交监查报告"), { status: 403 });
    if (r.v.state === "reported") return HttpResponse.json(
      problem("invariant-violated", 422, `${r.v.code} 的报告已经提交过了`), { status: 422 });
    if (r.v.state !== "done") return HttpResponse.json(
      problem("invariant-violated", 422,
        `${r.v.code} 还没登记到现场 —— 没去过的访视写不出监查报告`), { status: 422 });
    const open = r.v.items.filter(i => i.doneAt === null);
    /* 拦的时候要说得出拦在哪几项 —— 一句「条件不满足」对要交报告的人没用。 */
    if (open.length) return HttpResponse.json(
      problem("invariant-violated", 422,
        `还有 ${open.length} 项跟进项未关闭，监查报告无法提交：` +
        open.slice(0, 5).map(i => i.task).join("；")), { status: 422 });
    r.v.state = "reported";
    r.v.reportSubmittedOn = TODAY_STR;
    const lag = mvrLagDays(
      { performedOn: r.v.performedOn, reportSubmittedOn: TODAY_STR }, TODAY_STR);
    return HttpResponse.json({
      data: monitorDto(r.v),
      sideEffects: [{ type: "MonitorReportSubmitted", ref: r.v.id,
        summary: `${r.v.code} 监查报告已提交，距现场 ${lag} 天` +
          (lag !== null && lag > MVR_DUE_DAYS ? ` —— 超过 ${MVR_DUE_DAYS} 天时限` : "") }]
    }, { status: 201 });
  }),

  /* ── 数据质疑 ────────────────────────────────────────────────────
     **外部方一条都看不到。** 这不是"外部方没有这个模块"那种柔性隔离 ——
     行策略上直接关掉（迁移 0032），因为机构办是外部的质量反馈闭环、
     DM 是内部的数据质量闭环，混在一起的后果不是多几行，而是
     机构质控页上「本院未关闭质量事件」这个数会把 EDC 质疑也算进去。 */
  http.get(pathToRegExp("/v1/data-queries"), ({ request }) => {
    const q = new URL(request.url).searchParams;
    let items = visibleQueries();
    const states = q.getAll("state");
    if (states.length) items = items.filter(x => states.includes(x.state));
    if (q.get("mine") === "true")
      items = items.filter(x => x.ownerAccountId === identity().id);
    /* 真接口按 raised_by_account 比对；mock 的行上没存账号 id，
       按姓名比是它的近似。**不要把这条当成规则本身** —— 规则在服务端。 */
    if (q.get("raisedByMe") === "true")
      items = items.filter(x => x.raisedByName === identity().name);
    if (q.get("staleOnly") === "true")
      items = items.filter(x => x.state === "open" && x.ageDays > QUERY_STALE_DAYS);
    /* 挂得最久的排最前 —— 与服务端同一条排序。 */
    items = [...items].sort((a, b) => b.ageDays - a.ageDays || a.code.localeCompare(b.code));
    return HttpResponse.json({ items: items.map(mask), nextCursor: null });
  }),

  http.get(pathToRegExp("/v1/data-queries/stats"), ({ request }) => {
    const q = new URL(request.url).searchParams;
    let rows = visibleQueries();
    if (q.get("mine") === "true")
      rows = rows.filter(x => x.ownerAccountId === identity().id);

    const bySite = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = bySite.get(r.studySiteId);
      if (list) list.push(r); else bySite.set(r.studySiteId, [r]);
    }
    const sites = [...bySite.entries()].map(([id, rs]) => {
      const d = siteQueryDensity({
        studySiteId: id,
        enrolled: FUNNELS.find(f => f.studySiteId === id)?.enrolled ?? 0,
        queries: rs.map(r => ({ ageDays: r.ageDays, state: r.state as never, form: r.form }))
      });
      return {
        ...d, siteCode: rs[0]!.siteCode, hospital: rs[0]!.hospital,
        verdict: densityVerdict(d)
      };
    }).sort((a, b) =>
      (b.perSubject ?? -1) - (a.perSubject ?? -1)
      || b.total - a.total || a.siteCode.localeCompare(b.siteCode));

    return HttpResponse.json({
      load: queryLoad(rows.map(r => ({ ageDays: r.ageDays, state: r.state as never }))),
      sites, calcVersion: CALC_VERSION
    });
  }),

  http.post(pathToRegExp("/v1/data-queries"), async ({ request }) => {
    const b = await request.json() as {
      subjectId?: string; form?: string; fieldName?: string; detail?: string;
    };
    if (!identity().actions.includes("raiseQ")) return HttpResponse.json(
      problem("forbidden", 403, "你的角色不能发起数据质疑"), { status: 403 });
    const su = scenario.subjects.find(x => x.id === b.subjectId);
    if (!su) return HttpResponse.json(
      problem("not-found", 404, "受试者不存在"), { status: 404 });
    if ((b.fieldName ?? "").trim().length < 2) return HttpResponse.json(
      problem("validation-failed", 422, "请求参数不符合契约：字段名至少 2 个字"),
      { status: 422 });
    if ((b.detail ?? "").trim().length < 10) return HttpResponse.json(
      problem("validation-failed", 422,
        "请求参数不符合契约：质疑内容需写清疑点与要求核实的方向（至少 10 个字）"),
      { status: 422 });
    /* 责任 CRC 从受试者取，并在这一刻固化。取不到就不给建 ——
       无人认领的质疑等于没提。 */
    if (!su.crcName) return HttpResponse.json(
      problem("invariant-violated", 422,
        `${su.screeningNo} 还没有责任 CRC —— 请先指派，否则这条质疑没有人认领`),
      { status: 422 });

    const site = SITES_LIST.find(x => x.id === su.studySiteId)!;
    const row: MockQuery = {
      id: `q-${scenario.dataQueries.length + 1}`,
      code: `Q-${1191 + scenario.dataQueries.length}`,
      studySiteId: site.id, siteCode: site.code, hospital: site.hospital,
      studyShortName: "艾瑞替尼 III",
      subjectId: su.id, screeningNo: su.screeningNo,
      form: b.form!, fieldName: b.fieldName!.trim(), detail: b.detail!.trim(),
      severity: "minor", state: "open",
      raisedBy: identity().role.code === "dm" ? "dm" : "cra",
      raisedByName: identity().name, raisedOn: TODAY_STR,
      ownerAccountId: null, ownerName: su.crcName,
      answer: null, answeredOn: null, returnedReason: null,
      chaseCount: 0, lastChasedOn: null,
      closedAt: null, resolution: null, ageDays: 0, stale: false
    };
    scenario.dataQueries.unshift(row);
    return HttpResponse.json({
      data: mask(row),
      sideEffects: [{ type: "DataQueryRaised", ref: row.id,
        summary: `${row.code} 已发起，指派给 ${su.crcName}（${row.form} · ${row.fieldName}）` }]
    }, { status: 201 });
  }),

  http.post(pathToRegExp("/v1/data-queries/{id}:answer"), async ({ request }) => {
    const r = findQuery(request.url, /\/data-queries\/([^/:]+):answer/);
    if ("problem" in r) return r.problem;
    const b = await request.json() as { answer?: string };
    if (!identity().actions.includes("subjWrite")) return HttpResponse.json(
      problem("forbidden", 403, "你的角色不能回复数据质疑"), { status: 403 });
    if ((b.answer ?? "").trim().length < 10) return HttpResponse.json(
      problem("validation-failed", 422,
        "请求参数不符合契约：回复需写清核实结果与源数据依据（至少 10 个字）"),
      { status: 422 });
    if (r.q.state !== "open") return HttpResponse.json(
      problem("invariant-violated", 422, `${r.q.code} 不在「待中心回复」`), { status: 422 });
    r.q.state = "pending_review";
    r.q.answer = b.answer!.trim();
    r.q.answeredOn = TODAY_STR;
    r.q.stale = false;
    return HttpResponse.json({
      data: mask(r.q),
      sideEffects: [{ type: "DataQueryAnswered", ref: r.q.id,
        summary: `${r.q.code} 已回复，挂起 ${r.q.ageDays} 天 —— 等数据管理判定；回复了不等于关闭了` }]
    }, { status: 201 });
  }),

  http.post(pathToRegExp("/v1/data-queries/{id}:close"), async ({ request }) => {
    const r = findQuery(request.url, /\/data-queries\/([^/:]+):close/);
    if ("problem" in r) return r.problem;
    const b = await request.json() as { reason?: string };
    /* **closeQ，不是 closeQA。** 质量事件的关闭门管不到数据质疑，
       反过来也一样 —— 两条线共用一张表，但不共用一个动作。 */
    if (!identity().actions.includes("closeQ")) return HttpResponse.json(
      problem("forbidden", 403, "只有数据管理能关闭数据质疑"), { status: 403 });
    if (!b.reason || b.reason.trim().length < 4) return HttpResponse.json(
      problem("validation-failed", 422, "请求参数不符合契约：判定说明至少 4 个字"),
      { status: 422 });
    if (r.q.state !== "pending_review") return HttpResponse.json(
      problem("invariant-violated", 422,
        `${r.q.code} 中心还没有回复 —— 关掉它等于把问题从列表上抹掉，而不是解决`),
      { status: 422 });
    r.q.state = "closed";
    r.q.closedAt = new Date().toISOString();
    r.q.resolution = b.reason.trim();
    r.q.stale = false;
    return HttpResponse.json({
      data: mask(r.q),
      sideEffects: [{ type: "DataQueryClosed", ref: r.q.id,
        summary: `${r.q.code} 已关闭，共挂起 ${r.q.ageDays} 天` }]
    }, { status: 201 });
  }),

  http.post(pathToRegExp("/v1/data-queries/{id}:return"), async ({ request }) => {
    const r = findQuery(request.url, /\/data-queries\/([^/:]+):return/);
    if ("problem" in r) return r.problem;
    const b = await request.json() as { reason?: string };
    if (!identity().actions.includes("closeQ")) return HttpResponse.json(
      problem("forbidden", 403, "只有数据管理能退回数据质疑"), { status: 403 });
    if (!b.reason || b.reason.trim().length < 4) return HttpResponse.json(
      problem("validation-failed", 422, "请求参数不符合契约：退回理由至少 4 个字"),
      { status: 422 });
    if (r.q.state !== "pending_review") return HttpResponse.json(
      problem("invariant-violated", 422, `${r.q.code} 没有可退回的回复`), { status: 422 });
    r.q.state = "open";
    r.q.returnedReason = b.reason.trim();
    r.q.stale = r.q.ageDays > QUERY_STALE_DAYS;
    return HttpResponse.json({
      data: mask(r.q),
      sideEffects: [{ type: "DataQueryReturned", ref: r.q.id,
        summary: `${r.q.code} 已退回 ${r.q.ownerName} —— ${b.reason.trim()}` }]
    }, { status: 201 });
  }),

  http.post(pathToRegExp("/v1/data-queries/{id}:chase"), async ({ request }) => {
    const r = findQuery(request.url, /\/data-queries\/([^/:]+):chase/);
    if ("problem" in r) return r.problem;
    const b = await request.json() as { reason?: string };
    if (!identity().actions.includes("raiseQ")) return HttpResponse.json(
      problem("forbidden", 403, "你的角色不能催办"), { status: 403 });
    if (!b.reason || b.reason.trim().length < 4) return HttpResponse.json(
      problem("validation-failed", 422, "请求参数不符合契约：催办记录至少 4 个字"),
      { status: 422 });
    if (r.q.state !== "open") return HttpResponse.json(
      problem("invariant-violated", 422,
        `${r.q.code} 不在「待中心回复」 —— 现在球不在中心那边`), { status: 422 });
    r.q.chaseCount += 1;
    r.q.lastChasedOn = TODAY_STR;
    return HttpResponse.json({
      data: mask(r.q),
      sideEffects: [{ type: "DataQueryChased", ref: r.q.id,
        summary: `已记录对 ${r.q.hospital} 的第 ${r.q.chaseCount} 次催办：${r.q.code}` +
          (r.q.chaseCount >= 3
            ? " —— 催到第三次还没回，该升级到 PM 而不是再打一个电话" : "") }]
    }, { status: 201 });
  }),

  /* 备案名册。行范围**在这里也要收** —— 这一页整页的内容就是
     "我这几个中心上有谁"，不收就成了"全公司的人"。
     而且中心列表要按范围重算：机构办不该数得出这个 CRC
     在别家医院还带着几个。 */
  http.get(pathToRegExp("/v1/site-staff"), ({ request }) => {
    const q = new URL(request.url).searchParams;
    const ids = visibleSiteIds();
    let items = SITE_STAFF
      .map(p => ({ ...p, sites: p.sites.filter(x => ids.has(x.id)) }))
      .filter(p => p.sites.length > 0);
    const kind = q.get("roleKind");
    if (kind) items = items.filter(p => p.roleKind === kind);
    const site = q.get("studySiteId");
    if (site) items = items
      .map(p => ({ ...p, sites: p.sites.filter(x => x.id === site) }))
      .filter(p => p.sites.length > 0);
    if (q.get("gcpProblem") === "true")
      items = items.filter(p => p.gcpDaysLeft === null || p.gcpDaysLeft <= 60);
    return HttpResponse.json({ items, nextCursor: null });
  }),

  /* 项目列表。**在此之前它没有场景层处理器** —— 落到契约兜底层，
     回的是 examples.json 里那份静态示例，于是它给出的 `id`
     跟 `scenario.studies` 里的 st1 / st2 对不上。

     没有任何一个页面因此报错：中心建档、递交立项材料这两张表
     照样有下拉可选，选了也照样提交成功 —— 只是挂到了一个
     库里不存在的项目上。这类"看起来全对"的错，
     只有让两边用同一份数据才防得住。 */
  http.get(pathToRegExp("/v1/studies"), () => {
    /* 外部方（机构办 / PI）看不到项目全表 —— 与立项看板同一条口径。 */
    const items = (identity().isExternal ? [] : scenario.studies).map(st => ({
      id: st.id, code: st.code, shortName: st.shortName,
      sponsorName: st.clientName, phase: st.phase,
      indication: "非小细胞肺癌", plannedSubjects: st.plannedSubjects,
      startedOn: "2024-11-01", endsOn: null,
      ...(identity().fields.includes("price")
        ? { contractAmountCents: st.contractCents } : {})
    }));
    return HttpResponse.json({ items, nextCursor: null });
  }),

  http.get(pathToRegExp("/v1/study-sites"), ({ request }) => {
    const only = new URL(request.url).searchParams.get("startupInvalidated");
    const items = visibleSites().map(s => siteDto(s.id)!)
      .filter(s => only === null || s.startupInvalidated === (only === "true"));
    return HttpResponse.json({ items, nextCursor: null });
  }),

  /* 中心建档。**要有状态** —— 兜底层会回一份静态示例，
     于是"建完之后台账上多一行"这件事在 mock 下看不出来，
     而那正是这个表单唯一要证明的事。 */
  http.post(pathToRegExp("/v1/study-sites"), async ({ request }) => {
    const b = await request.json() as {
      code: string; hospital: string; dept: string; city: string; piName: string;
      contracted: number; unitPriceCents?: number; startupFeeCents?: number;
      sivPlannedOn?: string | null;
    };
    if (SITES_LIST.some(s => s.code === b.code))
      return HttpResponse.json(
        problem("invariant-violated", 422, `中心编号 ${b.code} 已存在`), { status: 422 });

    const site = {
      id: `s-new-${SITES_LIST.length + 1}`, code: b.code,
      hospital: b.hospital, dept: b.dept, city: b.city,
      piName: b.piName, piAccountId: null,
      /* 建档出来的中心停在「合同签署」—— 与后端一致。
         推进要走 :advance，而那要先过启动清单的闸门。 */
      state: "contract", contracted: b.contracted,
      ...(b.unitPriceCents !== undefined ? { unitPriceCents: b.unitPriceCents } : {}),
      ...(b.startupFeeCents !== undefined ? { startupFeeCents: b.startupFeeCents } : {}),
      sivPlannedOn: b.sivPlannedOn ?? null
    };
    SITES_LIST.push(site);
    return HttpResponse.json(siteDto(site.id), { status: 201 });
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
    /* 范围之外与不存在**同样是 404**（规约 I2）。 */
    const dto = siteInScope(id) ? siteDto(id) : null;
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

  /* ── 中心可行性调查 ────────────────────────────────────────────
     **评分走 @sitedesk/calc，mock 不另写一份。** 在 mock 里手搓一遍
     等于给这套口径开了第三个入口（服务端、calc、mock），
     而三套迟早分叉 —— 分叉那天，一家医院会因为看哪个页面拿到不同的结论。 */
  http.get(pathToRegExp("/v1/feasibility/calibration"), () => {
    const sel = scenario.feasibility.filter(f => f.status === "selected");
    const rows = sel.map(feasDto);
    const withActual = rows.filter(x => x.bias !== null);
    const overrides = rows.filter(x => x.score.total < 65);
    return HttpResponse.json({
      selected: withActual.length,
      meanBias: withActual.length
        ? withActual.reduce((n, x) => n + x.bias!, 0) / withActual.length : null,
      overrides: overrides.length,
      overridesGoneBad: overrides.filter(
        x => x.actualRate !== null && x.actualRate < 1).length,
      calcVersion: CALC_VERSION
    });
  }),

  http.get(pathToRegExp("/v1/feasibility"), ({ request }) => {
    const q = new URL(request.url).searchParams;
    let items = scenario.feasibility.map(feasDto);
    const status = q.getAll("status");
    if (status.length) items = items.filter(f => status.includes(f.status));
    if (q.get("overrideOnly") === "true")
      items = items.filter(f => f.status === "selected" && f.score.total < 65);
    return HttpResponse.json({ items, nextCursor: null });
  }),

  http.post(pathToRegExp("/v1/feasibility/{id}:decide"), async ({ request }) => {
    const id = seg(request.url, /\/feasibility\/([^/:]+):decide/);
    const b = await request.json() as { decision: string; reason?: string };
    const f = scenario.feasibility.find(x => x.id === id);
    if (!f) return HttpResponse.json(
      problem("not-found", 404, "可行性调查不存在"), { status: 404 });
    if (!identity().actions.includes("bid")) return HttpResponse.json(
      problem("forbidden", 403, "你的角色不能定选址"), { status: 403 });
    if (f.status !== "assessing") return HttpResponse.json(
      problem("invariant-violated", 422,
        `${f.code} 已经定过了 —— 决定不能改，要改就重新做一次调查`), { status: 422 });

    const score = feasibilityScore(f.answers);
    const reason = (b.reason ?? "").trim();
    /* **低分入选不拦，但必须写理由。** mock 上放行一次真库会拒的提交，
       等于把这条规则藏到集成测试才暴露 —— 而这条规则正是这一页的核心。 */
    const needsReason = b.decision === "rejected" || score.total < 65;
    if (needsReason && reason.length < 4) return HttpResponse.json(
      problem("validation-failed", 422, b.decision === "rejected"
        ? "拒绝必须写理由 —— 申办方问「为什么没选这家」时，「评分不够」不是答案"
        : `${f.code} 评分 ${Math.round(score.total)} 分，低于 65 分。` +
          "入选它不被阻止，但必须写下理由"), { status: 422 });

    f.status = b.decision as MockFeas["status"];
    f.decidedOn = todayStr();
    f.decidedByName = identity().name;
    f.overrideReason = b.decision === "selected" && reason ? reason : null;
    f.rejectReason = b.decision === "rejected" ? reason : null;

    const sideEffects = b.decision === "selected" && score.total < 65
      ? [{ type: "FeasibilityOverride",
           summary: `${f.hospital} 评分 ${Math.round(score.total)} 分入选 —— ` +
             `预测月入组约 ${score.predictedPerMonth.toFixed(1)} 例，理由已记入审计轨迹`,
           ref: f.id }]
      : [];
    return HttpResponse.json({ data: feasDto(f), sideEffects }, { status: 201 });
  }),

  http.post(pathToRegExp("/v1/feasibility/{id}:actual"), async ({ request }) => {
    const id = seg(request.url, /\/feasibility\/([^/:]+):actual/);
    const b = await request.json() as { actualRate: number };
    const f = scenario.feasibility.find(x => x.id === id);
    if (!f) return HttpResponse.json(
      problem("not-found", 404, "可行性调查不存在"), { status: 404 });
    if (f.status !== "selected") return HttpResponse.json(
      problem("invariant-violated", 422,
        `${f.code} 没有入选 —— 只有入选的中心谈得上实际入组速度`), { status: 422 });
    f.actualRate = b.actualRate;
    const dto = feasDto(f);
    const sideEffects = dto.bias !== null && (dto.bias < 0.5 || dto.bias > 2)
      ? [{ type: "FeasibilityBias",
           summary: `实际是预测的 ${(dto.bias * 100).toFixed(0)}%`, ref: f.id }]
      : [];
    return HttpResponse.json({ data: dto, sideEffects }, { status: 201 });
  }),

  /* ── 投标 ────────────────────────────────────────────────────── */
  http.get(pathToRegExp("/v1/bids/review"), () =>
    HttpResponse.json(mask({
      ...reviewBids(scenario.bids.map(b => ({
        status: b.status, ourQuoteCents: b.ourQuoteCents,
        ourPersonDays: b.ourPersonDays, subjects: b.subjects,
        winningPriceCents: b.winningPriceCents
      }))),
      calcVersion: CALC_VERSION
    }))),

  http.get(pathToRegExp("/v1/bids"), ({ request }) => {
    const q = new URL(request.url).searchParams;
    let items = scenario.bids.map(bidDto);
    const status = q.getAll("status");
    if (status.length) items = items.filter(b => status.includes(b.status));
    return HttpResponse.json({ items, nextCursor: null });
  }),

  http.post(pathToRegExp("/v1/bids/{id}:decide"), async ({ request }) => {
    const id = seg(request.url, /\/bids\/([^/:]+):decide/);
    const b = await request.json() as
      { result: string; winningPriceCents?: number | null };
    const bid = scenario.bids.find(x => x.id === id);
    if (!bid) return HttpResponse.json(
      problem("not-found", 404, "投标不存在"), { status: 404 });
    if (!identity().actions.includes("bid")) return HttpResponse.json(
      problem("forbidden", 403, "你的角色不能回写开标结果"), { status: 403 });
    if (bid.status !== "pending") return HttpResponse.json(
      problem("invariant-violated", 422, `${bid.code} 已经出过结果了`), { status: 422 });

    const win = b.winningPriceCents ?? null;
    /* **中标必须知道自己签了多少** —— 那个数就在合同上。 */
    if (b.result === "won" && win === null) return HttpResponse.json(
      problem("validation-failed", 422,
        "中标必须填成交价 —— 不填的话这一标永远进不了报价偏差统计"), { status: 422 });

    bid.status = b.result as MockBid["status"];
    bid.decidedOn = todayStr();
    bid.winningPriceCents = win;

    const gap = win !== null && win > 0
      ? (bid.ourQuoteCents - win) / win : null;
    const sideEffects = gap !== null && Math.abs(gap) >= 0.15
      ? [{ type: "BidDecided",
           summary: gap > 0
             ? `我们比成交价高 ${(gap * 100).toFixed(0)}% —— 去「报价偏差复盘」看看是不是系统性的`
             : `我们比成交价低 ${(-gap * 100).toFixed(0)}% —— 报低了同样要查`,
           ref: bid.id }]
      : b.result === "lost" && win === null
        ? [{ type: "BidDecided",
             summary: "没有成交价，这一标不进偏差统计 —— " +
               "「不知道对方报了多少」不会被当成「和我们一样」",
             ref: bid.id }]
        : [];
    return HttpResponse.json({ data: bidDto(bid), sideEffects }, { status: 201 });
  }),

  /* ── 合同变更 ─────────────────────────────────────────────────── */
  http.get(pathToRegExp("/v1/contract-changes/scope-creep"), () =>
    HttpResponse.json(mask({
      ...scopeCreep(scenario.changes.map(c => ({
        status: c.status, personDaysImpact: c.personDaysImpact,
        perSubject: c.perSubject, affectedSubjects: c.affectedSubjects,
        amountCents: c.amountCents
      })), crcDayCost()),
      calcVersion: CALC_VERSION
    }))),

  http.get(pathToRegExp("/v1/contract-changes"), ({ request }) => {
    const q = new URL(request.url).searchParams;
    let items = scenario.changes.map(changeDto);
    const status = q.getAll("status");
    if (status.length) items = items.filter(c => status.includes(c.status));
    if (q.get("uncoveredOnly") === "true")
      items = items.filter(c => c.status !== "signed");
    return HttpResponse.json({ items, nextCursor: null });
  }),

  http.post(pathToRegExp("/v1/contract-changes/{id}:settle"), async ({ request }) => {
    const id = seg(request.url, /\/contract-changes\/([^/:]+):settle/);
    const b = await request.json() as
      { status: string; settledCents?: number | null };
    const c = scenario.changes.find(x => x.id === id);
    if (!c) return HttpResponse.json(
      problem("not-found", 404, "变更单不存在"), { status: 404 });
    if (!identity().actions.includes("bid")) return HttpResponse.json(
      problem("forbidden", 403, "你的角色不能推进变更单"), { status: 403 });
    if (["signed", "rejected"].includes(c.status)) return HttpResponse.json(
      problem("invariant-violated", 422, `${c.code} 已经了结了`), { status: 422 });

    /* **签署必须填金额，哪怕是 0。** 0 是「谈过了对方不给」，
       不填是「还没谈」—— 前者是决策，后者是欠账。 */
    const amount = b.settledCents ?? null;
    if (b.status === "signed" && amount === null) return HttpResponse.json(
      problem("validation-failed", 422,
        "签署必须填金额，哪怕是 0 —— 0 表示「谈过了对方不给」，不填表示「还没谈」"),
      { status: 422 });

    c.status = b.status as MockChange["status"];
    c.decidedOn = ["signed", "rejected"].includes(b.status) ? todayStr() : null;
    if (b.status === "signed") c.amountCents = amount;

    const total = changeDays({
      status: c.status, personDaysImpact: c.personDaysImpact,
      perSubject: c.perSubject, affectedSubjects: c.affectedSubjects,
      amountCents: c.amountCents
    });
    const sideEffects = b.status === "rejected"
      ? [{ type: "ScopeCreepRecorded",
           summary: `${c.kindLabel}未获批 —— ${total.toFixed(1)} 人天没有对应金额。` +
             "下次报价时这就是该加进去的成本",
           ref: c.id }]
      : [];
    return HttpResponse.json({ data: changeDto(c), sideEffects }, { status: 201 });
  }),

  /* ── 里程碑 · 客户 · 现金流 ─────────────────────────────────── */
  http.get(pathToRegExp("/v1/milestones/plan"), () =>
    HttpResponse.json({ items: MS_PLAN })),

  http.get(pathToRegExp("/v1/milestones/ar-aging"), () =>
    HttpResponse.json(mask({
      ...arAging(scenario.milestones
        .filter(m => m.state === "invoiced")
        .map(m => ({
          amountCents: m.milestoneCents,
          daysToDue: daysApart(todayStr(), m.dueOn!)
        }))),
      calcVersion: CALC_VERSION
    }))),

  http.get(pathToRegExp("/v1/milestones"), ({ request }) => {
    const q = new URL(request.url).searchParams;
    let rows = scenario.milestones.slice();
    const state = q.getAll("state");
    if (state.length) rows = rows.filter(m => state.includes(m.state));
    if (q.get("receivableOnly") === "true")
      rows = rows.filter(m => m.state === "invoiced");
    if (q.get("overdueOnly") === "true")
      rows = rows.filter(m =>
        m.state === "invoiced" && daysApart(todayStr(), m.dueOn!) < 0);
    /* **逾期最久的排最前，已回款的沉到最后** —— 与服务端同一条排序。 */
    rows.sort((a, b) =>
      Number(a.state === "paid") - Number(b.state === "paid")
      || (a.dueOn ?? "9999").localeCompare(b.dueOn ?? "9999")
      || b.reachedOn.localeCompare(a.reachedOn));
    return HttpResponse.json({ items: rows.map(msDto), nextCursor: null });
  }),

  http.post(pathToRegExp("/v1/milestones/{id}:invoice"), ({ request }) => {
    const id = seg(request.url, /\/milestones\/([^/:]+):invoice/);
    const m = scenario.milestones.find(x => x.id === id);
    if (!m) return HttpResponse.json(
      problem("not-found", 404, "里程碑不存在"), { status: 404 });
    if (!identity().actions.includes("bid")) return HttpResponse.json(
      problem("forbidden", 403, "你的角色不能开票"), { status: 403 });
    if (m.state !== "pending") return HttpResponse.json(
      problem("invariant-violated", 422, `${m.code} 已经开过票了`), { status: 422 });

    /* 到期日 = 今天 + **客户账期**，算出来就固化 —— 客户之后改账期不回溯。 */
    const terms = CLIENTS.find(c => c.name === m.clientName)?.paymentTermsDays ?? 60;
    m.state = "invoiced";
    m.invoicedOn = todayStr();
    m.dueOn = shiftStr(todayStr(), terms);
    return HttpResponse.json({
      data: msDto(m),
      sideEffects: [{ type: "MilestoneReached",
        summary: `${m.code} 已开票，账期 ${terms} 天 —— ${m.dueOn} 到期`, ref: m.id }]
    }, { status: 201 });
  }),

  http.post(pathToRegExp("/v1/milestones/{id}:pay"), ({ request }) => {
    const id = seg(request.url, /\/milestones\/([^/:]+):pay/);
    const m = scenario.milestones.find(x => x.id === id);
    if (!m) return HttpResponse.json(
      problem("not-found", 404, "里程碑不存在"), { status: 404 });
    if (!identity().actions.includes("bid")) return HttpResponse.json(
      problem("forbidden", 403, "你的角色不能登记回款"), { status: 403 });
    if (m.state === "pending") return HttpResponse.json(
      problem("invariant-violated", 422, `${m.code} 还没开票 —— 没有票的钱记不进来`),
      { status: 422 });
    /* **已回款的不能改回去** —— 钱到账是不可撤销的事实。 */
    if (m.state === "paid") return HttpResponse.json(
      problem("invariant-violated", 422,
        `${m.code} 已经登记过回款了 —— 钱到账是不可撤销的事实，写错了要走冲销`),
      { status: 422 });

    const late = daysApart(m.dueOn!, todayStr());
    m.state = "paid";
    m.paidOn = todayStr();
    return HttpResponse.json({
      data: msDto(m),
      sideEffects: [{ type: "MilestoneReached",
        summary: late > 0 ? `${m.code} 已回款，比约定晚了 ${late} 天` : `${m.code} 已回款`,
        ref: m.id }]
    }, { status: 201 });
  }),

  http.get(pathToRegExp("/v1/clients"), () =>
    HttpResponse.json({
      items: CLIENTS.map(c => {
        const ms = scenario.milestones.filter(m => m.clientName === c.name);
        const open = ms.filter(m => m.state === "invoiced");
        return mask({
          ...c,
          paidCents: ms.filter(m => m.state === "paid")
            .reduce((n, m) => n + m.milestoneCents, 0),
          receivableCents: open.reduce((n, m) => n + m.milestoneCents, 0),
          overdueCents: open
            .filter(m => daysApart(todayStr(), m.dueOn!) < 0)
            .reduce((n, m) => n + m.milestoneCents, 0),
          /* 没有在途应收时是 null，不是 0。 */
          meanArDays: open.length
            ? open.reduce((n, m) => n + daysApart(m.invoicedOn!, todayStr()), 0) / open.length
            : null
        });
      }),
      nextCursor: null
    })),

  http.patch(pathToRegExp("/v1/clients/{id}"), async ({ request }) => {
    const id = seg(request.url, /\/clients\/([^/?]+)/);
    const b = await request.json() as
      { paymentTermsDays?: number; note?: string | null };
    const c = CLIENTS.find(x => x.id === id);
    if (!c) return HttpResponse.json(
      problem("not-found", 404, "客户不存在"), { status: 404 });
    if (!identity().actions.includes("manage")) return HttpResponse.json(
      problem("forbidden", 403, "你的角色不能改客户档案"), { status: 403 });
    if (b.paymentTermsDays !== undefined) c.paymentTermsDays = b.paymentTermsDays;
    if (b.note !== undefined) c.note = b.note;
    /* **不动任何已开出去的票** —— 到期日在开票那一刻就固化了。 */
    return HttpResponse.json(mask({ ...c,
      paidCents: 0, receivableCents: 0, overdueCents: 0, meanArDays: null }));
  }),

  http.get(pathToRegExp("/v1/cash-forecast"), ({ request }) => {
    const n = Number(new URL(request.url).searchParams.get("months") ?? 6);
    const ins: CashIn[] = [];
    let recordGapCents = 0, recordGapCount = 0;
    for (const m of scenario.milestones) {
      if (m.state === "paid") continue;
      if (m.state === "invoiced" && m.dueOn) {
        const d = daysApart(todayStr(), m.dueOn);
        ins.push({
          amountCents: m.milestoneCents,
          month: Math.max(1, Math.ceil(d / DAYS_PER_MONTH)),
          label: `${m.code} ${m.hospital} ${m.planLabel}`,
          kind: d < 0 ? "overdue" : "invoiced"
        });
      } else {
        /* 待开票：**它是已经发生的事实**（里程碑达成了），只是流程没走完。
           所以进现金，但同时也是"记录缺口"要提醒的那一笔。 */
        ins.push({
          amountCents: m.milestoneCents, month: Math.min(3, n),
          label: `${m.code} ${m.hospital} ${m.planLabel}（待开票）`, kind: "pending"
        });
        recordGapCents += m.milestoneCents; recordGapCount++;
      }
    }
    /* 每月刚性支出：在职人力 × 现行费率 × 月均工作日。 */
    const day = crcDayCost();
    const heads = STAFF_LIST.filter(s => s.active);
    const burn = roundCents(heads.length * day * WORKDAYS_PER_MONTH);
    const t = todayStr();
    const f = cashFlow(ins, burn, n, t.slice(0, 7), recordGapCents);
    const toMonth = (m: typeof f.months[number]) => ({
      month: m.month, inCents: m.inCents, outCents: m.outCents,
      netCents: m.netCents, cumCents: m.cumCents,
      items: m.items.map(i =>
        ({ label: i.label, inflowCents: i.amountCents, kind: i.kind }))
    });
    return HttpResponse.json(mask({
      months: f.months.map(toMonth),
      burnCents: f.burnCents, headcount: heads.length,
      troughCents: f.troughCents, troughMonth: f.troughMonth,
      stress: {
        months: f.stress.months.map(toMonth),
        troughCents: f.stress.troughCents, troughMonth: f.stress.troughMonth
      },
      recordGapCents, recordGapCount, calcVersion: CALC_VERSION
    }));
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

  /* 全部中心的损益。**走同一个 pnlFor** —— mock 里为汇总另写一遍
     I8' 的话，这个系统就有了第四套口径（服务端、calc、mock 单中心、
     mock 汇总），而"汇总页和详情页对不上"正是它最先长出来的样子。 */
  http.get(pathToRegExp("/v1/pnl"), ({ request }) => {
    const q = new URL(request.url).searchParams;
    let items = visibleSites()
      .map(x => { const dto = siteDto(x.id); return dto ? pnlFor(x.id, dto) : null; })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    if (q.get("lossOnly") === "true")
      items = items.filter(x => typeof x.grossProfitCents === "number"
        && x.grossProfitCents < 0);
    return HttpResponse.json({ items, nextCursor: null });
  }),

  /* ── 入组漏斗 ────────────────────────────────────────────────────
     三个中心造出三种形状，因为这两页要回答的正是"哪一种"：
       SS-01 预筛多、筛败高 —— 要谈方案修订
       SS-07 预筛少、转化好 —— 要加招募渠道
       SS-14 一例都没有   —— 不是入组慢，是还没真正启动
     全给一样的数的话，页面画得出来，但它想说的话一句也说不出来。 */
  http.get(pathToRegExp("/v1/enrollment"), ({ request }) => {
    const q = new URL(request.url).searchParams;
    const all = inScope(FUNNELS);
    const items = q.get("behindOnly") === "true"
      ? all.filter(f => f.enrolled < f.contracted) : all;
    return HttpResponse.json({ items, nextCursor: null });
  }),

  /* ── 审计轨迹 ──────────────────────────────────────────────────── */
  http.get(pathToRegExp("/v1/audit-entries"), ({ request }) => {
    const q = new URL(request.url).searchParams;
    let items = AUDIT_ENTRIES;
    /* 显式比 "false" —— `q.get(...)` 拿到的是字符串，
       而非空字符串一律为真：`if (q.get("sensitiveOnly"))` 会让
       `?sensitiveOnly=false` 也去筛。这正是 QueryBool 那条欠账的形状。 */
    if (q.get("sensitiveOnly") === "true") items = items.filter(e => e.isSensitive);
    const actor = q.get("actorLogin");
    if (actor) items = items.filter(e => e.actorLogin === actor);
    return HttpResponse.json({ items, nextCursor: null });
  }),

  /* ── 受试者 ──────────────────────────────────────────────────────
     筛选号受列权限管辖：**没权限时把字段删掉**，不是置 null。
     mock 里也要照做 —— 置 null 的话前端会写成 `?? "—"`，
     到了真库上那个字段根本不在，`undefined ?? "—"` 也是 "—"，
     看起来一样；但"整列不画"和"画一列横杠"是两种不同的界面，
     而只有真库那一侧会暴露出来。 */
  http.get(pathToRegExp("/v1/subjects"), ({ request }) => {
    const q = new URL(request.url).searchParams;
    let items = inScope(scenario.subjects).map(maskSubject);
    const states = q.getAll("state");
    if (states.length) items = items.filter(x => states.includes(x.state));
    const site = q.get("studySiteId");
    if (site) items = items.filter(x => x.studySiteId === site);
    if (q.get("outOfWindow") === "true")
      items = items.filter(x => x.nextVisit?.outOfWindow);
    return HttpResponse.json({ items, nextCursor: null });
  }),

  http.post(pathToRegExp("/v1/subjects"), async ({ request }) => {
    const b = await request.json() as { studySiteId: string; screeningNo: string };
    if (scenario.subjects.some(x => x.screeningNo === b.screeningNo))
      return HttpResponse.json(problem("invariant-violated", 422,
        `筛选号 ${b.screeningNo} 在这个中心已经用过了`), { status: 422 });
    const site = SITES_LIST.find(x => x.id === b.studySiteId);
    const s = {
      id: `u-${scenario.subjects.length + 1}`, studySiteId: b.studySiteId,
      siteCode: site?.code ?? "SS-??", screeningNo: b.screeningNo,
      randomized: false, randomizationNo: null, state: "prescreen",
      icfSignedOn: null, enrolledOn: null, exitedOn: null,
      screenFailReason: null, withdrawReason: null, crcName: me().account.displayName,
      visitsDone: 0, visitsPlanned: 0, nextVisit: null
    };
    scenario.subjects.push(s);
    return HttpResponse.json(maskSubject(s), { status: 201 });
  }),

  http.post(pathToRegExp("/v1/subjects/{id}:sign-icf"), async ({ request }) => {
    const s = subjectFrom(request, /\/subjects\/([^/:]+):sign-icf/);
    if (!s) return notFoundSubject();
    const b = await request.json() as { signedOn: string };
    if (b.signedOn > todayStr())
      return HttpResponse.json(problem("invariant-violated", 422,
        "知情签署日不能晚于今天"), { status: 422 });
    s.icfSignedOn = b.signedOn; s.state = "screening";
    s.visitsPlanned = 8; s.visitsDone = 0;
    return HttpResponse.json({ data: maskSubject(s), sideEffects: [
      { type: "ScreeningVisitsScheduled", summary: "已按 SOA 生成筛选期访视窗口" }
    ] }, { status: 201 });
  }),

  http.post(pathToRegExp("/v1/subjects/{id}:enroll"), async ({ request }) => {
    const s = subjectFrom(request, /\/subjects\/([^/:]+):enroll/);
    if (!s) return notFoundSubject();
    const b = await request.json() as { randomizationNo: string; enrolledOn: string };
    s.state = "enrolled"; s.randomized = true;
    s.randomizationNo = b.randomizationNo; s.enrolledOn = b.enrolledOn;
    return HttpResponse.json({ data: maskSubject(s), sideEffects: [
      { type: "SubjectEnrolled", summary: `已入组，随机号 ${b.randomizationNo}` }
    ] }, { status: 201 });
  }),

  http.post(pathToRegExp("/v1/subjects/{id}:screen-fail"), async ({ request }) => {
    const s = subjectFrom(request, /\/subjects\/([^/:]+):screen-fail/);
    if (!s) return notFoundSubject();
    const b = await request.json() as { reason: string; failedOn: string };
    s.state = "screen_failed"; s.screenFailReason = b.reason;
    s.exitedOn = b.failedOn; s.nextVisit = null;
    return HttpResponse.json({ data: maskSubject(s), sideEffects: [
      /* 筛败不是失败，是收入 —— 副作用里要说出来 */
      { type: "ScreenFailFeeAccrued", summary: "筛败补偿已计入收入（I8′）" }
    ] }, { status: 201 });
  }),

  /* ── 受试者补偿 ────────────────────────────────────────────────── */
  http.get(pathToRegExp("/v1/subject-payments"), ({ request }) => {
    const q = new URL(request.url).searchParams;
    let items = scenario.payments.map(maskPayment);
    if (q.get("unpaid") === "true") items = items.filter(p => !p.paidOn);
    return HttpResponse.json({ items, nextCursor: null });
  }),

  http.post(pathToRegExp("/v1/subject-payments/{id}:pay"), async ({ request }) => {
    const [, id] = new URL(request.url).pathname
      .match(/\/subject-payments\/([^/:]+):pay/) ?? [];
    const p = scenario.payments.find(x => x.id === id);
    if (!p) return HttpResponse.json(problem("not-found", 404, "补偿记录不存在"), { status: 404 });
    const b = await request.json() as { paidOn: string; receiptRef: string };
    p.paidOn = b.paidOn; p.receiptRef = b.receiptRef;
    return HttpResponse.json({ data: maskPayment(p), sideEffects: [] }, { status: 201 });
  }),

  /* ── 伦理递交 ──────────────────────────────────────────────────── */
  http.get(pathToRegExp("/v1/study-sites/{id}/regulatory-submissions"), ({ request }) => {
    const [, id] = new URL(request.url).pathname
      .match(/\/study-sites\/([^/]+)\/regulatory-submissions/) ?? [];
    return HttpResponse.json({
      items: scenario.submissions.filter(x => x.studySiteId === id), nextCursor: null });
  }),

  http.post(pathToRegExp("/v1/study-sites/{id}/regulatory-submissions"), async ({ request }) => {
    const [, id] = new URL(request.url).pathname
      .match(/\/study-sites\/([^/]+)\/regulatory-submissions/) ?? [];
    const b = await request.json() as
      { kind: string; submittedOn: string; refNo?: string; note?: string };
    const x = {
      id: `sub-${scenario.submissions.length + 1}`, studySiteId: id!,
      kind: b.kind, submittedOn: b.submittedOn,
      /* **递交了不等于批下来了** —— 新建的一律 pending */
      decision: "pending", decidedOn: null,
      refNo: b.refNo ?? null, note: b.note ?? null
    };
    scenario.submissions.push(x);
    return HttpResponse.json(x, { status: 201 });
  }),

  http.post(pathToRegExp("/v1/regulatory-submissions/{id}:decide"), async ({ request }) => {
    const [, id] = new URL(request.url).pathname
      .match(/\/regulatory-submissions\/([^/:]+):decide/) ?? [];
    const x = scenario.submissions.find(y => y.id === id);
    if (!x) return HttpResponse.json(problem("not-found", 404, "递交记录不存在"), { status: 404 });
    const b = await request.json() as { decision: string; decidedOn: string; note?: string };
    x.decision = b.decision; x.decidedOn = b.decidedOn;
    if (b.note) x.note = b.note;
    return HttpResponse.json({ data: x, sideEffects: [] }, { status: 201 });
  }),

  /* ── 人员与交接 ──────────────────────────────────────────────── */
  http.get(pathToRegExp("/v1/staff"), ({ request }) => {
    /* **activeOnly 要真的生效。** 不实现它的话，mock 上"发起交接"
       的下拉里会出现已停用的人 —— 选中之后是一次白跑（真后端会拒），
       而这正是 E3 那条欠账修掉的东西。mock 忽略一个筛选参数，
       等于把已经修好的行为在开发环境里又退回去。 */
    const q = new URL(request.url).searchParams;
    const items = q.get("activeOnly") === "true"
      ? STAFF_LIST.filter(s => s.active) : STAFF_LIST;
    return HttpResponse.json({ items, nextCursor: null });
  }),

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

/** 可行性调查的一行。评分**现算**（走 calc），不存 ——
 *  存下来的分数会在口径升级之后悄悄变成历史值，
 *  而这一页要的恰恰是"按现在这套口径，这家该得多少分"。 */
function feasDto(f: MockFeas) {
  const score = feasibilityScore(f.answers);
  return {
    ...f,
    score: { ...score, calcVersion: CALC_VERSION },
    bias: f.actualRate === null
      ? null : feasibilityBias(f.actualRate, score.predictedPerMonth)
  };
}

/** 一条投标。**价格受 price 列权限管辖，走 mask()**（契约派生的门），
 *  不在这里手抄一份"哪些字段该删"。 */
function bidDto(b: MockBid) {
  const gap = b.winningPriceCents !== null && b.winningPriceCents > 0
    ? (b.ourQuoteCents - b.winningPriceCents) / b.winningPriceCents : null;
  const { winningPriceCents, ...rest } = b;
  return mask({
    ...rest,
    daysPerSubject: b.subjects > 0 ? b.ourPersonDays / b.subjects : 0,
    /* 成交价未知时**这个键不出现** —— 与服务端同一条规矩。 */
    ...(winningPriceCents !== null ? { winningPriceCents } : {}),
    gap
  });
}

/** CRC 人天成本：从现行费率卡取，**不写常量** —— 与服务端同源。 */
const crcDayCost = () => {
  const t = todayStr();
  return scenario.rateCards.find(c =>
    c.roleKind === "CRC" && c.level === null
    && c.validFrom <= t && (c.validTo === null || c.validTo >= t))?.dayCostCents ?? 0;
};

function changeDto(c: MockChange) {
  const total = changeDays({
    status: c.status, personDaysImpact: c.personDaysImpact,
    perSubject: c.perSubject, affectedSubjects: c.affectedSubjects,
    amountCents: c.amountCents
  });
  const { amountCents: settledCents, ...rest } = c;
  return mask({
    ...rest,
    totalPersonDays: total,
    /* 已签署的不算白做 —— 哪怕金额是 0：那是谈过之后的决定。 */
    ...(c.status !== "signed"
      ? { uncoveredCents: Math.round(total * crcDayCost()) } : {}),
    ...(settledCents !== null ? { settledCents } : {})
  });
}

/** 两个**日历日**之间相差几天。与服务端同一个式子。 */
const daysApart = (a: string, b: string) =>
  Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);

/** 一条里程碑。**逾期天数现算** —— 存下来的话，
 *  这个 mock 每过一天就会和真库差一天。 */
function msDto(m: MockMilestone) {
  const open = m.state === "invoiced" && m.dueOn !== null;
  const daysToDue = open ? daysApart(todayStr(), m.dueOn!) : null;
  return mask({
    ...m,
    daysToDue,
    /* 「没逾期」和「逾期 0 天」是两回事 —— 前者给 null。 */
    overdueDays: daysToDue !== null && daysToDue < 0 ? -daysToDue : null
  });
}

/** 里程碑计划表。与迁移 0031 的 milestone_plan 逐字同源。 */
const MS_PLAN = [
  { code: "contract", label: "合同签署",     ratio: 0.10, seq: 1 },
  { code: "siv",      label: "中心启动 SIV", ratio: 0.15, seq: 2 },
  { code: "half",     label: "入组过半",     ratio: 0.25, seq: 3 },
  { code: "eighty",   label: "入组达成 80%", ratio: 0.25, seq: 4 },
  { code: "closeout", label: "中心结题",     ratio: 0.25, seq: 5 }
];

/** 状态机顺序取自契约，不在 mock 里另立一份。 */
const nextState = (cur: string) => SITE_STATES[SITE_STATES.indexOf(cur as never) + 1] ?? null;

function siteDto(id: string) {
  const s = SITES_LIST.find(x => x.id === id);
  if (!s) return null;
  return {
    id: s.id, code: s.code,
    study: { id: "st1", code: "HJ-2024-017", shortName: "艾瑞替尼 III" },
    hospital: s.hospital, dept: s.dept, city: s.city,
    piName: s.piName, piAccountId: s.piAccountId,
    state: scenario.siteState[s.id] ?? s.state, contracted: s.contracted ?? 30,
    irbApprovedOn: "2024-10-18",
    sivOn: scenario.sivOn[s.id] ?? null,
    /* 有启动清单的那个中心才排了 SIV —— 清单项的到期日就是相对它算的。
       不要按 state 判断：推进之后 state 就变了，而计划日不会因此消失。
       建档出来的中心还没有清单，它填的计划日直接用自己那份。 */
    sivPlannedOn: s.sivPlannedOn !== undefined ? s.sivPlannedOn
      : scenario.startupItems.some(i => i.studySiteId === s.id)
        ? scenario.sivPlannedOn : null,
    fpiOn: scenario.fpiOn[s.id] ?? null,
    /* 与后端 INVALIDATED 同一条判定式：已过 SIV，却还挂着未完成的阻塞项。
       mock 里也**算出来**而不是写死 —— 撤销一个阻塞项之后，
       这一栏要立刻跟着变，否则界面在两种数据源下长得不一样。 */
    startupInvalidated: PAST_SIV.includes(scenario.siteState[s.id] ?? s.state)
      && scenario.startupItems.some(
        i => i.studySiteId === s.id && i.isBlocking && !i.doneAt),
    /* 按**列权限**判，不按角色名判。写成 `mockRole === "boss"` 的那一版，
       加一个同样看得到 price 的身份时会静默漏掉它 ——
       而真库那一侧看的从来都是 role_field。 */
    ...(identity().fields.includes("price")
      ? {
        unitPriceCents: s.unitPriceCents ?? 5800000,
        startupFeeCents: s.startupFeeCents ?? 17600000
      } : {})
  };
}

/** 种子中心的条数。建档会往 `SITES_LIST` 里推，重置时截回这里 ——
 *  不截的话，跑第二个用例时上一个用例建的中心还在台账上。 */
const SEED_SITES = SITES_LIST.length;

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
  maskFields({ active: true, fields: identity().fields }, GATES, v);

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
    /* 两份示例：一份含全部受管辖字段，一份是无权限时的样子。
       **除了经营层，其余三个身份都拿不到钱那几列** —— 判据是列权限本身，
       不是"是不是 CRC"。 */
    const rich = identity().fields.includes("cost");
    const body = !rich && ex.bodyWithoutFieldPermission
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
      return identity().fields.includes("cost") ? {
        ...base, revenueCents: k.rev, costCents: k.cost,
        personDays: k.cost / 2_11_200,
        grossProfitCents: k.rev - k.cost
      } : base;
    }),
    calcVersion: CALC_VERSION
  };
}
