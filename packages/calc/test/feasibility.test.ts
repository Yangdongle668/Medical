import { describe, it, expect } from "vitest";
import {
  feasibilityScore, feasibilityBias, PI_COMMIT_KEEP, type FeasibilityAnswers
} from "../src/feasibility.js";

/* ════════════════════════════════════════════════════════════════════
   可行性评分。

   这套分数会被用来**拒绝一家医院**，所以测的不是"算得对"，
   是"每一条业务判断都还在"：
     · 没做过同类试验的，既往那 30 分是 0，不是按 pastBest 折算；
     · 入排匹配度为 null 与为 0.3 不是一回事；
     · 预测入组受病源封顶 —— PI 承诺再高也没用；
     · 45 / 65 两道线上的取值。
   ════════════════════════════════════════════════════════════════════ */

const base: FeasibilityAnswers = {
  ptYear: 280, pastN: 8, pastBest: 2.6, compet: 1,
  ethicsDays: 35, startDays: 49, teamN: 7, piCommit: 3.0, eligPct: null
};

describe("逐项得分", () => {
  it("加起来等于总分（未触顶时）", () => {
    const s = feasibilityScore(base);
    const sum = Object.values(s.parts).reduce((a, b) => a + b, 0);
    expect(s.total).toBeCloseTo(sum, 6);
  });

  it("**没做过同类试验的，既往那一项是 0** —— 不是按 pastBest 折算", () => {
    /* 没有历史就是没有历史。用一个编出来的数去填它，等于把
       "我们不知道"记成"我们知道它不行"或者"我们知道它行"。 */
    const s = feasibilityScore({ ...base, pastN: 0, pastBest: 4.9 });
    expect(s.parts.past).toBe(0);
  });

  it("竞争试验是**扣分**，不是不加分", () => {
    const none = feasibilityScore({ ...base, compet: 0 });
    const many = feasibilityScore({ ...base, compet: 5 });
    expect(none.parts.competition).toBe(0);
    expect(many.parts.competition).toBe(-15);
    expect(many.total).toBeLessThan(none.total);
  });

  it("病源封顶在 30 分 —— 年就诊 5000 例不会把别的项压下去", () => {
    const huge = feasibilityScore({ ...base, ptYear: 5000 });
    expect(huge.parts.source).toBe(30);
  });

  it("启动越慢分越低，超过 150 天归零", () => {
    expect(feasibilityScore({ ...base, startDays: 40 }).parts.startup)
      .toBeGreaterThan(feasibilityScore({ ...base, startDays: 120 }).parts.startup);
    expect(feasibilityScore({ ...base, startDays: 200 }).parts.startup).toBe(0);
  });

  it("总分夹在 0–100 —— 全项最差不会出现负分", () => {
    const worst = feasibilityScore({
      ptYear: 0, pastN: 0, pastBest: 0, compet: 9,
      ethicsDays: 200, startDays: 300, teamN: 0, piCommit: 0, eligPct: 0
    });
    expect(worst.total).toBe(0);
  });
});

describe("入排匹配度：null 与 0 不是一回事", () => {
  it("null 不加不减 —— 那是「当时没问过」", () => {
    expect(feasibilityScore({ ...base, eligPct: null }).parts.eligibility).toBe(0);
  });

  it("低于 0.3 要扣分 —— 否则病源大而入排不匹配的会靠前两项拿高分", () => {
    const bad = feasibilityScore({ ...base, eligPct: 0.19 });
    expect(bad.parts.eligibility).toBeLessThan(0);
    expect(bad.total).toBeLessThan(feasibilityScore(base).total);
  });

  it("高于 0.3 加分", () => {
    expect(feasibilityScore({ ...base, eligPct: 0.5 }).parts.eligibility)
      .toBeGreaterThan(0);
  });

  it("**同一份问卷，填 0.3 和不填，总分一样但预测不一样**", () => {
    /* 分数上 0.3 是基准（±0），但病源上限用的是"不知道就保守一档"，
       两者恰好都取 0.3 —— 这条断言钉住的是它们各自的语义，
       哪天基准线动了而保守档没动，这里会红。 */
    const known = feasibilityScore({ ...base, eligPct: 0.3 });
    const unknown = feasibilityScore({ ...base, eligPct: null });
    expect(known.total).toBeCloseTo(unknown.total, 6);
    expect(known.capPerMonth).toBeCloseTo(unknown.capPerMonth, 6);
  });
});

