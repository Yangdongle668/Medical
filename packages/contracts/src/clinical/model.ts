import { z } from "zod";
import { Uuid, Code, DateOnly, Timestamp, Ratio } from "../kernel/primitives.js";
import { gated } from "../kernel/fields.js";

/* ════════════════════════════════════════════════════════════════════
   ClinicalOps 临床作业

   受试者是**有生命周期的对象，不是一个计数**。
   预筛 → 签署 ICF → 筛选期 → 入组 / 筛败 → 逐次访视 → 出组 / 脱落。

   把它记成 `enrolled: 12` 会同时错三件事：
   ① 筛败看不见 —— 而筛败也是收入（I8'：筛败 × 单价 × 筛败费率）；
   ② 脱落看不见 —— 而脱落要按已完成访视比例扣减收入（I8'）；
   ③ 「这一例现在卡在哪」没有答案 —— CRC 每天真正要回答的就是这个。

   **数据红线**：这里只存筛选号与随机号。
   姓名、证件、住院号、联系方式、精确出生日期一律不进本系统 ——
   不是"先不做"，是**没有字段可以放**。
   ════════════════════════════════════════════════════════════════════ */

export const SUBJECT_STATES = [
  "prescreen", "screening", "enrolled", "screen_failed", "withdrawn", "completed"
] as const;
export const SubjectState = z.enum(SUBJECT_STATES).meta({
  id: "SubjectState",
  description:
    "prescreen 预筛 → screening 筛选中 → enrolled 已入组 / screen_failed 筛败 → " +
    "completed 已出组 / withdrawn 已脱落。\n" +
    "**withdrawn 必须独立于 completed**：缺这个状态会同时错两件事 —— " +
    "脱落的受试者永远刷红超窗，且按整例计收入。"
});

/** 筛败原因。与数据库 screen_fail_reason 查找表一一对应。 */
export const SCREEN_FAIL_REASONS = [
  "lab", "prior_therapy", "imaging", "comorbidity", "withdrew_icf", "other"
] as const;
export const ScreenFailReason = z.enum(SCREEN_FAIL_REASONS).meta({
  id: "ScreenFailReason",
  description: "实验室指标不符 / 既往治疗史不符 / 影像学不符合 / " +
    "合并疾病或用药禁忌 / 受试者撤回知情 / 其他"
});

/** 脱落原因。**它决定这一例还能不能算收入，所以必须是受控取值。** */
export const WITHDRAW_REASONS = [
  "withdrew_icf", "lost_to_followup", "adverse_event", "investigator_decision",
  "death", "protocol_violation"
] as const;
export const WithdrawReason = z.enum(WITHDRAW_REASONS).meta({
  id: "WithdrawReason",
  description: "受试者撤回知情 / 失访 / 不良事件终止治疗 / 研究者判断需终止 / " +
    "死亡 / 方案违背终止"
});

export const Subject = z.object({
  id: Uuid,
  studySiteId: Uuid,
  siteCode: Code,
  /* 筛选号是准标识符：在一个中心里它能定位到具体的人。受列权限管辖。
     受管辖的字段**不能同时可空** —— 否则 null 有两种含义（没权限 / 没有值），
     客户端分不清，而"分不清"最后总会被当成"没有值"。
     所以「有没有随机号」由 randomized 这个布尔回答，号码本身另给。 */
  screeningNo: gated(z.string(), "subject"),
  randomized: z.boolean().describe("是否已随机化。号码本身在 randomizationNo，受列权限管辖"),
  randomizationNo: gated(z.string(), "subject"),
  state: SubjectState,
  icfSignedOn: DateOnly.nullable().describe("知情同意签署日 —— 进入筛选期的起点"),
  enrolledOn: DateOnly.nullable(),
  exitedOn: DateOnly.nullable(),
  screenFailReason: ScreenFailReason.nullable(),
  withdrawReason: WithdrawReason.nullable(),
  crcName: z.string().nullable(),

  /** 已完成访视数 / 计划访视数 —— I8' 的脱落扣减直接用这两个数 */
  visitsDone: z.int(),
  visitsPlanned: z.int(),

  /** 下一次访视。已出组或筛败的受试者没有下一次。 */
  nextVisit: z.object({
    id: Uuid, seq: z.int(), visitCode: z.string(), visitLabel: z.string(),
    targetDate: DateOnly, windowFrom: DateOnly, windowTo: DateOnly,
    daysLeft: z.int().describe("距窗口关闭的天数，负数即已超窗"),
    outOfWindow: z.boolean()
  }).nullable()
}).meta({
  id: "Subject",
  description:
    "**只存筛选号与随机号。** 姓名、证件、住院号、联系方式、精确出生日期没有字段可以放。"
});

/* ── 访视 ────────────────────────────────────────────────────────── */
export const VISIT_STATUSES = [
  "planned", "done_pending_pi", "locked", "missed"
] as const;
export const VisitStatus = z.enum(VISIT_STATUSES).meta({
  id: "VisitStatus",
  description:
    "planned 已排期 → done_pending_pi CRC 已完成待 PI 确认 → locked 已锁定；" +
    "missed 未按窗完成。\n" +
    "**done_pending_pi 不计入「已完成」统计**（I3）—— " +
    "CRC 说做完了和 PI 确认做完了，在核查时是两回事。"
});

export const EDC_STATUSES = ["pending", "entered", "queried"] as const;
export const EdcStatus = z.enum(EDC_STATUSES).meta({ id: "EdcStatus" });

