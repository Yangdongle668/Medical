import { z } from "zod";
import { Uuid, Code, DateOnly, Ratio, Cents, CentsNonNeg } from "../kernel/primitives.js";
import { gated } from "../kernel/fields.js";

/* ════════════════════════════════════════════════════════════════════
   商务：签合同之前和签合同之后。

   这一层回答的问题在别的上下文里都答不了：
     · 可行性 —— 这家医院能不能出病人（选址）
     · 投标   —— 我们报的价，市场认不认（定价的反馈回路）
     · 变更   —— 签完之后多干的活，有没有对应的钱

   三者共用一条主线：**没有回写就没有校准。**
   评分不回填实际入组，就只是一套自洽的说法；
   报价不回写中标价，就永远答不了"我们是不是系统性报高"；
   变更不记下来，scope creep 就只表现为毛利莫名其妙地薄了。
   ════════════════════════════════════════════════════════════════════ */

export const FEASIBILITY_STATUSES = ["assessing", "selected", "rejected"] as const;
export const FeasibilityStatus = z.enum(FEASIBILITY_STATUSES).meta({
  id: "FeasibilityStatus",
  description: "评估中 → 已入选 / 未入选"
});

/** 可行性问卷。每一栏都是**调查时问得出答案的事实**，不是判断。 */
export const FeasibilityAnswers = z.object({
  ptYear: z.int().min(0).describe("该适应症年就诊量"),
  pastN: z.int().min(0).describe("既往参与同类试验数"),
  pastBest: z.number().min(0).describe("既往最好的月入组（例/月）；pastN 为 0 时无意义"),
  compet: z.int().min(0).describe("同期竞争试验数"),
  ethicsDays: z.int().min(0).describe("伦理审批耗时（天，历史均值）"),
  startDays: z.int().min(0).describe("立项到 SIV 的耗时（天，历史均值）"),
  teamN: z.int().min(0).describe("研究团队人数"),
  piCommit: z.number().min(0).describe("PI 自报的月入组承诺（例/月）"),
  /** **允许为空，而且空得有意义。**
   *  早期记录这一栏是 null —— 不是漏填，是当时问卷里没有这一项。
   *  它是复盘一次「评分 82 分入选、实际筛败率 57%」之后才加的：
   *  病源足、团队强、启动快全部说对了，
   *  但没有人问过「你们的病人符合我们这套入排吗」。 */
  eligPct: Ratio.nullable().describe("按本方案入排估算的合格患者比例；null = 当时没问过")
}).meta({ id: "FeasibilityAnswers" });

/** 逐项得分。**必须逐项下发** —— 这套分数会被用来拒绝一家医院，
 *  而被拒的一方（以及内部坚持要选它的人）一定会问"凭什么"。
 *  给不出拆解的评分等于没有评分：它会在第一次争议里被
 *  "我觉得这家不错"覆盖掉。 */
export const FeasibilityScore = z.object({
  parts: z.object({
    source: z.number(), past: z.number(), competition: z.number(),
    startup: z.number(), team: z.number(), eligibility: z.number()
  }),
  total: z.number().min(0).max(100),
  predictedPerMonth: z.number().describe("预测月入组：PI 承诺打折，再受病源封顶"),
  capPerMonth: z.number().describe("病源能支撑的上限。pred 撞到它 = 瓶颈是病人不是团队"),
  level: z.enum(["good", "warn", "crit"]),
  calcVersion: z.string()
}).meta({ id: "FeasibilityScore" });