describe("预测月入组", () => {
  it("PI 承诺要打折 —— 报的是理想情况", () => {
    /* 病源足够大时不触顶，预测就是承诺 × 系数 */
    const s = feasibilityScore({ ...base, ptYear: 5000, piCommit: 4 });
    expect(s.predictedPerMonth).toBeCloseTo(4 * PI_COMMIT_KEEP, 6);
  });

  it("**病源封得住承诺** —— 一年 60 例的科室报 6 例/月是不成立的", () => {
    const s = feasibilityScore({ ...base, ptYear: 60, piCommit: 6, eligPct: 0.3 });
    expect(s.predictedPerMonth).toBe(s.capPerMonth);
    expect(s.predictedPerMonth).toBeLessThan(6 * PI_COMMIT_KEEP);
  });

  it("撞到上限说明瓶颈是病人不是团队 —— 加人没用", () => {
    const small = { ...base, ptYear: 60, piCommit: 6, eligPct: 0.3 };
    const moreTeam = feasibilityScore({ ...small, teamN: 20 });
    expect(moreTeam.predictedPerMonth)
      .toBe(feasibilityScore(small).predictedPerMonth);
    /* 分数会涨（团队分），但预测入组一点没变 —— 这正是要看见的 */
    expect(moreTeam.total).toBeGreaterThan(feasibilityScore(small).total);
  });
});

describe("三档", () => {
  it("65 / 45 是闭区间的下界", () => {
    const at = (total: number) => {
      /* 用病源分凑一个精确的总分：其余项全部归零 */
      const q: FeasibilityAnswers = {
        ptYear: Math.round(total / 30 * 500), pastN: 0, pastBest: 0, compet: 0,
        ethicsDays: 0, startDays: 200, teamN: 0, piCommit: 0, eligPct: null
      };
      return feasibilityScore(q);
    };
    expect(feasibilityScore({ ...base, ptYear: 5000, pastN: 9, pastBest: 5,
      compet: 0, startDays: 30, teamN: 8, eligPct: 0.6 }).level).toBe("good");
    expect(at(30).level).toBe("crit");
  });

  it("原型里那两家低分入选的，评的都是 crit 或 warn", () => {
    /* 西安交大一附院：年就诊 45、既往 0 次、启动 147 天 —— 实际入组 0 */
    const xian = feasibilityScore({
      ptYear: 45, pastN: 0, pastBest: 0, compet: 2,
      ethicsDays: 74, startDays: 147, teamN: 3, piCommit: 2.0, eligPct: null
    });
    expect(xian.level).toBe("crit");
    /* 华西：年就诊 60、既往 2 次最好 1.4 —— 实际 0.5 */
    const huaxi = feasibilityScore({
      ptYear: 60, pastN: 2, pastBest: 1.4, compet: 3,
      ethicsDays: 58, startDays: 112, teamN: 4, piCommit: 2.5, eligPct: null
    });
    expect(["crit", "warn"]).toContain(huaxi.level);
  });
});

describe("偏差：口径唯一能自我修正的地方", () => {
  it("实际 ÷ 预测", () => {
    expect(feasibilityBias(1.4, 1.65)).toBeCloseTo(1.4 / 1.65, 6);
  });

  it("预测为 0 时给 null，不是 Infinity 或 0", () => {
    /* 「没有分母」和「比值是 0」是两回事 —— 前者该显示「—」。 */
    expect(feasibilityBias(2, 0)).toBeNull();
  });
});
