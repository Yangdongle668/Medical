import { Injectable } from "@nestjs/common";
import type { z } from "zod";
import type { InboxItem, INBOX_KINDS } from "@sitedesk/contracts";
import { principal } from "../../infra/ctx.js";
import { ClinicalService } from "../clinical/clinical.service.js";
import { DataQueryService } from "../clinical/query.service.js";
import { StaffingService } from "../site/staffing.service.js";
import { AcceptanceService } from "../site/acceptance.service.js";
import { CostService } from "../cost/cost.service.js";
import { MonitorService } from "../oversight/monitor.service.js";

/* ════════════════════════════════════════════════════════════════════
   我的待办（契约见 contracts/src/workbench/api.ts）。

   ── 不写新的 SQL ────────────────────────────────────────────────
   每一类都调所属模块**自己的列表方法** —— 超窗、我的、过期这些判定
   各只有一份。这里只做三件事：挑出"要当前这个人动手的"、定紧急程度、
   写一句人话。行范围由 RLS 收（同一个事务、同一个会话主体）。

   ── 权限：只给"你办得了的" ───────────────────────────────────────
   直接调 service 绕过了控制器上的动作守卫，所以**守卫要在这里补**，
   而且补的是**办这件事**要的那个动作，不只是"看得到"要的：
     访视 / EDC / SAE 上报  subjWrite（外加列访视要的 subjRead）
     登记 PI 签字           piConfirm
     中心文件               isfWrite
     工时审批               approve
   只看得到、办不了的不进待办 —— CRA 的待办里摆满 CRC 该完成的访视，
   他每天都得先跳过二十条不归他的，才看得到自己的。
   没有就整类不出现 —— 首页不该因为你没有某个权限而报错。
   筛选号走 `screeningNo` 字段，由出口的 MaskInterceptor 按列权限删；
   标题里不写它，否则那一道就被绕过去了。
   ════════════════════════════════════════════════════════════════════ */

type Item = z.infer<typeof InboxItem>;
type Kind = (typeof INBOX_KINDS)[number];

/** 每类最多给几条。首页是"先办哪件"，不是全量台账 —— 全量在各自的页面上。 */
export const PER_KIND = 20;
/** 每类最多取几条来挑。挑完仍然满的，这一类记为截断。 */
const FETCH = 100;
/** 看多远：访视看 7 天，监查访视看 14 天（要订票、要和中心约）。 */
const VISIT_AHEAD = 7;
const MONITOR_AHEAD = 14;
/** 待回复质疑挂过这个天数算"已过期" —— 与数据质疑页「该打电话了」同一条线。 */
const QUERY_STALE_DAYS = 7;
/** PI 签字登记拖过这个天数算"已过期"。 */
const PI_STALE_DAYS = 7;

const RANK = { overdue: 0, today: 1, soon: 2 } as const;

