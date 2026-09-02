import { z } from "zod";
import { define } from "../kernel/registry.js";
import { Uuid, DateOnly, Timestamp, QueryBool } from "../kernel/primitives.js";
import { PageQuery, page } from "../kernel/pagination.js";
import { commandResult, WithReason } from "../kernel/command.js";
import {
  Subject, SubjectState, SubjectVisit, VisitStatus, SiteFunnel,
  ScreenFailReason, WithdrawReason,
  QualityEvent, QualityKind, QualityState, QualitySeverity, SubjectPayment, SaeLedger,
  DataQuery, QueryStats,
  Soa, SoaVisit
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
    outOfWindow: QueryBool.optional().describe("只看已超窗或今日到期的"),
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
  id: "listEnrollment", method: "get", path: "/v1/enrollment",
  layer: "L1", context: CTX,
  summary: "全部中心的入组漏斗",
  description:
    "`getSiteFunnel` 的列表形态。**存在的理由是不让前端做 fan-out**：\n" +
    "「入组进度」和「筛选漏斗」两页要的都是全部中心的同一组数，\n" +
    "让前端按中心逐个去打 funnel，那就是把 N+1 从服务端搬到了浏览器上 ——\n" +
    "15 个中心时看不出来，1500 个时那一页永远打不开。\n\n" +
    "和 `getSiteFunnel` 一样**只返回计数，不返回受试者明细**，\n" +
    "所以不需要 `subjRead`（I10）。行范围照常生效。\n\n" +
    "排序：达成率升序 —— 落后的排在最前面。这是这两页唯一要回答的问题。",
  query: PageQuery.extend({
    studyId: Uuid.optional(),
    /** 只看没达成合同例数的。**默认不筛** —— 达成了的也要看得见，
     *  否则「我们一共接了多少」这个数在页面上就凑不齐。 */
    behindOnly: QueryBool.optional()
  }),
  response: page(SiteFunnel)
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
    outOfWindow: QueryBool.optional(),
    pendingPi: QueryBool.optional().describe("只看待 PI 确认的")
  }),
  response: page(SubjectVisit)
});

define({
  id: "getSubjectVisit", method: "get", path: "/v1/subject-visits/{id}",
  layer: "L1", context: CTX,
  summary: "一次访视",
  description:
    "详情页要的是**这一条**，不是「列表的前 200 条里碰巧有它」。\n" +
    "后者在种子只有 10 条访视时看不出区别，访视上了几百条之后，\n" +
    "点开一条历史访视就永远停在「加载中…」—— 没有报错，没有空态，\n" +
    "因为客户端 find 不到只会得到 undefined，而 undefined 和「还没加载完」长得一模一样。\n\n" +
    "范围外与不存在同样是 404。",
  action: "subjRead",
  params: z.object({ id: Uuid }),
  response: SubjectVisit,
  errors: ["not-found"]
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
  id: "listSaeEvents", method: "get", path: "/v1/study-sites/{id}/sae",
  layer: "L1", context: CTX,
  summary: "SAE 台账与 24 小时及时率",
  description:
    "及时率由台账**算出来**（`@sitedesk/calc`），不是写死的常量 —— " +
    "这正是计算引擎独立成一层的原因。\n" +
    "超过 24 小时仍未上报的直接计入迟报：否则一条永远不上报的 SAE " +
    "就永远不进分母，越拖越好看。",
  params: z.object({ id: Uuid }),
  query: PageQuery,
  response: SaeLedger
});

define({
  id: "reportSae", method: "post", path: "/v1/study-sites/{id}/sae",
  layer: "L1", context: CTX, status: 201,
  summary: "登记一条 SAE",
  description:
    "`occurredAt` 是**发生（或研究者知悉）**的时刻，不是录入时刻 —— " +
    "两者混为一谈，及时率就永远是 100%。\n" +
    "登记时可以一并填上报时刻；也可以先记事件、上报之后再补（见 reportSaeSubmitted）。",
  action: "subjWrite",
  params: z.object({ id: Uuid }),
  body: z.object({
    subjectId: Uuid.optional(),
    title: z.string().trim().min(1).max(200),
    detail: z.string().trim().min(4).max(2000),
    occurredAt: Timestamp,
    reportedAt: Timestamp.optional()
  }),
  response: QualityEvent,
  errors: ["invariant-violated"]
});

