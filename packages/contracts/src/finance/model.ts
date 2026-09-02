import { z } from "zod";
import { Uuid, Code, DateOnly, Ratio, Cents, CentsNonNeg } from "../kernel/primitives.js";
import { gated } from "../kernel/fields.js";

/* ════════════════════════════════════════════════════════════════════
   钱什么时候进来。

   在此之前系统只有**后视镜**：收入按已入组的例数确认，成本按已填的工时。
   两者都只回答"已经发生了什么"。

   而现金是另一回事：**人力成本每月刚性支出，回款是里程碑制 + 账期。**
   一个毛利率 30% 的项目，完全可能在第四个月付不出工资 ——
   而这件事，靠现有的任何一张表都看不出来。

   三样东西回答它的三个部分：
     · 里程碑 —— 达成了没有、开票了没有、钱到了没有
     · 客户   —— 账期多长、欠了多久（跨项目，比单中心毛利更上位的切片）
     · 现金流 —— 缺口出现在哪个月
   ════════════════════════════════════════════════════════════════════ */

/* ── 里程碑 ──────────────────────────────────────────────────────── */

export const MILESTONE_STATES = ["pending", "invoiced", "paid"] as const;
export const MilestoneState = z.enum(MILESTONE_STATES).meta({
  id: "MilestoneState",
  description: "待开票 → 已开票 → 已回款"
});

export const MilestonePlanItem = z.object({
  code: z.string(),
  label: z.string(),
  /** 占中心合同额的比例。**五段之和必须是 1**，由库里的断言保证。 */
  ratio: Ratio,
  seq: z.int()
}).meta({
  id: "MilestonePlanItem",
  description: "合同额按什么比例分段收。签约 10% · SIV 15% · 过半 25% · 80% 25% · 结题 25%"
});

export const Milestone = z.object({
  id: Uuid,
  code: Code,
  studySiteId: Uuid,
  siteCode: Code,
  hospital: z.string(),
  study: z.object({ id: Uuid, code: Code, shortName: z.string() }),
  clientName: z.string(),

  planCode: z.string(),
  planLabel: z.string(),
  /** 这一段的金额。**叫 milestoneCents 而不是 amountCents** ——
   *  受列权限管辖的键名一旦重名，`maskFields` 会把全站同名字段一起删掉
   *  （`SideEffect.amountCents` 首当其冲）。`fieldGates()` 里那条
   *  构建期断言写这一版时立刻抓住了它。 */
  milestoneCents: gated(CentsNonNeg, "price"),

  /** 达成日。**只有达成了的才在这张表上** —— 未来的里程碑是预测，
   *  由入组速度推出来，不落库。混进台账会凭空造出现金流。 */
  reachedOn: DateOnly,
  state: MilestoneState,
  invoicedOn: DateOnly.nullable(),
  /** 账期到期日。开票时按客户账期算出来并**固化** ——
   *  客户之后改账期，历史发票的到期日不该跟着变。 */
  dueOn: DateOnly.nullable(),
  paidOn: DateOnly.nullable(),

  /** 距到期日还有几天。**负数 = 已逾期。** 未开票时为 null。 */
  daysToDue: z.int().nullable(),
  /** 已逾期天数。没逾期时为 null，不是 0 —— 「没逾期」和「逾期 0 天」是两回事。 */
  overdueDays: z.int().nullable(),
  note: z.string().nullable()
}).meta({
  id: "Milestone",
  description:
    "达成 → 开票 → 回款。只记已达成的。\n" +
    "「达成了但没开票」是这张表最要盯的一格 —— 那不是未来收入，是记录缺口："
    + "钱本来就该收到了，只是没人去开票。"
});

/** 应收账龄。**逾期占比比绝对额有用**：
 *  500 万里逾期 50 万，和 80 万里逾期 50 万，是两种完全不同的处境。 */
export const ArAging = z.object({
  totalCents: gated(CentsNonNeg, "price"),
  overdueCents: gated(CentsNonNeg, "price"),
  /** 逾期超过 60 天的 —— 这个数不为 0，就该走法务而不是催收了。 */
  longOverdueCents: gated(CentsNonNeg, "price"),
  count: z.int(),
  overdueCount: z.int(),
  meanOverdueDays: z.number().nullable(),
  overdueShare: Ratio.nullable(),
  calcVersion: z.string()
}).meta({ id: "ArAging" });

