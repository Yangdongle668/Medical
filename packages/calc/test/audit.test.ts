import { describe, it, expect } from "vitest";
import {
  qualityPenalty, qualityGrade, gradeSite, capaEffectiveness,
  QUALITY_WEIGHTS, type SiteQualityInput
} from "../src/audit.js";

/* ════════════════════════════════════════════════════════════════════
   内部稽查与 CAPA 有效性。

   这一组盯的是**这套判定怎么骗人**：
     · 「待观察」同时装着「正在整改」和「根本没人写措施」；
     · 只认「关闭后复发」—— 整改期内又出现的那条最急，却不算；
     · 复发算在稽查发现那一类上，而不是源问题那一类；
     · A 级不说话 —— 「无扣分项」和「还没算」在界面上长得一样。
   ════════════════════════════════════════════════════════════════════ */

const clean: SiteQualityInput = {
  severeOpen: 0, minorOpen: 0, saeLate: 0, staleQueries: 0, capaRepeats: 0
};

describe("中心质量评级", () => {
  it("四档按 0 / ≤3 / ≤7 / >7 划", () => {
    expect(qualityGrade(0)).toBe("A");
    expect(qualityGrade(3)).toBe("B");
    expect(qualityGrade(4)).toBe("C");
    expect(qualityGrade(7)).toBe("C");
    expect(qualityGrade(8)).toBe("D");
  });

  it("**复发与 SAE 超窗并列最高** —— 一次就够把中心推到 C", () => {
    expect(QUALITY_WEIGHTS.capaRepeat).toBe(4);
    expect(QUALITY_WEIGHTS.saeLate).toBe(4);
    expect(gradeSite({ ...clean, capaRepeats: 1 }).grade).toBe("C");
    /* 同样的分数要四条一般未关闭才凑得出来 —— 复发证明的是体系失效 */
    expect(qualityPenalty({ ...clean, minorOpen: 4 }))
      .toBe(qualityPenalty({ ...clean, capaRepeats: 1 }));
  });

  it("**A 级也要说话** —— 「无扣分项」是一个结论，不是空白", () => {
    const g = gradeSite(clean);
    expect(g.grade).toBe("A");
    expect(g.reasons).toEqual(["无扣分项"]);
  });

  it("扣分项按严重程度排 —— 复发排最前", () => {
    const g = gradeSite({ severeOpen: 1, minorOpen: 2, saeLate: 1,
      staleQueries: 1, capaRepeats: 1 });
    expect(g.reasons[0]).toContain("复发");
    expect(g.reasons[1]).toContain("SAE 超窗");
    expect(g.penalty).toBe(4 + 4 + 3 + 2 + 2);
    expect(g.grade).toBe("D");
  });
});

describe("CAPA 有效性", () => {
  const ev = (category: string, closed: boolean, owesPlan = false) =>
    ({ category, closed, owesPlan });

  it("**关闭后复发 → 无效**：当初只做了纠正，没做预防", () => {
    const [r] = capaEffectiveness(
      [ev("源数据缺陷", true), ev("源数据缺陷", true)],
      [{ category: "源数据缺陷", sourceClosed: true }]);
    expect(r!.verdict).toBe("ineffective");
    expect(r!.repeatAfterClose).toBe(1);
    expect(r!.repeatWhileOpen).toBe(0);
  });

  it("**整改期内复发也算 —— 而且更急**：措施根本没起作用", () => {
    const [r] = capaEffectiveness(
      [ev("源数据缺陷", false)],
      [{ category: "源数据缺陷", sourceClosed: false }]);
    expect(r!.verdict).toBe("ineffective");
    expect(r!.repeatWhileOpen).toBe(1);
    /* 只认"关闭后复发"的话，这一条会被判成「待观察」——
       而它说的是现在正在做的事没有用。 */
    expect(r!.repeatAfterClose).toBe(0);
  });

  it("全部关闭且没复发 → 有效", () => {
    const [r] = capaEffectiveness([ev("实验室资质过期", true)], []);
    expect(r!.verdict).toBe("effective");
  });

  it("**欠着措施不是「待观察」，是没人管**", () => {
    const rs = capaEffectiveness(
      [ev("知情同意", false, true), ev("知情同意", false)], []);
    expect(rs[0]!.verdict).toBe("unowned");
    expect(rs[0]!.owesPlan).toBe(1);

    /* 对照：同样没关闭，但措施都写了 —— 那才是待观察 */
    const [w] = capaEffectiveness([ev("方案偏离", false)], []);
    expect(w!.verdict).toBe("watching");
  });

  it("**复发算在源问题那一类上**，不是稽查发现那一类", () => {
    const rs = capaEffectiveness(
      [ev("源数据缺陷", true), ev("方案偏离", true)],
      [{ category: "源数据缺陷", sourceClosed: true }]);
    expect(rs.find(r => r.category === "源数据缺陷")!.verdict).toBe("ineffective");
    expect(rs.find(r => r.category === "方案偏离")!.verdict).toBe("effective");
  });

  it("台账清空了但还在复发的类型**照样出现**", () => {
    const rs = capaEffectiveness([], [{ category: "已消失的类型", sourceClosed: true }]);
    expect(rs).toHaveLength(1);
    expect(rs[0]!.total).toBe(0);
    expect(rs[0]!.verdict).toBe("ineffective");
  });

  it("排序：无效 → 没人管 → 待观察 → 有效，且是稳定的", () => {
    const rs = capaEffectiveness(
      [ev("甲", true), ev("乙", false), ev("丙", false, true), ev("丁", true)],
      [{ category: "丁", sourceClosed: true }]);
    expect(rs.map(r => r.category)).toEqual(["丁", "丙", "乙", "甲"]);

    /* 同一份数据换个输入顺序，结论必须一样 */
    const again = capaEffectiveness(
      [ev("丁", true), ev("丙", false, true), ev("乙", false), ev("甲", true)],
      [{ category: "丁", sourceClosed: true }]);
    expect(again.map(r => r.category)).toEqual(["丁", "丙", "乙", "甲"]);
  });

  it("没有任何事件时给空表，不是一行零", () => {
    expect(capaEffectiveness([], [])).toEqual([]);
  });
});
