import { roundCents, type Cents } from "./kernel.js";

/* ════════════════════════════════════════════════════════════════════
   报价模型。

   ── 报价不是拍脑袋，是把自己的成本数据库重新展开一次 ──────────────
   对手报价靠经验，这边靠**历史真实人天**：同样一条算式，
   代进历史项目的参数应该算得出历史的实际成本 ——
   算不出，说明这套口径和「工时与差旅」「成本与毛利」不是一回事，
   而那意味着报价用的是一套账、结算用的是另一套。

   所以人天口径与 `siteCost` 完全一致，费率来自**费率卡**
   （`rate_card`，随时间生效），不是写死的常量。

   ── 筛败率是这套算式里最容易漏、代价最大的一项 ────────────────────
   漏掉它会**同时低估成本和收入**：
     · 成本：筛败的每一例都要做知情、入排核对、筛选期检查陪同 ——
       CRC 的活一点没少，只是这一例没入组；
     · 收入：合同如果按「入组例数 × 单价」计价，那这部分工作量白做。
   肿瘤 II/III 期筛败率常见 45%–60%，慢病 20%–35%。
   一个 50% 筛败率的项目，漏算它等于漏掉三分之一的 CRC 人天。

   历史上那次失标（RP-33 III 期，差 19%）复盘出来的结论是同一件事的
   另一面：我们按 0.8 FTE 报 CRC 驻场，对手按 0.5 —— 参数错了，
   不是算式错了。所以这一页的每个参数都摆在滑块上，且标着经验区间。
   ════════════════════════════════════════════════════════════════════ */

/** 每例筛败消耗的 CRC 人天：知情、入排核对、筛选期检查陪同。 */
export const SCREEN_FAIL_DAYS = 1.6;

/** 筛败按入组单价的几折计价。
 *  合同里通常谈得下来一个「筛败费」，但不会是全价 ——
 *  0.3 是行业常见口径。它进单价的分母，所以**报价时就要摊进去**，
 *  否则筛败率一高，实际收到的钱就比报价时算的少一截。 */
export const SCREEN_FAIL_FEE_RATIO = 0.3;

/** 月均工作日。口径的一部分：按 21.75 还是 22 折算，
 *  一个 20 个月的项目 CRC 驻场人天差 5 天。 */
export const WORKDAYS_PER_MONTH = 21.75;

/** 费率。**从费率卡读，不写死。** 调价是两步（现行卡收口 + 新卡生效），
 *  报价模型必须读**当天现行**的那一张 —— 拿一张已收口的费率卡报出去的价，
 *  签下来就是直接的毛利缺口。 */
export interface QuoteRates {
  crcDayCents: Cents;
  craDayCents: Cents;
  /** CRA 单次现场监查的差旅 */
  travelPerTripCents: Cents;
  /** PM / QA / 职能分摊，按直接人力成本的比例 */
  overheadRatio: number;
}

export interface QuoteParams {
  sites: number;
  /** 每中心入组例数 */
  subjectsPerSite: number;
  /** 入组期（月） */
  months: number;
  /** 每例访视次数 */
  visits: number;
  /** 方案复杂度系数。肿瘤 / 罕见病 1.3–1.8；慢病 1.0 */
  complexity: number;
  /** 监查间隔（月/次） */
  imvIntervalMonths: number;
  /** CRC 驻场 FTE */
  crcFte: number;
  /** 预期筛败率 */
  screenFailRate: number;
  /** 目标毛利率 */
  targetMargin: number;
}

export interface QuoteResult {
  /** 入组例数 */
  enrolled: number;
  /** 需筛选例数（含筛败） */
  screened: number;
  screenFailed: number;

  crcDays: number;
  craDays: number;
  /** CRC 人天的四段拆解 —— 报价被压价时，砍的是哪一段要说得出来 */
  crcBreakdown: { setup: number; onsite: number; visits: number; screenFail: number };
  craBreakdown: { siv: number; imv: number; closeout: number; reporting: number };
  imvCount: number;
  trips: number;