define({
  id: "reportSaeSubmitted", method: "post", path: "/v1/quality-events/{id}:sae-reported",
  layer: "L2", context: CTX,
  summary: "登记 SAE 已上报",
  description:
    "**超过 24 小时的，这一步会同时自动生成一条 `sae_late` 质量事件**（I6）—— " +
    "在同一个事务里写，不是事后补录。它不可跳过，也不能人工删除，只能整改关闭。",
  action: "subjWrite",
  params: ById,
  body: z.object({ reportedAt: Timestamp }),
  response: commandResult(QualityEvent),
  errors: ["invariant-violated", "conflict-version", "idempotency-key-reused"]
});

define({
  id: "listSubjectPayments", method: "get", path: "/v1/subject-payments",
  layer: "L1", context: CTX,
  summary: "受试者补偿台账",
  action: "subjRead",
  query: PageQuery.extend({
    studySiteId: Uuid.optional(),
    unpaid: QueryBool.optional()
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

/* ── 数据质疑（EDC Query）：闭环的两端 ────────────────────────────
   原型自己写着：QUERIES 里 by:"数据管理" 出现了 5 次，
   但系统里没有数据管理这个角色 —— 质疑凭空产生、凭空关闭。
   这一组补的就是「谁提的、谁负责答、谁判定能关」。 */

define({
  id: "listDataQueries", method: "get", path: "/v1/data-queries",
  layer: "L1", context: CTX,
  summary: "数据质疑",
  description:
    "质疑是 `kind = 'query'` 的质量事件 —— **不是另一张表**。" +
    "再建一张，「本中心还有几条未关闭的质量事件」就有两个答案。\n\n" +
    "默认按**挂得最久的排最前**：挂了 21 天的那条比今天刚提的紧急得多。\n" +
    "CRC 用 `mine=true` 看「待我回复」；DM 用 `state=pending_review` 看「待我关闭」。",
  query: PageQuery.extend({
    studySiteId: Uuid.optional(),
    subjectId: Uuid.optional(),
    state: z.array(QualityState).optional(),
    /** 只看指派给我的 —— CRC 的默认视角。 */
    mine: QueryBool.optional(),
    /** 只看我提的 —— DM / CRA 的「我发起的」。 */
    raisedByMe: QueryBool.optional(),
    /** 只看挂起超过 7 天且仍待回复的 —— 该打电话的那些。 */
    staleOnly: QueryBool.optional()
  }),
  response: page(DataQuery)
});

define({
  id: "getQueryStats", method: "get", path: "/v1/data-queries/stats",
  layer: "L1", context: CTX,
  summary: "质疑负荷与中心分布",
  description:
    "**平均挂起天数把未关闭的也算进去。** 只算已关闭的话，" +
    "一条永远不关的质疑就永远不进分母 —— 越拖越好看，" +
    "而「平均 4.2 天，目标 5 天」底下压着一条挂了 21 天没人管的。\n\n" +
    "每中心给的是密度**和集中度**：扎堆在一个表单上是方案难填（改 eCRF 或培训材料），" +
    "散在七八个表单上才是这家中心的录入质量（改人）。只给密度，" +
    "「高不一定是中心差」就只是一句免责声明。",
  query: z.object({ studySiteId: Uuid.optional(), mine: QueryBool.optional() }),
  response: QueryStats
});

define({
  id: "raiseDataQuery", method: "post", path: "/v1/data-queries",
  layer: "L1", context: CTX, status: 201,
  summary: "发起数据质疑",
  description:
    "**质疑不该凭空出现 —— 发起人要留名。** DM 与 CRA 都可以发起" +
    "（CRA 的 SDV 产出恰恰就是质疑；此前 CRA 只能「看到」质疑、不能「提出」）。\n\n" +
    "责任 CRC **在这一刻固化**：默认取受试者的 CRC，" +
    "此后交接不改写它 —— 否则「这条挂了 21 天是谁的 21 天」没有答案。" +
    "受试者没有责任 CRC 且未显式指派时拒绝创建：无人认领的质疑等于没提。",
  action: "raiseQ",
  body: z.object({
    subjectId: Uuid,
    form: z.string().trim().min(1).max(80),
    fieldName: z.string().trim().min(2).max(80),
    /** 疑点与要求核实的方向。太短的质疑，中心答不了。 */
    detail: z.string().trim().min(10).max(2000),
    ownerAccountId: Uuid.optional(),
    severity: QualitySeverity.optional()
  }),
  response: commandResult(DataQuery),
  errors: ["invariant-violated", "idempotency-key-reused"]
});

define({
  id: "answerDataQuery", method: "post", path: "/v1/data-queries/{id}:answer",
  layer: "L2", context: CTX,
  summary: "中心回复质疑",
  description:
    "回复要写清**核实结果与源数据依据** —— 只写「已修正」的回复，" +
    "DM 判定不了，核查时也说明不了任何事。\n\n" +
    "回复之后状态是「已回复待关闭」，**不是已关闭**：" +
    "回复了不等于问题解决了，判定权在 DM。",
  action: "subjWrite",
  params: ById,
  body: z.object({ answer: z.string().trim().min(10).max(2000) }),
  response: commandResult(DataQuery),
  errors: ["invariant-violated", "idempotency-key-reused"]
});

define({
  id: "closeDataQuery", method: "post", path: "/v1/data-queries/{id}:close",
  layer: "L2", context: CTX,
  summary: "关闭数据质疑",
  description:
    "**只有 DM 能关**（`closeQ`）—— 这是与质量事件关闭（`closeQA`）不同的一条路：" +
    "机构质控事件的关闭权在机构，数据质疑的关闭权在数据管理，两条线不能混。\n\n" +
    "只能关「已回复待关闭」的：没有回复而直接关闭，" +
    "「已关闭」这三个字就只是把问题从列表上抹掉。",
  action: "closeQ",
  params: ById,
  body: WithReason,
  response: commandResult(DataQuery),
  errors: ["invariant-violated", "idempotency-key-reused"]
});

define({
  id: "returnDataQuery", method: "post", path: "/v1/data-queries/{id}:return",
  layer: "L2", context: CTX,
  summary: "退回数据质疑",
  description:
    "回复不充分，退回中心重答。**退回必须说明为什么** —— " +
    "不说理由的退回，是把「凭空产生」的毛病搬到闭环的另一端：" +
    "CRC 只知道弹回来了，不知道要补什么。",
  action: "closeQ",
  params: ById,
  body: WithReason,
  response: commandResult(DataQuery),
  errors: ["invariant-violated", "idempotency-key-reused"]
});

define({
  id: "chaseDataQuery", method: "post", path: "/v1/data-queries/{id}:chase",
  layer: "L2", context: CTX,
  summary: "电话催办并记录",
  description:
    "挂过 7 天之后，靠系统提醒已经不够了。**但「我们催过了」如果没有记录，" +
    "它在核查和跟申办方对账时就等于没发生过** —— 所以催办是一个要落库的动作，" +
    "不是一句提示。只能催「待中心回复」的。",
  action: "raiseQ",
  params: ById,
  body: WithReason,
  response: commandResult(DataQuery),
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

/* ── SOA 配置（欠账 D2） ───────────────────────────────────────────── */

define({
  id: "getSoa", method: "get", path: "/v1/studies/{id}/visit-template",
  layer: "L1", context: CTX,
  summary: "项目的访视计划表（SOA）",
  description: "每一条带上「已经按它排出去多少次访视」—— 那个数大于 0 就删不掉。",
  params: z.object({ id: Uuid }),
  response: Soa
});

define({
  id: "replaceSoa", method: "post", path: "/v1/studies/{id}/visit-template:replace",
  layer: "L2", context: CTX,
  summary: "修订访视计划表",
  description:
    "整份替换。**只影响此后才排出来的访视**，已排的不动。\n" +
    "已经排出去的 seq 不能删，也不能改锚点 —— " +
    "那会让已存在的访视指向一个不存在的定义。\n" +
    "改 SOA 对应的是一次方案修订，必须写原因，前后快照进变更史。",
  action: "manage",
  params: z.object({ id: Uuid }),
  body: z.object({
    visits: z.array(SoaVisit.omit({ scheduledCount: true })).min(1).max(80),
    reason: z.string().trim().min(4).max(500)
  }),
  response: commandResult(Soa),
  errors: ["validation-failed", "invariant-violated", "idempotency-key-reused"]
});
