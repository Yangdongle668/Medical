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
  "deviation", "query", "ip_discrepancy", "sae", "sae_late", "other"
] as const;
export const QualityKind = z.enum(QUALITY_KINDS).meta({
  id: "QualityKind",
  description:
    "方案偏离 / 数据质疑 / 药品数量不平衡 / 严重不良事件 / SAE 超时上报 / 其他。\n" +
    "`sae` 与 `sae_late` 是**两条记录**，不是一条的两个状态：" +
    "前者是事件本身（台账、及时率的分母），后者是「这一条晚报了」这件事" +
    "自动生成的质量事件（I6），要走整改与关闭流程。"
});

export const QUALITY_SEVERITIES = ["minor", "major", "critical"] as const;
export const QualitySeverity = z.enum(QUALITY_SEVERITIES).meta({ id: "QualitySeverity" });

/** 提出方。`dm` 是这一版补上的：原型里 `by:"数据管理"` 出现了 5 次，
 *  而系统里没有这个角色 —— 质疑凭空产生、凭空关闭，没有人对它负责。 */
export const QUALITY_RAISED_BY = ["system", "cra", "qa", "institution", "dm"] as const;
export const QualityRaisedBy = z.enum(QUALITY_RAISED_BY).meta({
  id: "QualityRaisedBy",
  description: "机构质控（institution）提出的事件，**关闭权在机构**，我方不能自行关闭。"
});

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
  raisedBy: QualityRaisedBy,
  raisedOn: DateOnly,
  closedAt: Timestamp.nullable(),
  ageDays: z.int().describe("从提出到关闭（或到今天）的天数"),

  /* ── 以下三项只在 kind = 'sae' 时有值（I6） ─────────────────────── */
  /** 事件发生（或研究者知悉）的时刻 */
  occurredAt: Timestamp.nullable(),
  /** 向申办方 / 伦理上报的时刻；尚未上报为 null */
  reportedAt: Timestamp.nullable(),
  /** 从发生到上报经过的小时数。**不四舍五入** ——
   *  把 24.4 小时显示成 24 小时是在替人开脱。未上报为 null。 */
  reportHours: z.number().nullable(),
  /** 自动生成的事件因哪条质量事件而生成。`sae_late` 指向它所说的那条 SAE。
   *  自动记录必须答得出「凭什么存在」—— 数据库上有约束（迁移 0018）。 */
  sourceEventId: Uuid.nullable(),

  /* ── CAPA（迁移 0035） ─────────────────────────────────────────── */
  /** 问题类型，比 `kind` 细。CAPA 有效性按它分组 ——
   *  按 kind 分的话，「源数据缺陷」和「知情同意版本错误」会落进同一格，
   *  而这两类的根因与预防措施毫无共同之处。 */
  category: z.string().nullable(),
  /** 纠正与预防措施。**只写纠正不写预防的 CAPA，等于把同一个核查风险
   *  往后推了一个季度** —— 而这件事只有在同类问题复发时才看得出来。 */
  capaPlan: z.string().nullable(),
  capaOwnerAccountId: Uuid.nullable(),
  capaOwnerName: z.string().nullable(),
  capaDueOn: DateOnly.nullable(),
  /** 整改期限过了还没关闭，超了多少天。没到期或已关闭为 null。 */
  capaOverdueDays: z.int().nullable(),
  /** **已指派责任人、但还没提交整改措施。** 它不是「正在整改」，
   *  是有人欠着一份措施 —— 两者在界面上必须分得开。 */
  owesCapaPlan: z.boolean()
}).meta({
  id: "QualityEvent",
  description:
    "访视超窗**必须**生成方案偏离（I4），不可跳过 —— " +
    "在事务内与访视完成一起写，不是事后补录。"
});

/* ── 数据质疑（EDC Query） ────────────────────────────────────────
   质疑是 `kind = 'query'` 的质量事件，不是另一张表 ——
   再建一张，「本中心还有几条未关闭的质量事件」这个数就有了两个答案，
   而核查时被问到的恰恰是这个数。

   这里的模型只是给同一行**换一个视角**：质量事件页问「这条事件怎么了」，
   质疑工作队列问「该谁动手、挂了多久、上次为什么被退回」。 */