export const Feasibility = z.object({
  id: Uuid,
  code: Code,
  study: z.object({ id: Uuid, code: Code, shortName: z.string() }),
  hospital: z.string(),
  city: z.string(),
  dept: z.string(),
  piName: z.string(),
  surveyedOn: DateOnly,
  surveyedByName: z.string().nullable(),

  answers: FeasibilityAnswers,
  /** 服务端算，不由前端算 —— 同一套口径出现在两个地方，迟早分叉，
   *  而分叉那天，一家医院会因为看哪个页面而得到不同的结论。 */
  score: FeasibilityScore,

  status: FeasibilityStatus,
  decidedOn: DateOnly.nullable(),
  decidedByName: z.string().nullable(),
  /** 入选之后建出来的中心。决定入选和建档是两件事，中间隔着合同。 */
  studySiteId: Uuid.nullable(),
  siteCode: Code.nullable(),

  /** 明知评分不够仍入选的理由。**这一栏为空的低分入选是查不出原因的。** */
  overrideReason: z.string().nullable(),
  rejectReason: z.string().nullable(),

  /** 事后回填的实际月入组。 */
  actualRate: z.number().nullable(),
  /** 实际 ÷ 预测。**整套评分唯一能自我修正的地方** ——
   *  持续大于 1 说明打得太保守，持续小于 1 说明 PI 承诺系数该往下调。 */
  bias: z.number().nullable()
}).meta({
  id: "Feasibility",
  description:
    "选址的账。亏损第一大来源是入组延迟，而入组延迟的根在选址 —— " +
    "事后把亏损中心标红是最便宜也最没用的功能，那时钱已经花完了。"
});

/** 口径的回顾：入选的中心，预测得准不准。
 *  **这是这一页存在的第二个理由** —— 第一个是选址，第二个是让选址的口径可被质疑。 */
export const FeasibilityCalibration = z.object({
  selected: z.int().describe("已入选且已回填实际入组的中心数"),
  /** 实际 ÷ 预测 的均值。1 附近说明口径准；显著小于 1 说明系统性乐观。 */
  meanBias: z.number().nullable(),
  /** 低于 45 分仍入选的中心数 —— 每一个都该有 overrideReason。 */
  overrides: z.int(),
  /** 其中实际月入组低于 1 例的 —— 「当初说了不行」的兑现次数。 */
  overridesGoneBad: z.int(),
  calcVersion: z.string()
}).meta({ id: "FeasibilityCalibration" });

/* ── 投标与报价闭环 ──────────────────────────────────────────────── */

export const BID_STATUSES = ["pending", "won", "lost"] as const;
export const BidStatus = z.enum(BID_STATUSES).meta({
  id: "BidStatus", description: "待定 → 中标 / 失标"
});

export const Bid = z.object({
  id: Uuid,
  code: Code,
  sponsor: z.string(),
  name: z.string(),
  submittedOn: DateOnly,
  sites: z.int(),
  subjects: z.int(),

  /** 我们报出去的价，与当时测算的人天。**两个都要有** ——
   *  只存价格的话，事后没法回答「是人天估多了还是费率高了」，
   *  而这两条要采取的行动完全不同。 */
  ourQuoteCents: gated(CentsNonNeg, "price"),
  ourPersonDays: z.number(),
  /** 人天/例。报价模型的输入就该从这里来。 */
  daysPerSubject: z.number(),

  status: BidStatus,
  decidedOn: DateOnly.nullable(),
  /** 成交价。中标时是我们签下来的价，失标时是对手的价。
   *
   *  **字段不出现 = 问不到**（失标常常问不到对方报了多少）。
   *  受列权限管辖的字段一律不可为 null —— 「没有值」和「没有权限」
   *  用同一种表达：字段不出现。所以这里不是 `.nullable()`，
   *  而是照旧由 gated 给出 optional。
   *
   *  要紧的是它**绝不能被当成「和我们一样」** —— 那会把偏差算成 0，
   *  于是一次输得很惨的标在统计上毫无痕迹。 */
  winningPriceCents: gated(CentsNonNeg, "price"),
  /** 我们的报价相对成交价高多少。正数 = 报高了。成交价未知时为 null。 */
  gap: z.number().nullable(),

  ownerName: z.string().nullable(),
  note: z.string().nullable()
}).meta({
  id: "Bid",
  description:
    "报价模型算「按我们的人天该报多少」，这张表算「市场认不认」——\n" +
    "报出去的价赢没赢不回写，前者就是自说自话。"
});

export const BidReview = z.object({
  total: z.int(),
  decided: z.int(),
  won: z.int(),
  /** 分母是**已出结果的**。还在等的混进去，胜率会在开标前一直虚低。 */
  winRate: Ratio.nullable(),
  wonAmountCents: gated(CentsNonNeg, "price"),
  bidAmountCents: gated(CentsNonNeg, "price"),
  /** 正数 = 系统性报高。 */
  priceBias: z.number().nullable(),
  /** 只看失标的。**比总体偏差有用得多** —— 中标的天然贴着成交价。 */
  lostBias: z.number().nullable(),
  /** 样本数要下发：一个样本算出来的「系统性报高 21%」
   *  和二十个样本算出来的，不是一回事。 */
  biasSamples: z.int(),
  lostBiasSamples: z.int(),
  medianDaysPerSubject: z.number().nullable(),
  calcVersion: z.string()
}).meta({ id: "BidReview" });

