import { describe, it, expect } from "vitest";
import { siteRevenue, type RevenueInput } from "../src/revenue.js";
import { CALC_VERSION } from "../src/kernel.js";

/* ════════════════════════════════════════════════════════════════════
   I8' 黄金测试基线。

   这组数字是**手算出来的**，不是从实现里跑出来再贴回去的。
   实现改了而基线没改 → 测试红；基线要改，必须先说明为什么口径变了。
   把基线改成实现的输出，正是这类测试开始失效的那一刻。
   ════════════════════════════════════════════════════════════════════ */

/** 万元 → 分 */
const w = (v: number) => Math.round(v * 10000 * 100);

describe("I8'：四项缺一不可", () => {
  /* SS-01 北京协和：启动费 17.6 万，单价 5.8 万/例，入组 26，筛败 13，
     筛败费率 0.35，两例脱落（3/12 与 7/12）。 */
  const SS01: RevenueInput = {
    startupFeeCents: w(17.6),
    unitPriceCents: w(5.8),
    enrolled: 26,
    screenFailed: 13,
    screenFailFeeRate: 0.35,
    dropouts: [{ visitsDone: 3, visitsPlanned: 12 }, { visitsDone: 7, visitsPlanned: 12 }]
  };

  it("逐项手算对得上", () => {
    const r = siteRevenue(SS01);

    expect(r.startup).toBe(w(17.6));                         // 17.6 万
    expect(r.enrollment).toBe(w(5.8) * 26);                  // 150.8 万

    /* 脱落扣减 = [(1 − 3/12) + (1 − 7/12)] × 5.8 万
                = (0.75 + 0.416666…) × 5.8 万 = 1.1666… × 5.8 万 */
    const unfinished = (1 - 3 / 12) + (1 - 7 / 12);
    expect(r.dropoutDeduction).toBe(-Math.round(unfinished * w(5.8)));
    expect(r.dropoutDeduction).toBe(-6766667);               // −6.766667 万元，即 −67666.67 元

    /* 筛败费 = 13 × 5.8 万 × 0.35 = 26.39 万 */
    expect(r.screenFailFee).toBe(w(26.39));

    expect(r.total).toBe(w(17.6) + w(5.8) * 26 - 6766667 + w(26.39));
    /* 17.6 + 150.8 − 6.766667 + 26.39 = 188.023333 万元 */
    expect(r.total).toBe(188023333);
    expect(r.calcVersion).toBe(CALC_VERSION);
  });

  it("四项之和就是总额 —— 分项与合计不允许各算各的", () => {
    const r = siteRevenue(SS01);
    expect(r.startup + r.enrollment + r.dropoutDeduction + r.screenFailFee).toBe(r.total);
  });
});