export const DataQuery = z.object({
  id: Uuid,
  code: Code,
  studySiteId: Uuid,
  siteCode: Code,
  hospital: z.string(),
  studyShortName: z.string(),
  subjectId: Uuid.nullable(),
  screeningNo: gated(z.string(), "subject"),

  /** 表单与字段。此前打包在 title 里，拆开是因为 DM 要按表单聚类 ——
   *  质疑扎堆在一个表单上是方案难填，散在各处才是录入质量差。 */
  form: z.string(),
  fieldName: z.string(),
  /** 质疑内容：疑点是什么、要中心核实什么方向。 */
  detail: z.string(),
  severity: QualitySeverity,
  state: QualityState,

  raisedBy: QualityRaisedBy,
  /** 提出人姓名。系统自动生成的、或提出人账号已删的为 null。 */
  raisedByName: z.string().nullable(),
  raisedOn: DateOnly,

  /** 责任 CRC。**提出时固化**，不跟着受试者的 CRC 变 ——
   *  交接一次就改写历史责任人的话，"这条挂了 21 天是谁的 21 天"没有答案。 */
  ownerAccountId: Uuid.nullable(),
  ownerName: z.string().nullable(),

  /** 中心的最后一次回复。被退回后重答会覆盖它，历次留在审计轨迹里。 */
  answer: z.string().nullable(),
  answeredOn: DateOnly.nullable(),
  /** 上一次被退回的理由。退回而不说为什么，CRC 只知道弹回来了。 */
  returnedReason: z.string().nullable(),

  /** 电话催办次数与最后一次的日期。**"我们催过了"没有记录等于没发生过。** */
  chaseCount: z.int().min(0),
  lastChasedOn: DateOnly.nullable(),

  closedAt: Timestamp.nullable(),
  resolution: z.string().nullable(),
  /** 从提出到关闭（或到今天）的天数 —— 与 QualityEvent.ageDays 同一个定义。 */
  ageDays: z.int(),
  /** 挂起超过 7 天且仍待中心回复 —— 靠系统提醒已经不够了。 */
  stale: z.boolean()
}).meta({
  id: "DataQuery",
  description:
    "**发起与关闭都必须有人负责。** 发起受 `raiseQ` 动作权限约束（DM 与 CRA 都可以），" +
    "关闭只有 DM（`closeQ`）—— 中心回复了不等于问题解决了，" +
    "这中间的一格（已回复待关闭）就是这件事的全部意义。"
});

export const QueryLoad = z.object({
  total: z.int(),
  open: z.int().describe("待中心回复"),
  stale: z.int().describe("待中心回复且挂起超过 7 天 —— 该打电话的那些"),
  pendingReview: z.int().describe("已回复待关闭"),
  staleReview: z.int().describe("待关闭超过目标天数 —— 这一格堆积是 DM 自己的欠账"),
  closed: z.int(),
  /** 平均挂起天数。**未关闭的按「到今天」计入** ——
   *  只算已关闭的，一条永远不关的质疑就永远不进分母，越拖越好看。
   *  无质疑时为 null。 */
  meanAgeDays: z.number().nullable(),
  /** 最久的那一条挂了多少天。平均 4.2 天远不如「最坏的挂了 21 天」能让人动。 */
  worstAgeDays: z.number().nullable(),
  /** 平均是否达标（≤ 5 天）。无质疑时为 null —— 没有质疑不等于达标。 */
  meetsTarget: z.boolean().nullable()
}).meta({ id: "QueryLoad" });

export const SiteQueryDensity = z.object({
  studySiteId: Uuid,
  siteCode: Code,
  hospital: z.string(),
  enrolled: z.int(),
  total: z.int(),
  open: z.int(),
  meanAgeDays: z.number().nullable(),
  /** 每例质疑数。**入组 0 例为 null，不是 0** ——
   *  「还没开始录」和「录得很干净」是两回事，而后者伪装成前者
   *  恰好会让人不去看它。 */
  perSubject: z.number().nullable(),
  band: z.enum(["ok", "watch", "bad"]).nullable(),
  /** 质疑最多的那个表单及其占比 —— 密度高不一定是中心差，
   *  区分的线索是集中度：扎堆在一个表单上是方案难填，散开才是录入质量。 */
  topForm: z.string().nullable(),
  topFormShare: Ratio.nullable(),
  /** 归因结论：too-few 质疑太少不下结论 / form 表单问题 / entry 录入问题。 */
  verdict: z.enum(["too-few", "form", "entry"])
}).meta({ id: "SiteQueryDensity" });

