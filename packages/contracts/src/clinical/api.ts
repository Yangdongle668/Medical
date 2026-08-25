import { z } from "zod";
import { define } from "../kernel/registry.js";
import { Uuid, DateOnly } from "../kernel/primitives.js";
import { PageQuery, page } from "../kernel/pagination.js";
import { commandResult, WithReason } from "../kernel/command.js";
import {
  Subject, SubjectState, SubjectVisit, VisitStatus, SiteFunnel,
  ScreenFailReason, WithdrawReason,
  QualityEvent, QualityKind, QualityState, SubjectPayment
} from "./model.js";

const CTX = "clinical";
const ById = z.object({ id: Uuid });

/* ── 读 ──────────────────────────────────────────────────────────── */

define({
  id: "listSubjects", method: "get", path: "/v1/subjects", layer: "L1", context: CTX,
  summary: "受试者列表",
  description:
    "返回受试者**明细**，因此每次调用都写审计（I10）。\n" +
    "筛选号受列权限管辖：无权限时该字段从响应里消失 —— " +
    "外部方能看到「这个中心有 12 例在组」，看不到是哪 12 例。",
  action: "subjRead",
  query: PageQuery.extend({
    studySiteId: Uuid.optional(),
    state: z.array(SubjectState).optional(),
    outOfWindow: z.coerce.boolean().optional().describe("只看已超窗或今日到期的"),
    q: z.string().max(64).optional()
  }),
  response: page(Subject)
});

define({
  id: "getSubject", method: "get", path: "/v1/subjects/{id}", layer: "L1", context: CTX,
  summary: "受试者详情", action: "subjRead",
  params: ById, response: Subject
});

define({
  id: "getSiteFunnel", method: "get", path: "/v1/study-sites/{id}/funnel",
  layer: "L1", context: CTX,
  summary: "中心筛选漏斗",
  description:
    "**只返回计数，不返回明细**，因此不需要 `subject.read` 动作权限（I10）。\n" +
    "预筛 → 签署知情 → 入组 / 筛败 / 在筛，外加脱落与留存。\n" +
    "「入组慢」有三种完全不同的根因：预筛量不足、筛败率过高、中心未真正启动 —— " +
    "只看入组数分不出来。",
  params: ById, response: SiteFunnel
});

define({
  id: "listSubjectVisits", method: "get", path: "/v1/subject-visits",
  layer: "L1", context: CTX,
  summary: "访视清单",
  description:
    "默认按窗口关闭日升序 —— CRC 每天第一件事是看「今天谁到期」。\n" +
    "`outOfWindow=true` 走 GiST 索引，不在应用层遍历。",
  action: "subjRead",
  query: PageQuery.extend({
    studySiteId: Uuid.optional(),
    subjectId: Uuid.optional(),
    status: z.array(VisitStatus).optional(),
    outOfWindow: z.coerce.boolean().optional(),
    pendingPi: z.coerce.boolean().optional().describe("只看待 PI 确认的")
  }),
  response: page(SubjectVisit)
});

define({
  id: "listQualityEvents", method: "get", path: "/v1/quality-events",
  layer: "L1", context: CTX,
  summary: "质量事件",
  query: PageQuery.extend({
    studySiteId: Uuid.optional(),
    kind: z.array(QualityKind).optional(),
    state: z.array(QualityState).optional()
  }),
  response: page(QualityEvent)
});

define({
  id: "listSubjectPayments", method: "get", path: "/v1/subject-payments",
  layer: "L1", context: CTX,
  summary: "受试者补偿台账",
  action: "subjRead",
  query: PageQuery.extend({
    studySiteId: Uuid.optional(),
    unpaid: z.coerce.boolean().optional()
  }),
  response: page(SubjectPayment)
});

/* ── 写：受试者生命周期 ──────────────────────────────────────────── */

define({
  id: "createSubject", method: "post", path: "/v1/subjects",
  layer: "L1", context: CTX, status: 201,
  summary: "登记预筛受试者",
  description: "此时只有筛选号。签署知情后才进入筛选期，那时才生成筛选期访视。",
  action: "subjWrite",
  body: z.object({
    studySiteId: Uuid,
    screeningNo: z.string().trim().min(1).max(32)
  }),
  response: Subject,
  errors: ["invariant-violated"]
});

define({
  id: "signIcf", method: "post", path: "/v1/subjects/{id}:sign-icf",
  layer: "L2", context: CTX,
  summary: "登记知情同意签署",
  description:
    "签署 ICF = 进入筛选期，同时按 SOA 生成筛选期访视窗口。\n" +
    "**签署日不能晚于今天，也不能早于中心的伦理批件日** —— " +
    "在批件之前签的知情，是严重违背。",
  action: "subjWrite",
  params: ById,
  body: z.object({ signedOn: DateOnly }),
  response: commandResult(Subject),
  errors: ["invariant-violated", "idempotency-key-reused"]
});

define({
  id: "enrollSubject", method: "post", path: "/v1/subjects/{id}:enroll",
  layer: "L2", context: CTX,
  summary: "入组（随机化）",
  description:
    "筛选期访视必须已由 PI 确认锁定才能入组 —— " +
    "入排标准还没人签字就随机化，是核查必查的一条。",
  action: "subjWrite",
  params: ById,
  body: z.object({
    randomizationNo: z.string().trim().min(1).max(32),
    enrolledOn: DateOnly
  }),
  response: commandResult(Subject),
  errors: ["invariant-violated", "gate-not-satisfied", "idempotency-key-reused"]
});

