import { clamp } from "./kernel.js";

/* ════════════════════════════════════════════════════════════════════
   中心可行性评分。

   ── 它和报价模型问的不是一个问题 ──────────────────────────────────
   报价模型算「这个项目要花多少人天」，可行性算「**这家医院能不能出病人**」。
   两者都在签合同之前，但错的时候错法完全不同：
   报价报错，毛利薄一点；选址选错，那个中心一年入组 0 例，
   而合同上的例数一个不少，只能靠别的中心加班补 —— 那是亏损的第一大来源。

   事后把亏损中心标红是最便宜也最没用的功能：那时钱已经花完了。

   ── 为什么口径要公开，而且要**版本化** ────────────────────────────
   这套分数会被用来拒绝一家医院。被拒的一方（以及内部坚持要选它的人）
   一定会问"凭什么"。给不出逐项拆解的评分等于没有评分 ——
   它会在第一次争议里被"我觉得这家不错"覆盖掉。

   所以 `score()` 返回 `parts`，每一项都对得上问卷里的一栏。
   ════════════════════════════════════════════════════════════════════ */

/** PI 承诺的兑现系数。
 *
 *  **PI 报的月入组数普遍虚高**，这不是谁不诚实：他报的是"理想情况下
 *  我这个科室一个月能见到多少符合的病人"，而实际要减去出差、休假、
 *  病人不愿签知情、竞争试验抢人。行业经验落在 0.4–0.6 之间。
 *
 *  取 0.55 而不是 0.5，是因为本院历史数据（`actualRate` 那一列）
 *  回填之后可以重新拟合 —— 这个常量是**待校准的**，不是拍的。 */
export const PI_COMMIT_KEEP = 0.55;

/** 可行性问卷。每一栏都是**调查时问得出答案**的事实，不是判断。
 *
 *  「这家医院靠谱吗」问不出东西；
 *  「你们科去年这个适应症看了多少病人」问得出。 */
export interface FeasibilityAnswers {
  /** 该适应症年就诊量 */
  ptYear: number;
  /** 既往参与同类试验数 */
  pastN: number;
  /** 既往最好的月入组（例/月）。pastN 为 0 时无意义 */
  pastBest: number;
  /** 同期竞争试验数 */
  compet: number;
  /** 伦理审批耗时（天，历史均值） */
  ethicsDays: number;
  /** 从立项到 SIV 的耗时（天，历史均值） */
  startDays: number;
  /** 研究团队人数 */
  teamN: number;
  /** PI 自报的月入组承诺（例/月） */
  piCommit: number;
  /** 按本方案入排标准估算的合格患者比例。
   *
   *  **这一栏是复盘之后才加进问卷的。** 湘雅二当初评分 82 分入选，
   *  实际筛败率 57% —— 病源足、团队强、启动快，全部说对了，
   *  但没有人问过"你们的病人符合我们这套入排吗"。
   *  早期的记录这一栏是 null：那不是漏填，是**当时根本没问过**，
   *  两者在复盘时必须分得开。 */
  eligPct: number | null;
}

export interface FeasibilityScore {
  /** 逐项得分。加起来等于 total（截断到 0–100 之前）。 */
  parts: {
    source: number; past: number; competition: number;
    startup: number; team: number; eligibility: number;
  };
  total: number;
  /** 预测月入组（例/月）。PI 承诺打折，再受病源 × 入排匹配度封顶。 */
  predictedPerMonth: number;
  /** 病源能支撑的月入组上限。**pred 撞到它，说明瓶颈是病人不是团队。** */
  capPerMonth: number;
  level: "good" | "warn" | "crit";
}

/** 权重表。改这里等于改口径 —— 一并动 `CALC_VERSION`。
 *
 *  为什么「既往入组表现」和「病源」同权重（各 30）：
 *  病源是**上限**，既往表现是**已经兑现过的下限**。
 *  一家年就诊 500 例但从没做过试验的医院，和一家年就诊 200 例
 *  但去年做出过 4 例/月的医院 —— 后者更值得选，因为第二个数
 *  已经把"愿不愿意做、做不做得动、伦理快不快"一起答完了。 */
const W = { source: 30, past: 30, competition: 15, startup: 15, team: 10 } as const;

/** 入排匹配度的修正是 **±**，不是加分项。
 *  0.3 是基准线（十个人里三个能入组）。低于它要扣分 ——
 *  否则一家病源巨大但入排完全不匹配的医院会靠前两项拿到高分。 */
const ELIG_BASE = 0.3;
const ELIG_SWING = 30;

/** 没填入排匹配度时，按什么比例估病源上限。
 *  比 ELIG_BASE 保守一档：**不知道**应该比**知道是基准**更悲观。 */
const ELIG_UNKNOWN = 0.3;

/** 病源能支撑的月入组：年就诊 ÷ 12 × 合格比例 × 能签下来的比例。
 *  最后那个 0.5 是知情同意的转化 —— 符合入排不等于愿意参加。 */
const ICF_TAKE = 0.5;

export function feasibilityScore(q: FeasibilityAnswers): FeasibilityScore {
  const source = clamp(q.ptYear / 500, 0, 1) * W.source;
  /* 从没做过同类试验的，这一项**是 0，不是按 pastBest 折算** ——
     没有历史就是没有历史，用一个编出来的数去填它，
     等于把"我们不知道"记成"我们知道它不行"或者"我们知道它行"。 */
  const past = q.pastN === 0 ? 0 : clamp(q.pastBest / 5, 0, 1) * W.past;
  /* `+ 0` 把 −0 归一成 0 —— 没有竞争试验时这一项是 `-0 * 15 = -0`。
     序列化成 JSON 看不出来（都是 0），但 Object.is(−0, 0) 是 false，
     断言、去重、Map 键全会踩到，而排查时会发现"明明都是 0 却不相等"。
     和 roundCents 记的是同一个坑。 */
  const competition = -clamp(q.compet / 5, 0, 1) * W.competition + 0;
  const startup = clamp((150 - q.startDays) / 110, 0, 1) * W.startup;
  const team = clamp(q.teamN / 8, 0, 1) * W.team;
  const eligibility = q.eligPct === null ? 0 : (q.eligPct - ELIG_BASE) * ELIG_SWING;

  const total = clamp(
    source + past + competition + startup + team + eligibility, 0, 100);

  const capPerMonth =
    (q.ptYear / 12) * (q.eligPct ?? ELIG_UNKNOWN) * ICF_TAKE;
  const predictedPerMonth = Math.min(q.piCommit * PI_COMMIT_KEEP, capPerMonth);

  return {
    parts: { source, past, competition, startup, team, eligibility },
    total,
    predictedPerMonth,
    capPerMonth,
    /* 65 / 45 两道线不是等分的。**45 分以下几乎必然出事**（历史上
       低于 45 分入选的两家，实际月入组 0.5 与 0）；
       45–65 之间是"要有别的理由才选"，而那个理由必须写下来。 */
    level: total >= 65 ? "good" : total >= 45 ? "warn" : "crit"
  };
}

/** 预测偏差：实际月入组 ÷ 预测月入组。
 *
 *  这一条是整套评分**唯一能自我修正**的地方：入选的中心事后回填
 *  `actualRate`，比值持续大于 1 说明打得太保守，持续小于 1 说明
 *  PI_COMMIT_KEEP 该往下调。没有它，评分永远只是一套自洽的说法。 */
export const feasibilityBias = (actual: number, predicted: number): number | null =>
  predicted > 0 ? actual / predicted : null;
