import { describe, it, expect } from "vitest";
import { intakeMath, filingGap, INTAKE_GM_GATE } from "../src/intake.js";

/* ════════════════════════════════════════════════════════════════════
   立项测算。

   这一组盯的是**这套数怎么骗人**：
     · 合同额为 0 算成毛利率 0% —— 「白做」和「还没定价」是两回事；
     · 建得比合同多显示成负数 —— 读的人看不懂；
     · 只给毛利率不给保本合同额 —— 谈判桌上用不上。
   ════════════════════════════════════════════════════════════════════ */

const base = {
  contractCents: 760_0000_00, estimatedCostCents: 604_2000_00,
  plannedSubjects: 120, plannedSites: 8
};

describe("立项测算", () => {
  it("毛利率与越线判定 —— 原型那条 20.5% 的申请", () => {
    const m = intakeMath(base);
    expect(m.grossMargin).toBeCloseTo(0.205, 3);
    expect(m.belowGate).toBe(true);
    expect(m.grossCents).toBe(760_0000_00 - 604_2000_00);
  });

  it("刚好卡在门槛上不算越线", () => {
    const cost = 750_0000_00;
    const m = intakeMath({ ...base, contractCents: cost / (1 - INTAKE_GM_GATE),
      estimatedCostCents: cost });
    expect(m.grossMargin).toBeCloseTo(INTAKE_GM_GATE, 6);
    expect(m.belowGate).toBe(false);
  });

  it("**合同额为 0 时毛利率是 null，且当作越线**", () => {
    const m = intakeMath({ ...base, contractCents: 0 });
    expect(m.grossMargin).toBeNull();
    /* 「白做」和「还没定价」是两回事。后者伪装成前者会直接触发退回，
       而它其实只是需要有人先把价格填上。 */
    expect(m.belowGate).toBe(true);
  });

  it("**保本合同额比毛利率更能推动谈判**", () => {
    const m = intakeMath(base);
    /* 604.2 万成本要够 25% 门槛，合同额至少 805.6 万 */
    expect(m.breakEvenContractCents).toBe(Math.round(604_2000_00 / 0.75));
    expect(m.breakEvenContractCents).toBeGreaterThan(base.contractCents);
  });

  it("单例单价与每中心例数都给 —— 后者是入组难度的第一个信号", () => {
    const m = intakeMath(base);
    expect(m.perSubjectCents).toBe(Math.round(760_0000_00 / 120));
    expect(m.subjectsPerSite).toBeCloseTo(15, 6);
  });

  it("例数或中心数为 0 时返回 null，不是 0", () => {
    const m = intakeMath({ ...base, plannedSubjects: 0, plannedSites: 0 });
    expect(m.perSubjectCents).toBeNull();
    expect(m.subjectsPerSite).toBeNull();
  });
});

describe("建档滞后", () => {
  it("合同 16 个中心、建了 12 个 —— 差的四个成本已经在发生", () => {
    const g = filingGap(16, 12);
    expect(g.missing).toBe(4);
    expect(g.filedRatio).toBeCloseTo(0.75, 6);
  });

  it("建齐了就是 0", () => {
    expect(filingGap(8, 8).missing).toBe(0);
  });

  it("**建得比合同多不算负数** —— 那是合同变更那一页的事", () => {
    const g = filingGap(6, 8);
    expect(g.missing).toBe(0);
    expect(g.filedRatio).toBeCloseTo(8 / 6, 6);
  });

  it("**计划为 0 时完成度是 null，不是 100%** —— 那是数据问题", () => {
    expect(filingGap(0, 0).filedRatio).toBeNull();
  });
});