export const QueryStats = z.object({
  load: QueryLoad,
  sites: z.array(SiteQueryDensity),
  calcVersion: z.string()
}).meta({
  id: "QueryStats",
  description: "密度与集中度**必须一起给** —— 只给密度，「高不一定是中心差」就只是免责声明。"
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

/* ── SAE 台账与 24 小时及时率（I6） ─────────────────────────────────
   这一条是 packages/calc/src/kernel.ts 开头点名的原罪：
   原型里「SAE 24h 及时率」是个写死的常量，而同一个页面下方就摆着
   一条超窗的 SAE。所以这里的每一个数字都由 @sitedesk/calc 算出来，
   并带 calcVersion —— 报表要能标出「按哪版口径算的」。 */
export const SaeTimeliness = z.object({
  total: z.int(),
  onTime: z.int(),
  late: z.int(),
  /** 发生不足 24 小时且尚未上报 —— 还在计时，不进及时率 */
  pending: z.int(),
  /** 及时率 = onTime / (onTime + late)。
   *  分母为 0 时**不出现该字段** —— 「还没有 SAE」不等于「及时率 0%」，
   *  而显示成 100% 更糟：那是在用一个没有分母的数字给人安全感。 */
  rate: z.number().min(0).max(1).nullable(),
  /** 最长的一次超时（小时）。未上报的按「到现在为止」算 —— 它还在变大。
   *  及时率是 92% 还是 100%，远不如「最坏的那一条晚了 9 天」更能让人动起来。 */
  worstLateHours: z.number().nullable(),
  calcVersion: z.string()
}).meta({
  id: "SaeTimeliness",
  description:
    "**不能靠「不上报」把这个数做好看。** 超过 24 小时仍未上报的直接计入迟报，" +
    "而不是留在分母之外等着 —— 那样越拖越好看。"
});

export const SaeLedger = z.object({
  items: z.array(QualityEvent),
  nextCursor: z.string().nullable(),
  timeliness: SaeTimeliness
}).meta({ id: "SaeLedger" });

/* ── SOA（访视计划表），可配置：见迁移 0020 ────────────────────────── */
export const SoaVisit = z.object({
  seq: z.int().min(0),
  visitCode: Code,
  visitLabel: z.string().min(1).max(120),
  /** 只有 seq 0 锚定知情日 —— 入组之前唯一确定的日期就是它 */
  anchor: z.enum(["icf", "enroll"]),
  offsetDays: z.int().min(-365).max(3650),
  windowDays: z.int().min(0).max(120),
  compensationCents: z.int().min(0),
  tasks: z.array(z.string().min(1).max(120)).max(30)
    .describe("这次访视要做哪几项 —— 不该靠 CRC 记忆"),
  /** 已经按这一条排出去的访视数。**大于 0 就删不掉**：
   *  删掉它，那些访视就指向了一个不存在的定义 ——
   *  报表里它们还在，SOA 上它们不存在。 */
  scheduledCount: z.int().min(0)
}).meta({ id: "SoaVisit" });

export const Soa = z.object({
  studyId: Uuid,
  visits: z.array(SoaVisit),
  lastChangedAt: Timestamp.nullable(),
  lastChangedByName: z.string().nullable(),
  lastReason: z.string().nullable()
}).meta({
  id: "Soa",
  description:
    "访视计划表。**改它不影响已排出去的访视** —— " +
    "访视在排期那一刻从模板落成行（连 visitCode、windowDays 一起抄下来），" +
    "此后与模板无关。\n" +
    "一个受试者的 C4D1 已经排在下周三，模板一改就跳到下周五，" +
    "那个人的行程、床位、伴随用药全部作废，而系统不会知道自己做了这件事。"
});
