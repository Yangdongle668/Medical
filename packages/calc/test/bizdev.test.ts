import { describe, it, expect } from "vitest";
import {
  reviewBids, scopeCreep, changeDays,
  type BidRecord, type ChangeRecord
} from "../src/bizdev.js";

/* ════════════════════════════════════════════════════════════════════
   投标复盘 · scope creep。

   两组断言都围着同一件事：**不知道 ≠ 零。**
     · 问不到对手报价的那几标，不能当成"和我们报得一样"；
     · 变更金额为 NULL（还没谈）和为 0（谈过了不给钱）不是一回事。
   两处只要把 null 当 0，一次亏得很惨的事在统计上就毫无痕迹。
   ════════════════════════════════════════════════════════════════════ */

const bid = (o: Partial<BidRecord> = {}): BidRecord => ({
  status: "won", ourQuoteCents: 100_000_00, ourPersonDays: 400,
  subjects: 100, winningPriceCents: 100_000_00, ...o
});

describe("投标复盘", () => {
  it("中标率的分母是**已出结果的**，不是全部", () => {
    const r = reviewBids([
      bid({ status: "won" }), bid({ status: "lost", winningPriceCents: 90_000_00 }),
      bid({ status: "pending", winningPriceCents: null })
    ]);
    expect(r.total).toBe(3);
    expect(r.decided).toBe(2);
    expect(r.winRate).toBe(0.5);
  });

  it("一标未决时中标率是 null，不是 0", () => {
    /* 「没有分母」和「一个都没中」是两回事 —— 前者该显示「—」。 */
    const r = reviewBids([bid({ status: "pending", winningPriceCents: null })]);
    expect(r.winRate).toBeNull();
    expect(r.priceBias).toBeNull();
  });

  it("**问不到对手价的那几标不进偏差统计**", () => {
    /* 把 null 当成"和我们一样"会把偏差算成 0，
       于是一次输得很惨的标在统计上看起来毫无问题。 */
    const withUnknown = reviewBids([
      bid({ status: "lost", ourQuoteCents: 120_00, winningPriceCents: 100_00 }),
      bid({ status: "lost", ourQuoteCents: 200_00, winningPriceCents: null })
    ]);
    expect(withUnknown.biasSamples).toBe(1);
    expect(withUnknown.priceBias).toBeCloseTo(0.2, 6);
  });

  it("正数 = 系统性报高", () => {
    const r = reviewBids([
      bid({ status: "lost", ourQuoteCents: 121_00, winningPriceCents: 100_00 }),
      bid({ status: "lost", ourQuoteCents: 119_00, winningPriceCents: 100_00 })
    ]);
    expect(r.priceBias).toBeCloseTo(0.2, 6);
    expect(r.lostBias).toBeCloseTo(0.2, 6);
  });

  it("**失标偏差比总体偏差有用** —— 中标的天然贴着成交价", () => {
    const r = reviewBids([
      /* 中标：成交价就是我们的价，偏差 0 */
      bid({ status: "won", ourQuoteCents: 100_00, winningPriceCents: 100_00 }),
      bid({ status: "won", ourQuoteCents: 100_00, winningPriceCents: 100_00 }),
      /* 失标：差 30% */
      bid({ status: "lost", ourQuoteCents: 130_00, winningPriceCents: 100_00 })
    ]);
    expect(r.priceBias).toBeCloseTo(0.1, 6);   // 被中标的两条稀释了
    expect(r.lostBias).toBeCloseTo(0.3, 6);    // 真相在这里
    expect(r.lostBiasSamples).toBe(1);
  });

  it("样本数要下发 —— 一个样本和二十个样本不是一回事", () => {
    const r = reviewBids([bid({ status: "lost", winningPriceCents: 80_00 })]);
    expect(r.biasSamples).toBe(1);
  });

  it("中标金额按成交价算，不按报价", () => {
    const r = reviewBids([
      bid({ status: "won", ourQuoteCents: 100_00, winningPriceCents: 94_00 })
    ]);
    expect(r.wonAmountCents).toBe(94_00);
    expect(r.bidAmountCents).toBe(100_00);
  });

  it("人天/例取中位数 —— 一个 2 例的 BE 试验会把均值拖走", () => {
    const r = reviewBids([
      bid({ status: "lost", ourPersonDays: 980, subjects: 48 }),   // 20.4
      bid({ status: "won", ourPersonDays: 400, subjects: 100 }),   // 4.0
      bid({ status: "won", ourPersonDays: 420, subjects: 100 })    // 4.2
    ]);
    expect(r.medianDaysPerSubject).toBeCloseTo(4.2, 6);
  });

  it("偶数条时取中间两条的平均", () => {
    const r = reviewBids([
      bid({ status: "won", ourPersonDays: 100, subjects: 100 }),   // 1
      bid({ status: "won", ourPersonDays: 300, subjects: 100 })    // 3
    ]);
    expect(r.medianDaysPerSubject).toBe(2);
  });
});

