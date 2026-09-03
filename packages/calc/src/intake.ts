import { roundCents, ratio, type Cents } from "./kernel.js";

/* ════════════════════════════════════════════════════════════════════
   立项测算。

   ── 在立项时就算账，不等做完才知道亏 ──────────────────────────────
   一个项目做完之后算出毛利 8%，那是历史；立项时算出 8%，那是决定。
   两者用的是同一条算式，差别只在**什么时候算**。

   ── 门槛是口径，不是表结构 ────────────────────────────────────────
   低于毛利门槛的必须过经营层那一关。门槛会随年份、随资金成本调整，
   所以它是一个常量，不是每条申请上的一列 ——
   写在行上，改一次门槛会把历史申请的"当初是否越线"一起改写。

   ── 保本合同额比毛利率更能推动谈判 ────────────────────────────────
   「毛利率 20.5%，低于 25% 门槛」这句话，谈判桌上用不上。
   「按这个成本，合同额至少要 805 万才够门槛」——对方能拿它回去算。
   ════════════════════════════════════════════════════════════════════ */

/** 立项毛利门槛。低于它必须经营层审批。
 *  **它是口径的一部分，不是常识** —— 不同公司、不同年份的门槛不一样，
 *  但改这个常量等于改全公司「什么项目可以接」的标准。 */
export const INTAKE_GM_GATE = 0.25;

export interface IntakeNumbers {
  contractCents: Cents;
  estimatedCostCents: Cents;
  plannedSubjects: number;
  plannedSites: number;
}

export interface IntakeMath {
  grossCents: Cents;
  /** 毛利率。**合同额为 0 时为 null，不是 0** ——
   *  「白做」和「还没定价」是两回事，而后者伪装成前者会直接触发退回。 */
  grossMargin: number | null;
  belowGate: boolean;
  /** 单例单价 —— 与报价模型、与同类项目横比用的那个数。 */
  perSubjectCents: Cents | null;
  /** 每中心平均例数。**入组难度的第一个信号** ——
   *  一个中心摊到 4 例的项目，启动成本摊不薄。 */
  subjectsPerSite: number | null;
  /** 按当前测算成本，合同额至少要多少才够门槛。
   *  **比毛利率更能推动谈判** —— 对方能拿这个数回去算。 */
  breakEvenContractCents: Cents;
}

export function intakeMath(x: IntakeNumbers): IntakeMath {
  const grossCents = x.contractCents - x.estimatedCostCents;
  const grossMargin = x.contractCents > 0 ? grossCents / x.contractCents : null;
  return {
    grossCents,
    grossMargin,
    /* 算不出毛利率的（合同额为 0）**当作越线** ——
       它不是"刚好达标"，是根本没定价，而那更需要有人看一眼。 */
    belowGate: grossMargin === null || grossMargin < INTAKE_GM_GATE,
    perSubjectCents: x.plannedSubjects > 0
      ? roundCents(x.contractCents / x.plannedSubjects) : null,
    subjectsPerSite: x.plannedSites > 0 ? x.plannedSubjects / x.plannedSites : null,
    breakEvenContractCents: roundCents(x.estimatedCostCents / (1 - INTAKE_GM_GATE))
  };
}

/* ── 建档滞后 ─────────────────────────────────────────────────────
   「合同里写了 16 个中心，系统里只建了 12 个」——
   差的四个**成本已经在发生**（伦理递交、合同谈判、可行性访视），
   收入却还挂不上号。这是早期成本失控最常见的一种。 */

export interface FilingGap {
  plannedSites: number;
  builtSites: number;
  /** 差几个。0 表示建齐了。 */
  missing: number;
  /** 建档完成度。**计划为 0 时为 null** —— 那是数据问题，不是 100%。 */
  filedRatio: number | null;
}

export function filingGap(plannedSites: number, builtSites: number): FilingGap {
  return {
    plannedSites, builtSites,
    /* **建得比合同多不算负数。** 中心加了但合同还没改，是另一件事
       （合同变更那一页管它），在这里显示成"差 −2 个"只会让人看不懂。 */
    missing: Math.max(0, plannedSites - builtSites),
    filedRatio: ratio(builtSites, plannedSites)
  };
}