/* ── 客户 ────────────────────────────────────────────────────────── */

export const Client = z.object({
  id: Uuid,
  name: z.string(),
  sinceYear: z.int().nullable(),
  contact: z.string().nullable(),
  /** 合同账期（天）。**现金流预测里最要紧的一个数** ——
   *  同样一笔里程碑，月结 45 天和月结 90 天进账差一个半月。 */
  paymentTermsDays: z.int(),
  /** 关系评分 0–10。它是主观的，所以 note 里要写清出处。 */
  nps: z.int().nullable(),
  note: z.string().nullable(),

  /* ── 跨项目的账。**这才是把 sponsor 从字符串升成一张表的理由** ──
     按字符串分组算这些，一次拼写不一致就够毁掉那个数。 */
  studyCount: z.int(),
  siteCount: z.int(),
  enrolled: z.int(),
  plannedSubjects: z.int(),
  contractCents: gated(CentsNonNeg, "price"),
  /** 已回款合计。 */
  paidCents: gated(CentsNonNeg, "price"),
  /** 已开票未回款（应收）。 */
  receivableCents: gated(CentsNonNeg, "price"),
  /** 其中已逾期的。 */
  overdueCents: gated(CentsNonNeg, "price"),
  /** 应收的平均账龄（天）。没有应收时为 null。 */
  meanArDays: z.number().nullable()
}).meta({
  id: "Client",
  description:
    "申办方。比「单中心毛利」更上位的切片 —— " +
    "「这个客户欠了我们多少、平均拖多久」是按项目切看不出来的。"
});

/* ── 现金流 ──────────────────────────────────────────────────────── */

export const CASH_IN_KINDS = ["invoiced", "overdue", "pending", "forecast"] as const;
export const CashInKind = z.enum(CASH_IN_KINDS).meta({
  id: "CashInKind",
  description:
    "已开票 / 已开票且逾期 / 待开票 / 预计达成。\n" +
    "决定它在压力情景里被推迟多久：逾期推 3 个月（它之所以逾期，" +
    "恰恰是因为对方还没打算付），预计推 1 个月，其余不推。"
});

export const CashItem = z.object({
  label: z.string(),
  /** 同上：不能叫 amountCents。 */
  inflowCents: gated(CentsNonNeg, "price"),
  kind: CashInKind
}).meta({ id: "CashItem" });

export const CashMonth = z.object({
  /** `YYYY-MM` */
  month: z.string().regex(/^\d{4}-\d{2}$/),
  inCents: gated(CentsNonNeg, "price"),
  outCents: gated(CentsNonNeg, "price"),
  netCents: gated(Cents, "price"),
  /** 累计净额。**最低点落在哪个月，就是要提前多久去谈的答案。** */
  cumCents: gated(Cents, "price"),
  items: z.array(CashItem)
}).meta({ id: "CashMonth" });

export const CashForecast = z.object({
  months: z.array(CashMonth),
  /** 每月刚性支出（在职人力 × 费率 × 月均工作日，加管理分摊）。 */
  burnCents: gated(CentsNonNeg, "price"),
  headcount: z.int(),
  troughCents: gated(Cents, "price"),
  troughMonth: z.string().nullable(),
  /** 压力情景。**不是悲观，是把"逾期意味着对方还没打算付"这件事算进去。** */
  stress: z.object({
    months: z.array(CashMonth),
    troughCents: gated(Cents, "price"),
    troughMonth: z.string().nullable()
  }),
  /** 已达成、但没进开票队列的金额。**不在上面任何一个数里** ——
   *  它不是未来收入，是记录缺口：钱本来就该收到了。 */
  recordGapCents: gated(CentsNonNeg, "price"),
  recordGapCount: z.int(),
  calcVersion: z.string()
}).meta({
  id: "CashForecast",
  description:
    "未来几个月：预计回款 vs 刚性支出。\n" +
    "**记录缺口单列**，因为把它算成未来收入会凭空造出现金流，" +
    "而且是在最不该乐观的那个月。"
});