const chg = (o: Partial<ChangeRecord> = {}): ChangeRecord => ({
  status: "draft", personDaysImpact: 10, perSubject: false,
  affectedSubjects: 0, amountCents: null, ...o
});
const CRC_DAY = 129_800;

describe("scope creep", () => {
  it("每例的变更要乘以受影响例数", () => {
    expect(changeDays(chg({ perSubject: true, personDaysImpact: 1.5, affectedSubjects: 143 })))
      .toBeCloseTo(214.5, 6);
    expect(changeDays(chg({ perSubject: false, personDaysImpact: 260 }))).toBe(260);
  });

  it("**三种「没有对应金额」都算** —— 还没提、提了没签、明确不给钱", () => {
    const r = scopeCreep([
      chg({ status: "draft", personDaysImpact: 10 }),
      chg({ status: "submitted", personDaysImpact: 20 }),
      chg({ status: "rejected", personDaysImpact: 30 })
    ], CRC_DAY);
    expect(r.uncoveredDays).toBe(60);
    expect(r.openCount).toBe(3);
  });

  it("**已签署但金额为 0 的不算欠账** —— 那是谈过之后的决定", () => {
    /* 0 和 NULL 在这里差别极大：0 是"对方不给钱，我们认了"，
       NULL 是"还没谈"。前者是决策，后者是欠账。 */
    const r = scopeCreep([
      chg({ status: "signed", personDaysImpact: 100, amountCents: 0 })
    ], CRC_DAY);
    expect(r.uncoveredDays).toBe(0);
    expect(r.signedDays).toBe(100);
    expect(r.signedAmountCents).toBe(0);
  });

  it("折成钱按 CRC 人天成本", () => {
    const r = scopeCreep([chg({ personDaysImpact: 10 })], CRC_DAY);
    expect(r.uncoveredCents).toBe(10 * CRC_DAY);
    expect(Number.isInteger(r.uncoveredCents)).toBe(true);
  });

  it("**覆盖率的分母用绝对值** —— 负人天不该把分母做小", () => {
    /* 减了 180 人天（已签）、加了 200 人天没要到钱：
       直接相加的话分母是 20，覆盖率算出 900%。 */
    const r = scopeCreep([
      chg({ status: "signed", personDaysImpact: -180, amountCents: -18_50_000 }),
      chg({ status: "submitted", personDaysImpact: 200 })
    ], CRC_DAY);
    expect(r.coverage).toBeCloseTo(180 / 380, 6);
    expect(r.coverage!).toBeLessThan(1);
  });

  it("一条变更都没有时覆盖率是 null，不是 0 或 1", () => {
    expect(scopeCreep([], CRC_DAY).coverage).toBeNull();
  });

  it("原型里那条「白做 114 人天」算得出来", () => {
    /* CR-010：每例 0.8 人天、全项目 143 例、申办方不追加费用（未获批）。 */
    const r = scopeCreep([
      chg({ status: "rejected", perSubject: true,
            personDaysImpact: 0.8, affectedSubjects: 143 })
    ], CRC_DAY);
    expect(r.uncoveredDays).toBeCloseTo(114.4, 6);
    expect(r.coverage).toBe(0);
  });
});
