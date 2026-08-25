import { CALC_VERSION, HOURS_PER_DAY, roundCents, ratio, type Cents } from "./kernel.js";

/* ════════════════════════════════════════════════════════════════════
   成本与毛利。

   I1：工时必须归属唯一 StudySite，`billable` 由工作类型推导后**落库固化**，
       此后不随类型定义变更而改变。
       —— 「内部培训」今天不可计费，明年改成可计费，去年的工时不能因此
       变成可计费的。历史事实不能被今天的配置改写。

   I2：成本 = 人天 × **提交时生效的费率卡**，落库快照。
       —— 2026 年 CRC 人天从 0.118 万涨到 0.13 万，若只存一个常量，
       调价当天所有历史项目的毛利会集体变化，且无法向任何人解释。
   ════════════════════════════════════════════════════════════════════ */

/** 一条工时的成本快照。**提交时算一次，此后不再重算。** */
export function entryCostCents(
  hours: number, dayCostCents: Cents, travelCents: Cents = 0
): Cents {
  if (hours <= 0) throw new RangeError("工时必须为正");
  return roundCents((hours / HOURS_PER_DAY) * dayCostCents) + travelCents;
}

/** 已作废的工时不计入任何统计 —— 它的成本由冲销记录抵掉。 */
export interface CostEntry {
  costCents: Cents;
  billable: boolean;
  hours: number;
  voided: boolean;
}

export interface CostBreakdown {
  /** 直接人力 + 差旅，仅未作废 */
  directCents: Cents;
  billableCents: Cents;
  nonBillableCents: Cents;
  /** 管理分摊 = 直接成本 × overheadRate */
  overheadCents: Cents;
  totalCents: Cents;
  personDays: number;
  /** 不可计费占比：它高，说明人力花在了卖不出去的事情上 */
  nonBillableShare: number | null;
  calcVersion: string;
}

export function siteCost(
  entries: readonly CostEntry[], overheadRate: number
): CostBreakdown {
  const live = entries.filter(e => !e.voided);
  const direct = live.reduce((a, e) => a + e.costCents, 0);
  const billable = live.filter(e => e.billable).reduce((a, e) => a + e.costCents, 0);
  const overhead = roundCents(direct * overheadRate);
  const hours = live.reduce((a, e) => a + e.hours, 0);
  return {
    directCents: direct,
    billableCents: billable,
    nonBillableCents: direct - billable,
    overheadCents: overhead,
    totalCents: direct + overhead,
    personDays: hours / HOURS_PER_DAY,
    nonBillableShare: ratio(direct - billable, direct),
    calcVersion: CALC_VERSION
  };
}

export interface Margin {
  revenueCents: Cents;
  costCents: Cents;
  grossProfitCents: Cents;
  /** 毛利率。收入为 0 时是 null，不是 0 —— 「还没有收入」不等于「毛利率 0%」 */
  grossMargin: number | null;
  /** 每例入组成本 */
  costPerEnrolledCents: Cents | null;
  calcVersion: string;
}

export function siteMargin(
  revenueCents: Cents, costCents: Cents, enrolled: number
): Margin {
  const gp = revenueCents - costCents;
  return {
    revenueCents, costCents, grossProfitCents: gp,
    grossMargin: revenueCents > 0 ? gp / revenueCents : null,
    costPerEnrolledCents: enrolled > 0 ? roundCents(costCents / enrolled) : null,
    calcVersion: CALC_VERSION
  };
}