export const SubjectVisit = z.object({
  id: Uuid,
  subjectId: Uuid,
  screeningNo: gated(z.string(), "subject"),
  studySiteId: Uuid,
  siteCode: Code,
  seq: z.int(),
  visitCode: z.string().describe("SCR / C1D1 / M6 …"),
  visitLabel: z.string(),
  targetDate: DateOnly,
  windowDays: z.int().min(0),
  windowFrom: DateOnly, windowTo: DateOnly,
  actualDate: DateOnly.nullable(),
  status: VisitStatus,
  edcStatus: EdcStatus,
  edcDaysLate: z.int().nullable()
    .describe("EDC 录入超出 5 个工作日的天数；未超或已录入为 null"),
  outOfWindow: z.boolean().describe("实际完成日在窗口外，或尚未完成而窗口已关闭"),
  daysLeft: z.int().nullable().describe("距窗口关闭的天数；已完成为 null"),
  piConfirmedAt: Timestamp.nullable(),
  piConfirmedByName: z.string().nullable(),
  tasks: z.array(z.object({ seq: z.int(), task: z.string(), doneAt: Timestamp.nullable() }))
}).meta({
  id: "SubjectVisit",
  description: "访视窗口用 daterange 表达，超窗查询走 GiST 索引，不在应用层遍历。"
});

/* ── 漏斗：聚合接口只返回计数（I10） ──────────────────────────────── */
export const SiteFunnel = z.object({
  studySiteId: Uuid,
  siteCode: Code,
  hospital: z.string(),
  contracted: z.int().describe("合同例数"),
  prescreened: z.int(), icfSigned: z.int(), inScreening: z.int(),
  enrolled: z.int(), screenFailed: z.int(), withdrawn: z.int(), completed: z.int(),
  screenFailRate: Ratio.nullable().describe("筛败 ÷ 签署知情。肿瘤常见 50%+"),
  icfRate: Ratio.nullable().describe("签署知情 ÷ 预筛"),
  yieldRate: Ratio.nullable().describe("入组 ÷ 预筛。总转化率"),
  retentionRate: Ratio.nullable().describe("(入组 − 脱落) ÷ 入组"),
  screenFailBreakdown: z.array(z.object({ reason: ScreenFailReason, count: z.int() })),
  withdrawBreakdown: z.array(z.object({ reason: WithdrawReason, count: z.int() })),
  /** 入组达成率 = 入组 ÷ 合同例数 */
  attainment: Ratio.nullable()
}).meta({
  id: "SiteFunnel",
  description:
    "**入组数只是漏斗最后一格。** 只盯着它，看不出「预筛量不足」与「筛败率过高」" +
    "是两个完全不同的问题 —— 前者要加招募渠道，后者要谈方案修订。\n" +
    "这个接口只返回计数，不返回受试者明细（I10）。"
});

/* ── 质量事件 ────────────────────────────────────────────────────── */
export const QUALITY_KINDS = [
  "deviation", "query", "ip_discrepancy", "sae_late", "other"
] as const;
export const QualityKind = z.enum(QUALITY_KINDS).meta({
  id: "QualityKind",
  description: "方案偏离 / 数据质疑 / 药品数量不平衡 / SAE 超时上报 / 其他"
});

export const QUALITY_SEVERITIES = ["minor", "major", "critical"] as const;
export const QualitySeverity = z.enum(QUALITY_SEVERITIES).meta({ id: "QualitySeverity" });

export const QUALITY_STATES = ["open", "pending_review", "closed"] as const;
export const QualityState = z.enum(QUALITY_STATES).meta({
  id: "QualityState",
  description: "open 待整改 → pending_review 待复核 → closed 已关闭"
});

export const QualityEvent = z.object({
  id: Uuid,
  code: Code,
  studySiteId: Uuid,
  siteCode: Code,
  subjectId: Uuid.nullable(),
  screeningNo: gated(z.string(), "subject"),
  visitId: Uuid.nullable(),
  kind: QualityKind,
  severity: QualitySeverity,
  state: QualityState,
  title: z.string(),
  detail: z.string(),
  /** 系统自动生成的事件不允许人工删除，只能整改关闭 */
  autoGenerated: z.boolean(),
  /** 来源方。机构质控提出的事件，**关闭权在机构**，我方不能自行关闭 */
  raisedBy: z.enum(["system", "cra", "qa", "institution"]),
  raisedOn: DateOnly,
  closedAt: Timestamp.nullable(),
  ageDays: z.int().describe("从提出到关闭（或到今天）的天数")
}).meta({
  id: "QualityEvent",
  description:
    "访视超窗**必须**生成方案偏离（I4），不可跳过 —— " +
    "在事务内与访视完成一起写，不是事后补录。"
});

/* ── 受试者补偿 ──────────────────────────────────────────────────── */
export const SubjectPayment = z.object({
  id: Uuid,
  studySiteId: Uuid,
  siteCode: Code,
  subjectId: Uuid,
  screeningNo: gated(z.string(), "subject"),
  visitId: Uuid.nullable(),
  visitLabel: z.string().nullable(),
  amountCents: z.int().min(0),
  dueOn: DateOnly,
  paidOn: DateOnly.nullable(),
  receiptRef: z.string().nullable().describe("签收凭证编号 —— 关闭中心时要逐笔核对"),
  ageDays: z.int()
}).meta({
  id: "SubjectPayment",
  description: "受试者补偿未发放或缺签收凭证，中心关不掉 —— 这是关闭闸门的七项之一。"
});