define({
  id: "screenFailSubject", method: "post", path: "/v1/subjects/{id}:screen-fail",
  layer: "L2", context: CTX,
  summary: "登记筛败",
  description:
    "**筛败不是失败，是收入。** 筛败例数 × 单价 × 筛败费率计入收入（I8'）——" +
    "不记录筛败，会把本来赚钱的高筛败中心算成亏损。\n" +
    "原因是受控取值：自由文本统计不出「入排标准与病源不匹配」。",
  action: "subjWrite",
  params: ById,
  body: z.object({ reason: ScreenFailReason, failedOn: DateOnly, note: z.string().max(500).optional() }),
  response: commandResult(Subject),
  errors: ["invariant-violated", "idempotency-key-reused"]
});

define({
  id: "withdrawSubject", method: "post", path: "/v1/subjects/{id}:withdraw",
  layer: "L2", context: CTX,
  summary: "登记脱落",
  description:
    "脱落按**已完成访视比例**计收入，不按整例（I8'）。\n" +
    "剩余未完成的访视一并作废 —— 否则这一例会永远刷红超窗。",
  action: "subjWrite",
  params: ById,
  body: z.object({
    reason: WithdrawReason, withdrawnOn: DateOnly,
    note: z.string().trim().min(4).max(500)
  }),
  response: commandResult(Subject),
  errors: ["invariant-violated", "idempotency-key-reused"]
});

/* ── 写：访视 ────────────────────────────────────────────────────── */

define({
  id: "completeSubjectVisit", method: "post", path: "/v1/subject-visits/{id}:complete",
  layer: "L2", context: CTX,
  summary: "完成一次访视",
  description:
    "**本系统最重要的一个命令。** 一次调用触发一串后果，拆成多个 REST 调用" +
    "任何一个失败都会留下不一致的状态：\n\n" +
    "| 后果 | 副作用 type | 交付于 |\n" +
    "|---|---|---|\n" +
    "| 按 SOA 生成下一次访视窗口 | `NextVisitScheduled` | 本阶段 |\n" +
    "| 筛选期访视完成 → 受试者进入待入组 | — | 本阶段 |\n" +
    "| 超窗 → **必须**生成方案偏离（I4） | `DeviationDetected` | 本阶段 |\n" +
    "| 生成受试者补偿待发放单 | `CompensationDue` | 本阶段 |\n" +
    "| 置 EDC 待录入，起算 5 个工作日 | — | 本阶段 |\n" +
    "| 进入 PI 待确认队列（I3） | — | 本阶段 |\n" +
    "| 按费率卡生成工时与成本快照 | `TimesheetPosted` `CostPosted` | Timesheet & Cost |\n\n" +
    "**任务未逐项完成不得提交** —— 打勾了事等于没做。",
  action: "subjWrite",
  params: ById,
  body: z.object({
    actualDate: DateOnly,
    /** 超窗时必须说明原因，它会原样进入方案偏离的记录 */
    outOfWindowReason: z.string().trim().min(4).max(500).optional(),
    hours: z.number().min(0.25).max(24).describe("本次访视 CRC 实际投入工时"),
    note: z.string().max(500).optional()
  }),
  response: commandResult(SubjectVisit),
  errors: ["invariant-violated", "gate-not-satisfied", "idempotency-key-reused"]
});

define({
  id: "completeVisitTask", method: "post",
  path: "/v1/subject-visits/{id}/tasks/{seq}:done", layer: "L2", context: CTX,
  summary: "勾掉访视的一项任务",
  action: "subjWrite",
  params: z.object({ id: Uuid, seq: z.coerce.number().int().min(0) }),
  body: z.object({}),
  response: commandResult(SubjectVisit),
  errors: ["idempotency-key-reused"]
});

define({
  id: "confirmSubjectVisit", method: "post", path: "/v1/subject-visits/{id}:confirm",
  layer: "L2", context: CTX,
  summary: "PI 确认访视",
  description:
    "**只有该中心的 PI 本人可以确认**（I3）。确认前访视不计入「已完成」统计 ——" +
    "CRC 说做完了和 PI 确认做完了，在核查时是两回事。",
  action: "piConfirm",
  params: ById,
  body: z.object({}),
  response: commandResult(SubjectVisit),
  errors: ["invariant-violated", "idempotency-key-reused"]
});

define({
  id: "enterVisitToEdc", method: "post", path: "/v1/subject-visits/{id}:edc-entered",
  layer: "L2", context: CTX,
  summary: "标记已录入 EDC",
  description: "访视完成后 5 个工作日内录入才算及时。超时不阻断，但进及时率统计。",
  action: "subjWrite",
  params: ById, body: z.object({}),
  response: commandResult(SubjectVisit),
  errors: ["idempotency-key-reused"]
});

/* ── 写：质量事件与补偿 ──────────────────────────────────────────── */

define({
  id: "closeQualityEvent", method: "post", path: "/v1/quality-events/{id}:close",
  layer: "L2", context: CTX,
  summary: "关闭质量事件",
  description:
    "**机构质控提出的事件，关闭权在机构** —— 我方不能自行关闭，" +
    "否则「已关闭」这三个字在核查时一文不值。\n" +
    "关闭必须写整改说明。",
  action: "closeQA",
  params: ById,
  body: WithReason,
  response: commandResult(QualityEvent),
  errors: ["invariant-violated", "idempotency-key-reused"]
});

define({
  id: "paySubjectPayment", method: "post", path: "/v1/subject-payments/{id}:pay",
  layer: "L2", context: CTX,
  summary: "登记补偿已发放",
  description: "必须同时登记签收凭证编号 —— 只记「发了」而没有凭证，关闭中心时对不上。",
  action: "subjWrite",
  params: ById,
  body: z.object({ paidOn: DateOnly, receiptRef: z.string().trim().min(1).max(64) }),
  response: commandResult(SubjectPayment),
  errors: ["invariant-violated", "idempotency-key-reused"]
});
