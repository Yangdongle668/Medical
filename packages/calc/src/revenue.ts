import { CALC_VERSION, roundCents, type Cents } from "./kernel.js";

/* ════════════════════════════════════════════════════════════════════
   I8' —— 单中心收入。四项，缺一不可。

     收入 = 启动费
          + 入组例数 × 单价
          − Σ(1 − 已完成访视数 ÷ 计划访视数) × 单价        ← 脱落扣减
          + 筛败例数 × 单价 × 筛败费率                      ← 筛败费

   **两处修正方向相反，这是最要紧的一点：**

     · 漏算筛败费 → 高筛败中心的收入被低估，
       于是把一个本来赚钱的中心算成亏损，然后关掉它。
     · 漏算脱落扣减 → 高脱落中心的收入被高估，
       于是保住一个实际在亏钱的中心，继续投人。

   **只做一个比两个都不做更危险 —— 因为它看起来是对的。**
   两个都不做时，误差至少是同向的（整体偏乐观），还能靠经验打折；
   只做一个，误差在不同中心之间方向相反，任何整体折扣都救不了。

   这一条有黄金测试基线（test/revenue.test.ts），改动必须先改基线。
   ════════════════════════════════════════════════════════════════════ */

/** 一例脱落受试者对收入的影响：按**已完成访视比例**计，不按整例。 */
export interface Dropout {
  /** 已完成（且经 PI 确认锁定）的访视数 */
  visitsDone: number;
  /** 该受试者按 SOA 计划的访视总数 */
  visitsPlanned: number;
}

export interface RevenueInput {
  startupFeeCents: Cents;
  unitPriceCents: Cents;
  /** 已入组例数（含已脱落与已出组 —— 他们都曾经入组） */
  enrolled: number;
  /** 筛败例数 */
  screenFailed: number;
  /** 筛败费率。合同条款，按项目定，典型 0.30–0.40 */
  screenFailFeeRate: number;
  /** 每一例脱落受试者的访视完成情况 */
  dropouts: readonly Dropout[];
}

export interface RevenueBreakdown {
  startup: Cents;
  enrollment: Cents;
  /** 负数 */
  dropoutDeduction: Cents;
  screenFailFee: Cents;
  total: Cents;
  calcVersion: string;
}

/**
 * 单中心收入（I8'）。
 *
 * 注意 `enrolled` **包含**已脱落的例数：脱落的人确实入组过，
 * 按整例计入 enrollment，再由 dropoutDeduction 扣回未完成的部分。
 * 若把脱落从 enrolled 里剔除再不做扣减，等于按 0 计 —— 那是另一种错，
 * 而且更狠：一个做完 11/12 次访视才退出的受试者，收入直接归零。
 */
export function siteRevenue(x: RevenueInput): RevenueBreakdown {
  const startup = x.startupFeeCents;
  const enrollment = x.unitPriceCents * x.enrolled;

  /* 逐例算未完成比例再求和，不能先把比例平均了再乘 ——
     平均值对例数不同的中心不可比，而中心之间正是要横向比的。 */
  const unfinished = x.dropouts.reduce((acc, d) => {
    if (d.visitsPlanned <= 0) return acc + 1;          // 没有计划表，视为整例未完成
    const done = Math.min(d.visitsDone, d.visitsPlanned);
    return acc + (1 - done / d.visitsPlanned);
  }, 0);
  const dropoutDeduction = roundCents(-unfinished * x.unitPriceCents);

  const screenFailFee =
    roundCents(x.screenFailed * x.unitPriceCents * x.screenFailFeeRate);

  return {
    startup, enrollment, dropoutDeduction, screenFailFee,
    total: startup + enrollment + dropoutDeduction + screenFailFee,
    calcVersion: CALC_VERSION
  };
}