  crcCostCents: Cents;
  craCostCents: Cents;
  travelCostCents: Cents;
  overheadCents: Cents;
  totalCostCents: Cents;

  /** 建议报价总额 = 成本 ÷ (1 − 目标毛利率) */
  quoteCents: Cents;
  /** 单例报价。**分母是「入组 + 筛败折算」**，不是入组例数 */
  unitPriceCents: Cents;
  billableUnits: number;
  /** 其中来自筛败费的收入 —— 它不该是意外之财，是算进去的 */
  screenFailRevenueCents: Cents;
  /** 人天 / 例。和「成本与毛利」那一页的同名指标必须可比 */
  daysPerSubject: number;
}

export function quote(p: QuoteParams, r: QuoteRates): QuoteResult {
  const enrolled = p.sites * p.subjectsPerSite;
  /* 筛败率 1 时分母为 0 —— 那不是"要筛无穷多例"，是参数填错了。
     退回"筛多少入多少"，让界面上的数保持有限，而不是显示 Infinity。 */
  const screened = p.screenFailRate < 1
    ? enrolled / (1 - p.screenFailRate) : enrolled;
  const screenFailed = Math.round(screened - enrolled);

  /* ── CRC 人天 ────────────────────────────────────────────────── */
  const setup = p.sites * 12;                                   // 每中心启动 + 关闭固定
  const onsite = p.sites * p.months * WORKDAYS_PER_MONTH * p.crcFte;
  const visits = enrolled * p.visits * 0.5 * p.complexity;
  const screenFail = screenFailed * SCREEN_FAIL_DAYS * p.complexity;
  const crcDays = setup + onsite + visits + screenFail;

  /* ── CRA 人天 ────────────────────────────────────────────────── */
  const imvCount = Math.round(p.months / p.imvIntervalMonths);
  const siv = p.sites * 2;
  const imv = p.sites * imvCount * 1.5;
  const closeout = p.sites * 1.5;
  /* 远程跟进与报告：现场每花一天，回来还要写。0.6 是历史工时反推的。 */
  const reporting = (siv + imv + closeout) * 0.6;
  const craDays = siv + imv + closeout + reporting;

  /* ── 钱 ─────────────────────────────────────────────────────── */
  const trips = p.sites * (imvCount + 2);                       // IMV + SIV + 关中心
  const crcCostCents = roundCents(crcDays * r.crcDayCents);
  const craCostCents = roundCents(craDays * r.craDayCents);
  const travelCostCents = roundCents(trips * r.travelPerTripCents);
  const overheadCents = roundCents((crcCostCents + craCostCents) * r.overheadRatio);
  const totalCostCents =
    crcCostCents + craCostCents + travelCostCents + overheadCents;

  /* 目标毛利率 1 时除以 0。同上：参数错了，不是无穷大。 */
  const quoteCents = p.targetMargin < 1
    ? roundCents(totalCostCents / (1 - p.targetMargin)) : totalCostCents;

  const billableUnits = enrolled + screenFailed * SCREEN_FAIL_FEE_RATIO;
  const unitPriceCents = billableUnits > 0
    ? roundCents(quoteCents / billableUnits) : 0;

  return {
    enrolled, screened: Math.round(screened), screenFailed,
    crcDays, craDays,
    crcBreakdown: { setup, onsite, visits, screenFail },
    craBreakdown: { siv, imv, closeout, reporting },
    imvCount, trips,
    crcCostCents, craCostCents, travelCostCents, overheadCents, totalCostCents,
    quoteCents, unitPriceCents, billableUnits,
    screenFailRevenueCents:
      roundCents(screenFailed * SCREEN_FAIL_FEE_RATIO * unitPriceCents),
    daysPerSubject: enrolled > 0 ? (crcDays + craDays) / enrolled : 0
  };
}
