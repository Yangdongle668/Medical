import { describe, it, expect } from "vitest";
import {
  quote, SCREEN_FAIL_DAYS, SCREEN_FAIL_FEE_RATIO,
  type QuoteParams, type QuoteRates
} from "../src/quote.js";

/* ════════════════════════════════════════════════════════════════════
   报价模型。

   最要紧的一条：**筛败率漏掉会同时低估成本和收入。**
   所以这里的断言大半围着它转 —— 一个 50% 筛败率的项目，
   漏算它等于漏掉三分之一的 CRC 人天，而报价单上看不出来。
   ════════════════════════════════════════════════════════════════════ */

const rates: QuoteRates = {
  crcDayCents: 129_800, craDayCents: 211_200,
  travelPerTripCents: 285_000, overheadRatio: 0.12
};
const p: QuoteParams = {
  sites: 12, subjectsPerSite: 20, months: 20, visits: 11,
  complexity: 1.2, imvIntervalMonths: 1.5, crcFte: 0.55,
  screenFailRate: 0.35, targetMargin: 0.30
};

describe("筛败", () => {
  it("筛选例数 = 入组 ÷ (1 − 筛败率)", () => {
    const r = quote({ ...p, sites: 10, subjectsPerSite: 10, screenFailRate: 0.5 }, rates);
    expect(r.enrolled).toBe(100);
    expect(r.screened).toBe(200);
    expect(r.screenFailed).toBe(100);
  });

  it("**筛败率抬高会同时抬高成本和收入** —— 两边都动才算算对了", () => {
    const low = quote({ ...p, screenFailRate: 0 }, rates);
    const high = quote({ ...p, screenFailRate: 0.5 }, rates);
    expect(high.totalCostCents).toBeGreaterThan(low.totalCostCents);
    expect(high.screenFailRevenueCents).toBeGreaterThan(0);
    expect(low.screenFailRevenueCents).toBe(0);
  });

  it("筛败的人天进 CRC，且按复杂度系数放大", () => {
    const r = quote({ ...p, complexity: 1 }, rates);
    expect(r.crcBreakdown.screenFail)
      .toBeCloseTo(r.screenFailed * SCREEN_FAIL_DAYS, 6);
    const cx = quote({ ...p, complexity: 2 }, rates);
    expect(cx.crcBreakdown.screenFail).toBeCloseTo(r.crcBreakdown.screenFail * 2, 6);
  });

  it("单价的分母是「入组 + 筛败折算」，不是入组例数", () => {
    const r = quote(p, rates);
    expect(r.billableUnits)
      .toBeCloseTo(r.enrolled + r.screenFailed * SCREEN_FAIL_FEE_RATIO, 6);
    /* 按入组例数摊会把单价报高，进而丢标 —— 这正是历史上那次
       "差 19%"复盘出来的一半原因。 */
    expect(r.unitPriceCents).toBeLessThan(r.quoteCents / r.enrolled);
  });

  it("筛败率 100% 不给 Infinity —— 那是参数填错了，不是要筛无穷多例", () => {
    const r = quote({ ...p, screenFailRate: 1 }, rates);
    expect(Number.isFinite(r.totalCostCents)).toBe(true);
    expect(r.screened).toBe(r.enrolled);
    expect(r.screenFailed).toBe(0);
  });
});

describe("人天拆解", () => {
  it("四段加起来等于 CRC 总人天 —— 被压价时要说得出砍的是哪一段", () => {
    const r = quote(p, rates);
    const { setup, onsite, visits, screenFail } = r.crcBreakdown;
    expect(setup + onsite + visits + screenFail).toBeCloseTo(r.crcDays, 6);
  });

  it("四段加起来等于 CRA 总人天", () => {
    const r = quote(p, rates);
    const { siv, imv, closeout, reporting } = r.craBreakdown;
    expect(siv + imv + closeout + reporting).toBeCloseTo(r.craDays, 6);
  });

  it("**CRC 驻场 FTE 是最敏感的一个参数**", () => {
    /* 历史上那次失标（差 19%）的复盘结论：我们按 0.8 FTE 报，对手按 0.5。
       0.55 → 0.8 的成本涨幅必须看得见，否则这一页就没有存在的意义。 */
    const ours = quote({ ...p, crcFte: 0.8 }, rates);
    const theirs = quote({ ...p, crcFte: 0.5 }, rates);
    expect(ours.quoteCents / theirs.quoteCents).toBeGreaterThan(1.15);
  });

  it("监查间隔越短，IMV 次数与差旅越多", () => {
    const dense = quote({ ...p, imvIntervalMonths: 1 }, rates);
    const sparse = quote({ ...p, imvIntervalMonths: 3 }, rates);
    expect(dense.imvCount).toBeGreaterThan(sparse.imvCount);
    expect(dense.trips).toBeGreaterThan(sparse.trips);
    expect(dense.travelCostCents).toBeGreaterThan(sparse.travelCostCents);
  });
});

describe("钱", () => {
  it("报价 = 成本 ÷ (1 − 目标毛利率)，且毛利率对得上", () => {
    const r = quote(p, rates);
    expect(r.quoteCents).toBeCloseTo(r.totalCostCents / (1 - p.targetMargin), 0);
    const margin = (r.quoteCents - r.totalCostCents) / r.quoteCents;
    expect(margin).toBeCloseTo(p.targetMargin, 4);
  });

  it("四项成本加起来等于总成本", () => {
    const r = quote(p, rates);
    expect(r.crcCostCents + r.craCostCents + r.travelCostCents + r.overheadCents)
      .toBe(r.totalCostCents);
  });

  it("管理分摊只按**直接人力**算，不含差旅", () => {
    const r = quote(p, rates);
    expect(r.overheadCents)
      .toBe(Math.round((r.crcCostCents + r.craCostCents) * rates.overheadRatio));
  });

  it("**费率变了报价就变** —— 它读的是费率卡，不是常量", () => {
    const cheap = quote(p, rates);
    const dear = quote(p, { ...rates, crcDayCents: rates.crcDayCents * 1.1 });
    expect(dear.quoteCents).toBeGreaterThan(cheap.quoteCents);
  });

  it("金额一律整数分", () => {
    const r = quote(p, rates);
    for (const v of [r.crcCostCents, r.craCostCents, r.travelCostCents,
                     r.overheadCents, r.totalCostCents, r.quoteCents,
                     r.unitPriceCents, r.screenFailRevenueCents])
      expect(Number.isInteger(v), `${v} 不是整数分`).toBe(true);
  });

  it("目标毛利率 100% 不给 Infinity", () => {
    const r = quote({ ...p, targetMargin: 1 }, rates);
    expect(Number.isFinite(r.quoteCents)).toBe(true);
  });
});

describe("和「成本与毛利」那一页可比", () => {
  it("人天/例是 (CRC + CRA) ÷ 入组例数 —— 同名指标必须同口径", () => {
    const r = quote(p, rates);
    expect(r.daysPerSubject).toBeCloseTo((r.crcDays + r.craDays) / r.enrolled, 6);
  });

  it("一个中心都不投时不炸，也不给 NaN", () => {
    const r = quote({ ...p, sites: 0 }, rates);
    expect(r.enrolled).toBe(0);
    expect(r.daysPerSubject).toBe(0);
    expect(r.unitPriceCents).toBe(0);
  });
});