const todayStr = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => {
  const t = new Date(d + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);

@Injectable()
export class InboxService {
  constructor(
    private readonly clinical: ClinicalService,
    private readonly queries: DataQueryService,
    private readonly staffing: StaffingService,
    private readonly acceptance: AcceptanceService,
    private readonly cost: CostService,
    private readonly monitor: MonitorService
  ) {}

  async mine() {
    const p = principal();
    const can = (a: string) => (p.actions as readonly string[]).includes(a);
    const today = todayStr();
    const bag = new Map<Kind, Item[]>();
    const full = new Set<Kind>();
    const put = (kind: Kind, items: Item[], fetched: number) => {
      bag.set(kind, items);
      if (fetched >= FETCH || items.length > PER_KIND) full.add(kind);
    };

    /* ── SAE：知悉后 24 小时内要上报 ─────────────────────────────── */
    if (can("subjWrite")) {
      const r = await this.clinical.listQualityEvents(
        { limit: FETCH, kind: ["sae"], state: ["open", "pending_review"] });
      const now = Date.now();
      put("sae", r.items
        .filter(e => e.occurredAt && !e.reportedAt)
        .map(e => {
          const due = new Date(Date.parse(e.occurredAt!) + 24 * 3_600_000);
          const late = now > due.getTime();
          return this.item({
            kind: "sae", urgency: late ? "overdue" : "today",
            dueAt: due.toISOString(), title: `SAE 未上报 · ${e.title}`,
            detail: late ? "已超过知悉后 24 小时" : "知悉后 24 小时内要上报",
            studySiteId: e.studySiteId, siteCode: e.siteCode,
            screeningNo: e.screeningNo, ref: { type: "quality_event", id: e.id }
          });
        }), r.items.length);
    }

    if (can("subjRead") && can("subjWrite")) {
      /* ── 受试者访视：已超窗 / 今天到期 / 7 天内 ─────────────────── */
      const v = await this.clinical.listVisits({
        limit: FETCH, status: ["planned"], windowOpensBy: addDays(today, VISIT_AHEAD) });
      put("visit", v.items.map(x => this.item({
        kind: "visit",
        urgency: x.outOfWindow ? "overdue" : x.daysLeft === 0 ? "today" : "soon",
        dueOn: x.windowTo, title: x.visitLabel,
        detail: x.outOfWindow ? `已超窗 ${-(x.daysLeft ?? 0)} 天`
          : x.daysLeft === 0 ? "今天是窗口最后一天"
          : x.windowFrom > today ? `窗口 ${x.windowFrom} 打开` : `窗口还剩 ${x.daysLeft} 天`,
        studySiteId: x.studySiteId, siteCode: x.siteCode,
        screeningNo: x.screeningNo, ref: { type: "subject_visit", id: x.id }
      })), v.items.length);

    }
    if (can("subjRead") && can("piConfirm")) {
      /* ── 访视做完，PI 签字还没登记 ────────────────────────────── */
      const pi = await this.clinical.listVisits({ limit: FETCH, pendingPi: true });
      put("pi_confirm", pi.items.map(x => {
        const waited = x.actualDate ? daysBetween(x.actualDate, today) : 0;
        return this.item({
          kind: "pi_confirm", urgency: waited > PI_STALE_DAYS ? "overdue" : "soon",
          dueOn: null, title: `${x.visitLabel} · 登记 PI 签字`,
          detail: `访视 ${x.actualDate ?? "—"} 完成，已等 ${waited} 天 —— 登记之前不计入「已完成」`,
          studySiteId: x.studySiteId, siteCode: x.siteCode,
          screeningNo: x.screeningNo, ref: { type: "subject_visit", id: x.id }
        });
      }), pi.items.length);

    }
    if (can("subjRead") && can("subjWrite")) {
      /* ── 访视做完，EDC 还没录 ─────────────────────────────────── */
      const edc = await this.clinical.listVisits({ limit: FETCH, edcPending: true });
      put("edc", edc.items.map(x => {
        const late = (x.edcDaysLate ?? 0) > 0;
        return this.item({
          kind: "edc", urgency: late ? "overdue" : "soon",
          dueOn: null, title: `${x.visitLabel} · 录入 EDC`,
          detail: late ? `超出 5 个工作日 ${x.edcDaysLate} 天` : "访视完成后 5 个工作日内录入",
          studySiteId: x.studySiteId, siteCode: x.siteCode,
          screeningNo: x.screeningNo, ref: { type: "subject_visit", id: x.id }
        });
      }), edc.items.length);
    }

    /* ── 指派给我、待回复的质疑 ───────────────────────────────────── */
    {
      const r = await this.queries.list({ limit: FETCH, mine: true, state: ["open"] });
      put("query", r.items.map(q => {
        const age = daysBetween(q.raisedOn, today);
        return this.item({
          kind: "query", urgency: age > QUERY_STALE_DAYS ? "overdue" : "soon",
          dueOn: null, title: `${q.code} · ${q.form}「${q.fieldName}」`,
          detail: `挂起 ${age} 天` + (age > QUERY_STALE_DAYS ? "，该打电话了" : ""),
          studySiteId: q.studySiteId, siteCode: q.siteCode,
          screeningNo: q.screeningNo, ref: { type: "data_query", id: q.id }
        });
      }), r.items.length);
    }

    /* ── 交接给我的 ───────────────────────────────────────────────── */
    {
      const r = await this.staffing.listHandovers({ limit: FETCH, status: "pending" });
      const mine = r.items.filter(h => h.toAccountId === p.accountId);
      put("handover", mine.map(h => this.item({
        kind: "handover",
        urgency: h.plannedOn < today ? "overdue" : h.plannedOn === today ? "today" : "soon",
        dueOn: h.plannedOn, title: `${h.fromName} 交接给你`,
        detail: `${h.sites.map(s => s.code).join("、")} · 清单 ${h.doneCount}/${h.totalCount}`,
        studySiteId: h.sites[0]?.id ?? null, siteCode: h.sites[0]?.code ?? null,
        ref: { type: "handover", id: h.id }
      })), r.items.length);
    }

    /* ── 等我审的工时：合成一条 ───────────────────────────────────── */
    if (can("approve")) {
      const r = await this.cost.listTimesheets({ limit: 200, unapprovedOnly: true });
      /* 自己填的不归自己审 —— 与「待我审批」那一页同一条规矩 */
      const others = r.items.filter(t => t.accountId !== p.accountId);
      if (others.length) {
        const oldest = others.reduce((m, t) => t.workDate < m ? t.workDate : m, others[0]!.workDate);
        const age = daysBetween(oldest, today);
        put("approval", [this.item({
          kind: "approval", urgency: age > 14 ? "overdue" : "soon",
          dueOn: null, title: `${others.length}${r.nextCursor ? "+" : ""} 条工时待审`,
          detail: `最早一条是 ${oldest}（${age} 天前）`,
          studySiteId: null, siteCode: null, ref: { type: "timesheet", id: null }
        })], 1);
      } else put("approval", [], 0);
    }

    /* ── 中心文件：缺失 / 过期 / 快过期 ───────────────────────────── */
    if (can("isfWrite")) {
      const r = await this.acceptance.isfBoard({ openOnly: true });
      const hot = r.items.filter(i => i.status !== "low");
      put("isf", hot.map(i => this.item({
        kind: "isf",
        urgency: i.status === "expired" || i.status === "missing" ? "overdue" : "soon",
        dueOn: i.expiresOn, title: i.item,
        detail: i.status === "missing" ? "缺失"
          : i.status === "expired" ? `已过期 ${-(i.daysLeft ?? 0)} 天`
          : `还有 ${i.daysLeft} 天过期`,
        studySiteId: i.studySiteId, siteCode: i.siteCode,
        ref: { type: "isf_item", id: i.id }
      })), hot.length);
    }

    /* ── 负责人是我、还没关的整改 ─────────────────────────────────── */
    {
      const r = await this.clinical.listQualityEvents(
        { limit: FETCH, state: ["open", "pending_review"] });
      const mine = r.items.filter(e => e.capaOwnerAccountId === p.accountId && e.kind !== "sae");
      put("capa", mine.map(e => this.item({
        kind: "capa",
        urgency: (e.capaOverdueDays ?? 0) > 0 ? "overdue" : e.owesCapaPlan ? "today" : "soon",
        dueOn: e.capaDueOn, title: `${e.code} · ${e.title}`,
        detail: (e.capaOverdueDays ?? 0) > 0 ? `整改逾期 ${e.capaOverdueDays} 天`
          : e.owesCapaPlan ? "还没写整改措施" : "整改进行中",
        studySiteId: e.studySiteId, siteCode: e.siteCode,
        screeningNo: e.screeningNo, ref: { type: "quality_event", id: e.id }
      })), r.items.length);
    }

    /* ── 监查：我去过现场、报告还没交；我排的、14 天内的 ──────────── */
    {
      const r = await this.monitor.list({ limit: FETCH, mine: true, openOnly: true });
      const horizon = addDays(today, MONITOR_AHEAD);
      const mvr = r.items.filter(v => v.state === "done" && !v.reportSubmittedOn);
      put("mvr", mvr.map(v => this.item({
        kind: "mvr", urgency: v.mvrOverdue ? "overdue" : "today",
        dueOn: v.performedOn ? addDays(v.performedOn, 10) : null,
        title: `${v.code} 监查报告`,
        detail: v.mvrOverdue ? `到现场后已 ${v.mvrLagDays} 天，超过 10 天` : `到现场后第 ${v.mvrLagDays ?? 0} 天`,
        studySiteId: v.studySiteId, siteCode: v.siteCode,
        ref: { type: "monitor_visit", id: v.id }
      })), mvr.length);
      const up = r.items.filter(v =>
        (v.state === "proposed" || v.state === "scheduled") && v.plannedOn <= horizon);
      put("monitor_visit", up.map(v => this.item({
        kind: "monitor_visit",
        urgency: v.plannedOn < today ? "overdue" : v.plannedOn === today ? "today" : "soon",
        dueOn: v.plannedOn, title: `${v.code} 监查访视 · ${v.hospital}`,
        detail: v.state === "proposed" ? "中心还没确认" : `计划 ${v.plannedOn}，${v.days} 天`,
        studySiteId: v.studySiteId, siteCode: v.siteCode,
        ref: { type: "monitor_visit", id: v.id }
      })), r.items.length);
    }

    /* 每类只留最急的 PER_KIND 条，再合起来按紧急程度 → 期限排 */
    const items: Item[] = [];
    for (const [kind, list] of bag) {
      const sorted = [...list].sort(byUrgency);
      if (sorted.length > PER_KIND) full.add(kind);
      items.push(...sorted.slice(0, PER_KIND));
    }
    items.sort(byUrgency);

    return {
      items,
      counts: {
        overdue: items.filter(i => i.urgency === "overdue").length,
        today: items.filter(i => i.urgency === "today").length,
        soon: items.filter(i => i.urgency === "soon").length
      },
      truncatedKinds: [...full],
      generatedAt: new Date().toISOString()
    };
  }

  /** 补齐可空字段，并且**只在拿得到时带上筛选号** —— 它由出口按列权限删。 */
  private item(x: Omit<Item, "dueOn" | "dueAt" | "screeningNo"> & {
    dueOn?: string | null; dueAt?: string | null; screeningNo?: string | null;
  }): Item {
    const { screeningNo, ...rest } = x;
    return {
      ...rest, dueOn: x.dueOn ?? null, dueAt: x.dueAt ?? null,
      ...(screeningNo ? { screeningNo } : {})
    };
  }
}

/** SAE 先于一切 → 紧急程度 → 期限（先到的在前，没有期限的排在同档最后）。
 *
 *  SAE 连紧急程度都越过：24 小时是法规时限，而且是按小时走的。
 *  一条还剩三小时的 SAE（today）比一条一个月前就超窗的访视（overdue）更该先办 ——
 *  后者已经是一次偏离了，再晚一小时不改变什么；前者现在办还来得及。 */
function byUrgency(a: Item, b: Item): number {
  return Number(b.kind === "sae") - Number(a.kind === "sae")
    || RANK[a.urgency] - RANK[b.urgency]
    || (a.dueAt ?? a.dueOn ?? "9999").localeCompare(b.dueAt ?? b.dueOn ?? "9999");
}
