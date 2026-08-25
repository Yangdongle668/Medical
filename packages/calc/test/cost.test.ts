import { describe, it, expect } from "vitest";
import { entryCostCents, siteCost, siteMargin } from "../src/cost.js";
import { HOURS_PER_DAY, roundCents } from "../src/kernel.js";

const w = (v: number) => Math.round(v * 10000 * 100);
/* 原型基线：CRC 内部人天 0.118 万，CRA 0.192 万，管理分摊 12% */
const CRC_DAY = w(0.118), CRA_DAY = w(0.192), OVERHEAD = 0.12;

describe("I2：成本按提交时生效的费率卡快照", () => {
  it("8 小时 = 一个人天", () => {
    expect(entryCostCents(HOURS_PER_DAY, CRC_DAY)).toBe(CRC_DAY);
  });

  it("7.5 小时按比例折算，差旅另计且不打折", () => {
    /* 7.5/8 × 1180 元 = 1106.25 元 = 110625 分 */
    expect(entryCostCents(7.5, CRC_DAY)).toBe(110625);
    expect(entryCostCents(7.5, CRC_DAY, w(0.32))).toBe(110625 + w(0.32));
  });

  it("工时必须为正 —— 0 小时的工时条目没有意义，负数是在偷偷冲销", () => {
    expect(() => entryCostCents(0, CRC_DAY)).toThrow(/工时必须为正/);
    expect(() => entryCostCents(-1, CRC_DAY)).toThrow(/工时必须为正/);
  });

  it("费率卡换了，新工时用新价，旧工时的快照不动", () => {
    const oldRate = entryCostCents(8, w(0.118));
    const newRate = entryCostCents(8, w(0.13));
    expect(newRate).toBeGreaterThan(oldRate);
    /* 关键在于：这是两个独立的返回值，不是同一个函数在不同时间给出不同答案。
       调价当天所有历史项目的毛利集体变化，是没法向任何人解释的。 */
    expect(oldRate).toBe(w(0.118));
  });
});

describe("I1：作废的工时不计入任何统计", () => {
  const entries = [
    { costCents: entryCostCents(8, CRC_DAY), billable: true,  hours: 8, voided: false },
    { costCents: entryCostCents(8, CRA_DAY), billable: true,  hours: 8, voided: false },
    { costCents: entryCostCents(4, CRC_DAY), billable: false, hours: 4, voided: false },
    { costCents: entryCostCents(8, CRA_DAY), billable: true,  hours: 8, voided: true  }
  ];

  it("直接成本只累计未作废的条目", () => {
    const c = siteCost(entries, OVERHEAD);
    expect(c.directCents).toBe(CRC_DAY + CRA_DAY + roundCents(0.5 * CRC_DAY));
    expect(c.personDays).toBe(20 / HOURS_PER_DAY);          // 8+8+4 小时
  });

  it("不可计费占比算得出来 —— 它高，说明人力花在了卖不出去的事情上", () => {
    const c = siteCost(entries, OVERHEAD);
    expect(c.nonBillableCents).toBe(roundCents(0.5 * CRC_DAY));
    expect(c.nonBillableShare).toBeCloseTo(c.nonBillableCents / c.directCents, 10);
  });

  it("管理分摊按直接成本比例，不重复计入差旅之外的东西", () => {
    const c = siteCost(entries, OVERHEAD);
    expect(c.overheadCents).toBe(roundCents(c.directCents * OVERHEAD));
    expect(c.totalCents).toBe(c.directCents + c.overheadCents);
  });

  it("全部作废时是 0，而不可计费占比是 null —— 没有分母不等于占比为 0", () => {
    const c = siteCost(entries.map(e => ({ ...e, voided: true })), OVERHEAD);
    expect(c.directCents).toBe(0);
    expect(c.nonBillableShare).toBeNull();
  });
});

describe("毛利", () => {
  it("毛利率 = 毛利 ÷ 收入；每例成本 = 成本 ÷ 入组数", () => {
    const m = siteMargin(w(188.02), w(96.2), 26);
    expect(m.grossProfitCents).toBe(w(188.02) - w(96.2));
    expect(m.grossMargin).toBeCloseTo((w(188.02) - w(96.2)) / w(188.02), 10);
    expect(m.costPerEnrolledCents).toBe(roundCents(w(96.2) / 26));
  });

  it("还没有收入时毛利率是 null，不是 0% —— 两者在看板上含义完全不同", () => {
    const m = siteMargin(0, w(12.5), 0);
    expect(m.grossMargin).toBeNull();
    expect(m.costPerEnrolledCents).toBeNull();
    expect(m.grossProfitCents).toBe(-w(12.5));              // 亏的是实打实的
  });
});
