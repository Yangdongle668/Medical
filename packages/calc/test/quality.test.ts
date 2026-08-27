import { describe, it, expect } from "vitest";
import {
  SAE_REPORT_DEADLINE_HOURS, saeReportHours, saeStatus, saeTimeliness
} from "../src/quality.js";

/* kernel.ts 开头那段话点名的原罪：SAE 24h 及时率原本是个写死的常量，
   而同一个页面下方就摆着一条超窗的 SAE。这个文件是它的解药。 */

const at = (h: number) => new Date(Date.UTC(2026, 0, 10, h)).toISOString();
const NOW = at(100);

describe("SAE 上报耗时", () => {
  it("按小时算，且**不四舍五入** —— 24.4 小时就是迟报", () => {
    const r = { occurredAt: at(0), reportedAt: new Date(Date.UTC(2026, 0, 10, 24, 24)) };
    expect(saeReportHours(r)).toBeCloseTo(24.4, 5);
    /* 显示成"24 小时"是在替人开脱：那条 SAE 确实晚了。 */
    expect(saeStatus(r, NOW)).toBe("late");
  });

  it("正好 24 小时算按时 —— 时限是「内」，不是「以前」", () => {
    expect(saeStatus({ occurredAt: at(0), reportedAt: at(24) }, NOW)).toBe("on_time");
    expect(SAE_REPORT_DEADLINE_HOURS).toBe(24);
  });

  it("未上报返回 null，不是 0", () => {
    /* 0 会被下游当成"0 小时内上报"，那是最好的一档，实际是最坏的一档 */
    expect(saeReportHours({ occurredAt: at(0), reportedAt: null })).toBeNull();
  });
});

describe("及时率：不能靠「不上报」把数字做好看", () => {
  it("超过 24 小时还没上报的，现在就算迟报", () => {
    /* 这是整个口径的关键。若只算"已上报的里面按时的占比"，
       一条永远不上报的 SAE 就永远不进分母 —— 越拖越好看。 */
    expect(saeStatus({ occurredAt: at(0), reportedAt: null }, at(25))).toBe("late");
  });

  it("发生不足 24 小时且未上报的是未决：既不算按时，也不算迟", () => {
    expect(saeStatus({ occurredAt: at(0), reportedAt: null }, at(10))).toBe("pending");
  });

  it("未决不进分母，但单独报数 —— 人要看得见「还有几条在计时」", () => {
    const t = saeTimeliness([
      { occurredAt: at(0), reportedAt: at(2) },      // 按时
      { occurredAt: at(0), reportedAt: at(30) },     // 迟报 30h
      { occurredAt: at(96), reportedAt: null }       // 发生 4 小时前，未决
    ], NOW);
    expect(t).toMatchObject({ total: 3, onTime: 1, late: 1, pending: 1 });
    expect(t.rate).toBeCloseTo(0.5, 5);
  });

  it("没有 SAE 时及时率是 null，不是 0 或 100%", () => {
    /* 「还没有 SAE」和「及时率 0%」是两回事；显示成 100% 更糟 ——
       那是在用一个没有分母的数字给人安全感。 */
    expect(saeTimeliness([], NOW).rate).toBeNull();
    expect(saeTimeliness([{ occurredAt: at(99), reportedAt: null }], NOW).rate).toBeNull();
  });

  it("最坏的那一条超时多久 —— 未上报的按「到现在为止」算，它还在变大", () => {
    const t = saeTimeliness([
      { occurredAt: at(0), reportedAt: at(30) },     // 晚了 30h
      { occurredAt: at(0), reportedAt: null }        // 已经 100h 了，还没报
    ], NOW);
    expect(t.late).toBe(2);
    /* 及时率是 0% 这件事说明不了"最坏的一条已经晾了四天多" */
    expect(t.worstLateHours).toBeCloseTo(100, 5);
  });
});
