import { roundCents, ratio, type Cents } from "./kernel.js";

/* ════════════════════════════════════════════════════════════════════
   投标闭环 · scope creep。

   两套算式，同一条主线：**没有回写就没有校准。**
   报价模型算「按我们的人天该报多少」，这里算「市场认不认」
   和「签完之后多干的活有没有对应的钱」。
   ════════════════════════════════════════════════════════════════════ */

export interface BidRecord {
  status: "pending" | "won" | "lost";
  ourQuoteCents: Cents;
  ourPersonDays: number;
  subjects: number;
  /** 成交价。失标时常常问不到 —— **null 不能当成"和我们一样"**。 */
  winningPriceCents: Cents | null;
}

export interface BidReview {
  total: number;
  decided: number;
  won: number;
  /** 中标率。分母是**已出结果的**，不是全部 ——
   *  还在等的那几个混进分母，会让胜率在开标前一直虚低。 */
  winRate: number | null;

  /** 中标金额合计（按成交价）。 */
  wonAmountCents: Cents;
  /** 已出结果的投标，我们报价的合计 —— 和上面那个数比，就是"报出去 vs 拿回来"。 */
  bidAmountCents: Cents;

  /** 价格偏差：我们的报价相对成交价高多少。
   *  **正数 = 系统性报高。** 只统计知道成交价的那些。 */
  priceBias: number | null;
  /** 只看失标的偏差。它比总体偏差有用得多 ——
   *  中标的那些天然接近成交价（因为成交价往往就是我们的价）。 */
  lostBias: number | null;
  /** 参与偏差统计的样本数。**要下发** —— 一个样本算出来的
   *  "系统性报高 21%" 和二十个样本算出来的，不是一回事。 */
  biasSamples: number;
  lostBiasSamples: number;

  /** 人天/例的中位数。报价模型的输入，就该从这里来。 */
  medianDaysPerSubject: number | null;
}

export function reviewBids(bids: readonly BidRecord[]): BidReview {
  const decided = bids.filter(b => b.status !== "pending");
  const won = decided.filter(b => b.status === "won");

  /* **只统计知道成交价的。** 把 null 当成"和我们一样"会把偏差算成 0，
     于是一次输得很惨的标在统计上看起来毫无问题 —— 那正是这套数
     最容易失真的地方。 */
  const priced = decided.filter(
    (b): b is BidRecord & { winningPriceCents: Cents } =>
      b.winningPriceCents !== null && b.winningPriceCents > 0);
  const lostPriced = priced.filter(b => b.status === "lost");

  const gap = (b: BidRecord & { winningPriceCents: Cents }) =>
    (b.ourQuoteCents - b.winningPriceCents) / b.winningPriceCents;
  const mean = (xs: number[]) =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

  const perSubject = decided
    .filter(b => b.subjects > 0)
    .map(b => b.ourPersonDays / b.subjects)
    .sort((a, b) => a - b);

  return {
    total: bids.length,
    decided: decided.length,
    won: won.length,
    winRate: ratio(won.length, decided.length),
    wonAmountCents: won.reduce(
      (n, b) => n + (b.winningPriceCents ?? b.ourQuoteCents), 0),
    bidAmountCents: decided.reduce((n, b) => n + b.ourQuoteCents, 0),
    priceBias: mean(priced.map(gap)),
    lostBias: mean(lostPriced.map(gap)),
    biasSamples: priced.length,
    lostBiasSamples: lostPriced.length,
    medianDaysPerSubject: median(perSubject)
  };
}

/** 中位数而不是均值：一个 2 例的 BE 试验和一个 600 例的 IV 期
 *  在人天/例上差一个量级，均值会被前者拖走。 */
function median(sorted: readonly number[]): number | null {
  if (!sorted.length) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/* ── scope creep ─────────────────────────────────────────────────── */

export interface ChangeRecord {
  status: "draft" | "submitted" | "signed" | "rejected";
  /** 工作量影响（人天）。可正可负 —— 例数下调是负的。 */
  personDaysImpact: number;
  perSubject: boolean;
  /** 受影响的入组例数。`perSubject` 为 false 时不用。
   *  **每次算，不存** —— 一条"每例多 1.5 人天"的变更真正可怕的地方是
   *  入组越多白做的越多，存一个数会把它冻在提出那天。 */
  affectedSubjects: number;
  amountCents: Cents | null;
}

export interface ScopeCreep {
  /** 没有对应金额的工作量（人天）。**这就是白做的部分。** */
  uncoveredDays: number;
  /** 折成钱。按 CRC 人天成本算 —— 它是这类活的主要承担者。 */
  uncoveredCents: Cents;
  /** 已签署变更带回的金额合计。 */
  signedAmountCents: Cents;
  /** 已签署变更对应的工作量。 */
  signedDays: number;
  openCount: number;
  signedCount: number;
  /** 覆盖率：有钱的工作量 ÷ 全部变更工作量。
   *  **1 是理想，0.6 就该找人谈了。** */
  coverage: number | null;
}

/** 一条变更实际带来多少人天。**每例的要乘以受影响例数。** */
export const changeDays = (c: ChangeRecord): number =>
  c.perSubject ? c.personDaysImpact * c.affectedSubjects : c.personDaysImpact;

export function scopeCreep(
  changes: readonly ChangeRecord[], crcDayCostCents: Cents
): ScopeCreep {
  /* 「没有对应金额」有三种：还没提、提了没签、明确不给钱。
     **三种都算 scope creep** —— 活都在做，钱都没有。
     已签署的不算，哪怕金额是 0：那是谈过之后的决定，不是欠账。 */
  const open = changes.filter(c => c.status !== "signed");
  const signed = changes.filter(c => c.status === "signed");

  const uncoveredDays = open.reduce((n, c) => n + changeDays(c), 0);
  const signedDays = signed.reduce((n, c) => n + changeDays(c), 0);
  const totalDays = uncoveredDays + signedDays;

  return {
    uncoveredDays,
    uncoveredCents: roundCents(uncoveredDays * crcDayCostCents),
    signedAmountCents: signed.reduce((n, c) => n + (c.amountCents ?? 0), 0),
    signedDays,
    openCount: open.length,
    signedCount: signed.length,
    /* 分母用**绝对值**：一条例数下调的负人天不该把分母做小，
       否则"减了 180 人天、加了 200 人天没要到钱"会算出覆盖率 900%。 */
    coverage: ratio(
      Math.abs(signedDays),
      Math.abs(signedDays) + Math.abs(uncoveredDays))
  };
}