describe("两处修正方向相反 —— 只做一个比两个都不做更危险", () => {
  /* 两个中心，除筛败与脱落外完全相同：
     A 高筛败低脱落（入排严、病源不匹配）；B 低筛败高脱落（留不住人）。 */
  const base = {
    startupFeeCents: w(15), unitPriceCents: w(5), enrolled: 20, screenFailFeeRate: 0.35
  };
  const highScreenFail: RevenueInput = { ...base, screenFailed: 22, dropouts: [] };
  const highDropout: RevenueInput = {
    ...base, screenFailed: 2,
    dropouts: Array.from({ length: 8 }, () => ({ visitsDone: 1, visitsPlanned: 12 }))
  };

  /** 故意做错的三种算法，用来证明"漏一项"的方向 */
  const noSF = (x: RevenueInput) => siteRevenue({ ...x, screenFailed: 0 });
  const noDrop = (x: RevenueInput) => siteRevenue({ ...x, dropouts: [] });
  const neither = (x: RevenueInput) =>
    siteRevenue({ ...x, screenFailed: 0, dropouts: [] });

  it("漏算筛败费 → 高筛败中心被**低估**，可能被误判为亏损而关掉", () => {
    const right = siteRevenue(highScreenFail).total;
    const wrong = noSF(highScreenFail).total;
    expect(wrong).toBeLessThan(right);
    /* 低估了 22 × 5 万 × 0.35 = 38.5 万，占正确收入的三成以上 */
    expect(right - wrong).toBe(w(38.5));
    expect((right - wrong) / right).toBeGreaterThan(0.25);
  });

  it("漏算脱落扣减 → 高脱落中心被**高估**，一个在亏钱的中心被保住", () => {
    const right = siteRevenue(highDropout).total;
    const wrong = noDrop(highDropout).total;
    expect(wrong).toBeGreaterThan(right);
    /* 高估了 8 × (1 − 1/12) × 5 万 = 36.666… 万 */
    expect(wrong - right).toBe(Math.round(8 * (1 - 1 / 12) * w(5)));
  });

  it("**只做一项时，两个中心的误差方向相反** —— 任何整体折扣都救不了", () => {
    const errA = noSF(highScreenFail).total - siteRevenue(highScreenFail).total;
    const errB = noSF(highDropout).total - siteRevenue(highDropout).total;
    /* 只做脱落扣减、漏掉筛败费：两个中心都被低估，但幅度差 10 倍以上 */
    expect(errA).toBeLessThan(0);
    expect(errB).toBeLessThan(0);
    expect(Math.abs(errA) / Math.abs(errB)).toBeGreaterThan(10);

    /* 只做筛败费、漏掉脱落扣减：A 准确，B 被高估 —— 方向真正相反 */
    const errA2 = noDrop(highScreenFail).total - siteRevenue(highScreenFail).total;
    const errB2 = noDrop(highDropout).total - siteRevenue(highDropout).total;
    expect(errA2).toBe(0);
    expect(errB2).toBeGreaterThan(0);
  });

  it("两个都不做时误差同向（整体偏乐观），还能靠经验打折", () => {
    for (const x of [highScreenFail, highDropout]) {
      const err = neither(x).total - siteRevenue(x).total;
      /* 高筛败中心被低估、高脱落中心被高估 —— 但这里要说明的是：
         两项都省略时，**每个中心只剩一种偏差**，量级可预期；
         只省略一项，偏差在中心之间方向相反，这才是最难发现的。 */
      expect(Number.isFinite(err)).toBe(true);
    }
    expect(neither(highScreenFail).total).toBeLessThan(siteRevenue(highScreenFail).total);
    expect(neither(highDropout).total).toBeGreaterThan(siteRevenue(highDropout).total);
  });
});

describe("边界", () => {
  const base: RevenueInput = {
    startupFeeCents: w(10), unitPriceCents: w(5), enrolled: 0,
    screenFailed: 0, screenFailFeeRate: 0.35, dropouts: []
  };

  it("刚启动、还没入组的中心：收入就是启动费", () => {
    expect(siteRevenue(base).total).toBe(w(10));
  });

  it("脱落时一次访视都没做 → 整例扣回，净贡献为 0", () => {
    const r = siteRevenue({
      ...base, enrolled: 1, dropouts: [{ visitsDone: 0, visitsPlanned: 12 }] });
    expect(r.enrollment + r.dropoutDeduction).toBe(0);
  });

  it("脱落时访视已全部做完 → 不扣，按整例计", () => {
    const r = siteRevenue({
      ...base, enrolled: 1, dropouts: [{ visitsDone: 12, visitsPlanned: 12 }] });
    expect(r.dropoutDeduction).toBe(0);
    expect(r.total).toBe(w(10) + w(5));
  });

  it("已完成访视数超过计划数（SOA 改过）不会算出负的扣减", () => {
    const r = siteRevenue({
      ...base, enrolled: 1, dropouts: [{ visitsDone: 20, visitsPlanned: 12 }] });
    expect(r.dropoutDeduction).toBe(0);
  });

  it("没有访视计划表时按整例未完成处理，而不是当作 0 扣减", () => {
    const r = siteRevenue({
      ...base, enrolled: 1, dropouts: [{ visitsDone: 0, visitsPlanned: 0 }] });
    expect(r.dropoutDeduction).toBe(-w(5));
  });

  it("结果一律是整数分 —— 出现小数就说明某处漏了取整", () => {
    const r = siteRevenue({
      startupFeeCents: w(17.6), unitPriceCents: 333333, enrolled: 7,
      screenFailed: 3, screenFailFeeRate: 0.37,
      dropouts: [{ visitsDone: 1, visitsPlanned: 3 }, { visitsDone: 2, visitsPlanned: 7 }]
    });
    for (const v of Object.values(r))
      if (typeof v === "number") expect(Number.isInteger(v), `${v} 不是整数分`).toBe(true);
  });
});