/* ── 合同变更 ────────────────────────────────────────────────────── */

export const CHANGE_KINDS = [
  "visit_add", "exam_add", "subject_adj", "site_adj", "extend", "price_adj"
] as const;
/** 中文名。**顺序即库里 change_kind.seq**，由 db 测试钉住两边一致。 */
export const CHANGE_KIND_LABEL: Record<(typeof CHANGE_KINDS)[number], string> = {
  visit_add: "方案修订 · 访视增加", exam_add: "方案修订 · 检查项增加",
  subject_adj: "例数调整", site_adj: "中心增减",
  extend: "周期延长", price_adj: "单价调整"
};
export const ChangeKind = z.enum(CHANGE_KINDS).meta({
  id: "ChangeKind",
  description: CHANGE_KINDS.map(k => CHANGE_KIND_LABEL[k]).join(" / ")
});

export const CHANGE_STATUSES = ["draft", "submitted", "signed", "rejected"] as const;
export const ChangeStatus = z.enum(CHANGE_STATUSES).meta({
  id: "ChangeStatus", description: "待提出 → 已提交 → 已签署 / 未获批"
});

export const ContractChange = z.object({
  id: Uuid,
  code: Code,
  study: z.object({ id: Uuid, code: Code, shortName: z.string() }),
  /** 为空 = 全项目的变更（周期延长、中心增减）。**不是漏填。** */
  studySiteId: Uuid.nullable(),
  siteCode: Code.nullable(),
  kind: ChangeKind,
  kindLabel: z.string(),

  raisedOn: DateOnly,
  raisedByName: z.string().nullable(),
  what: z.string(),

  /** 工作量影响（人天）。可正可负 —— 例数下调是负的。 */
  personDaysImpact: z.number(),
  perSubject: z.boolean(),
  /** 受影响的入组例数。**算出来的，不存** ——
   *  一条「每例多 1.5 人天」的变更真正可怕的地方是入组越多白做的越多，
   *  存一个数会把它冻在提出那天。 */
  affectedSubjects: z.int(),
  /** 实际人天 = perSubject ? 影响 × 例数 : 影响 */
  totalPersonDays: z.number(),
  /** 折成钱（按 CRC 人天成本）。没签下来的部分就是白做的。
   *  已签署的**字段不出现** —— 它不是白做的。 */
  uncoveredCents: gated(Cents, "cost"),

  /** 谈下来的金额。**字段不出现是「还没谈」，0 是「谈过了对方不给」** ——
   *  前者是欠账，后者是决策，差别极大。
   *
   *  **叫 settledCents 而不是 amountCents 是必须的**：`maskFields` 按
   *  叶子键名递归删除，一个键名一旦被标了门，它在**全站**都会被删 ——
   *  `SideEffect.amountCents`（补偿单金额、成本归集金额）会跟着一起消失，
   *  而那是个没有报错、只在跑到那条命令时才看得见的失败。
   *  `fieldGates()` 里现在有一条构建期断言把它挡住了。 */
  settledCents: gated(Cents, "price"),
  status: ChangeStatus,
  decidedOn: DateOnly.nullable(),
  note: z.string().nullable()
}).meta({
  id: "ContractChange",
  description:
    "亏损第一大原因是入组延迟，第二大就是 scope creep 没有变更单。\n" +
    "就算最终要不到钱也必须记下来 —— 下次报价时这就是该加进去的成本。"
});

export const ScopeCreep = z.object({
  /** 没有对应金额的工作量。**这就是白做的部分。** */
  uncoveredDays: z.number(),
  uncoveredCents: gated(Cents, "cost"),
  signedAmountCents: gated(Cents, "price"),
  signedDays: z.number(),
  openCount: z.int(),
  signedCount: z.int(),
  /** 有钱的工作量 ÷ 全部变更工作量。1 是理想，0.6 就该找人谈了。 */
  coverage: Ratio.nullable(),
  calcVersion: z.string()
}).meta({ id: "ScopeCreep" });
