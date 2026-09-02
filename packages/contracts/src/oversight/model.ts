import { z } from "zod";
import { Uuid, Code, DateOnly, Timestamp } from "../kernel/primitives.js";
import { gated } from "../kernel/fields.js";

/* ════════════════════════════════════════════════════════════════════
   监督（Oversight）：我方对中心的监查，以及我方对自己的稽查。

   这一版先做监查访视。它和「受试者访视」是两件完全不同的事 ——
   后者是受试者来医院，前者是我们去医院。共用一个词是中文的巧合。

   ── 状态多了一格：done ────────────────────────────────────────────
   原型写的是 待确认 → 已排期 → 已提交，中间少了「去过了但报告没交」。
   而 MVR 滞后正是监查上最常见的欠账：人去了、问题也看见了，
   报告压在 CRA 手上两个月，中心那边该整改的事根本没开始 ——
   **核查时看的是报告日期，不是出差日期。**
   ════════════════════════════════════════════════════════════════════ */

export const MONITOR_KINDS = ["siv", "imv", "cov"] as const;
export const MonitorKind = z.enum(MONITOR_KINDS).meta({
  id: "MonitorKind",
  description: "siv 启动访视 · imv 例行监查 · cov 关闭访视"
});

export const MONITOR_STATES = ["proposed", "scheduled", "done", "reported"] as const;
export const MonitorState = z.enum(MONITOR_STATES).meta({
  id: "MonitorState",
  description:
    "proposed 待确认 → scheduled 已排期 → **done 已到现场** → reported 报告已提交。" +
    "中间那一格不能省：去过了和报告交了是两件事，而欠账就藏在两者之间。"
});

export const MonitorItem = z.object({
  seq: z.int().min(0),
  task: z.string(),
  doneAt: Timestamp.nullable(),
  doneByName: z.string().nullable()
}).meta({
  id: "MonitorItem",
  description:
    "监查报告跟进项（MVR Follow-up）。它不是待办清单 —— " +
    "每一项都是这次现场看出来、要中心去做的事，**全部关闭之前报告提不了**。"
});

export const MonitorVisit = z.object({
  id: Uuid,
  code: Code,
  studySiteId: Uuid,
  siteCode: Code,
  hospital: z.string(),
  studyShortName: z.string(),
  kind: MonitorKind,
  plannedOn: DateOnly,
  monitorAccountId: Uuid,
  monitorName: z.string(),
  days: z.number().positive(),
  state: MonitorState,
  confirmedOn: DateOnly.nullable(),
  performedOn: DateOnly.nullable(),
  reportSubmittedOn: DateOnly.nullable(),
  /** 这一次实际用的 SDV 抽样比例。**空表示这次没有单独定过** ——
   *  不是默认 100%，那是两回事。 */
  sdvSamplePct: z.int().min(1).max(100).nullable(),
  note: z.string().nullable(),
  items: z.array(MonitorItem),
  openItems: z.int().min(0),
  /** 现场做完到报告提交隔了多少天。**没交的按「到今天」算** ——
   *  只统计已提交的，一份永远不交的报告就永远不进分母。
   *  还没到现场的为 null（它还没有开始计时）。 */
  mvrLagDays: z.int().nullable(),
  /** 报告已经超过时限还没交。 */
  mvrOverdue: z.boolean(),
  /** 计划日已过而现场还没去。**它和「报告没交」是两个问题** ——
   *  一个是没出门，一个是出了门没交作业。 */
  visitOverdueDays: z.int().nullable()
}).meta({
  id: "MonitorVisit",
  description:
    "监查访视。排期、改期、到现场、提交报告 —— 四步各有各的日期，" +
    "混成一个「状态」就答不出「为什么这个中心三个月没人管」。"
});

export const RiskBand = z.enum(["low", "normal", "high"]).meta({ id: "RiskBand" });

export const SiteMonitorPlan = z.object({
  studySiteId: Uuid,
  siteCode: Code,
  hospital: z.string(),
  siteState: z.string(),
  band: RiskBand,
  riskScore: z.int().min(0),
  /** 建议间隔与建议抽样比例。**它们是建议，不是强制** ——
   *  人可以不采纳，但不采纳这件事要留在访视行上（sdvSamplePct）。 */
  intervalDays: z.int().positive(),
  sdvSamplePct: z.int().min(1).max(100),
  /** 为什么是这一档。没有理由的建议值没人照着做，
   *  也没人能在核查时解释「为什么这个中心只抽了 25%」。 */
  reasons: z.array(z.string()),
  lastVisitOn: DateOnly.nullable(),
  /** 距上次监查多少天。**null = 一次都没监查过** —— 那不是"刚去过"。 */
  daysSince: z.int().nullable(),
  dueOn: DateOnly.nullable(),
  overdueDays: z.int().nullable(),
  /** 一次都没监查过。比逾期更值得看一眼，所以单独给一个布尔。 */
  neverVisited: z.boolean(),
  /** 未了结的排期数（还没提交报告的） */
  openVisits: z.int().min(0)
}).meta({ id: "SiteMonitorPlan" });

export const MvrLoad = z.object({
  performed: z.int(),
  submitted: z.int(),
  outstanding: z.int(),
  overdue: z.int(),
  meanLagDays: z.number().nullable(),
  worstLagDays: z.int().nullable()
}).meta({
  id: "MvrLoad",
  description:
    "**未提交的报告按「到今天」计入平均**。只算已提交的，" +
    "一份永远不交的报告就永远不进分母 —— 压得越久这个数越好看。"
});

export const MonitorBoard = z.object({
  load: MvrLoad,
  sites: z.array(SiteMonitorPlan),
  /** 未来 4 周的排期次数与人天 */
  upcomingVisits: z.int(),
  upcomingDays: z.number(),
  /** 未来 4 周的差旅估算。**按次不按天** —— 一次两天的监查不是两倍机票。
   *  受 cost 列权限管辖：CRA 排自己的班，但看不到它值多少钱。 */
  travelEstimateCents: gated(z.int().min(0), "cost"),
  calcVersion: z.string()
}).meta({ id: "MonitorBoard" });
