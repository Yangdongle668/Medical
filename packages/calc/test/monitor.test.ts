import { describe, it, expect } from "vitest";
import {
  riskScore, riskBand, monitorPlan, mvrLagDays, mvrLoad, monitorDue,
  travelEstimateCents, MVR_DUE_DAYS, ENROLL_STALL_DAYS, MONITOR_PLAN
} from "../src/monitor.js";

/* ════════════════════════════════════════════════════════════════════
   监查访视的口径。

   这一组盯的是**这套数怎么骗人**：
     · 只统计已提交的报告 —— 永远不交的那份就永远不进分母；
     · 从未监查过的中心算成"刚监查过" —— 最该去的那个看不见；
     · 差旅按天折算 —— 多待一天多看一批源数据显得更贵。
   ════════════════════════════════════════════════════════════════════ */

const clean = {
  severeOpen: 0, minorOpen: 0, saeLate: 0, staleQueries: 0, daysSinceEnroll: 10
};

describe("风险分级定频率", () => {
  it("**干净的中心降抽样、拉长间隔**，并说得出「因为无扣分项」", () => {
    const p = monitorPlan(clean);
    expect(p.band).toBe("low");
    expect(p.sdvSamplePct).toBe(MONITOR_PLAN.low.sdvSamplePct);
    expect(p.intervalDays).toBe(MONITOR_PLAN.low.intervalDays);
    expect(p.reasons).toHaveLength(1);
    expect(p.reasons[0]).toContain("无扣分项");
  });

  it("**建议值一定带理由** —— 没有理由的建议值没人照着做", () => {
    const p = monitorPlan({ ...clean, saeLate: 1, staleQueries: 2 });
    expect(p.band).toBe("high");
    expect(p.sdvSamplePct).toBe(100);
    expect(p.reasons.join("｜")).toContain("SAE 超窗");
    expect(p.reasons.join("｜")).toContain("质疑挂起");
  });

  it("SAE 超窗的权重最高 —— 一次就够把中心推到高风险", () => {
    expect(riskBand(riskScore({ ...clean, saeLate: 2 }))).toBe("high");
    /* 同样的分数要靠 8 条一般事件才凑得出来 */
    expect(riskScore({ ...clean, saeLate: 2 })).toBe(riskScore({ ...clean, minorOpen: 8 }));
  });

  it("**入组停滞也是去现场的理由**，虽然它不是质量问题", () => {
    const stalled = monitorPlan({ ...clean, daysSinceEnroll: ENROLL_STALL_DAYS + 1 });
    expect(stalled.score).toBe(3);
    expect(stalled.band).toBe("normal");
    expect(stalled.reasons.join("")).toContain("要去问");
    /* 刚好在线上不算停滞 —— 边界写死 */
    expect(monitorPlan({ ...clean, daysSinceEnroll: ENROLL_STALL_DAYS }).score).toBe(0);
  });

  it("从没入过组不算停滞 —— 它是另一个问题", () => {
    expect(riskScore({ ...clean, daysSinceEnroll: null })).toBe(0);
  });
});

describe("监查报告滞后", () => {
  const T = "2026-09-02";

  it("**没提交的按「到今天」算** —— 否则不交就能把数做好看", () => {
    const vs = [
      { performedOn: "2026-08-30", reportSubmittedOn: "2026-09-01" },  // 2 天
      { performedOn: "2026-06-01", reportSubmittedOn: null }           // 93 天，还压着
    ];
    const l = mvrLoad(vs, T);
    expect(l.performed).toBe(2);
    expect(l.outstanding).toBe(1);
    expect(l.overdue).toBe(1);
    expect(l.worstLagDays).toBe(93);
    expect(l.meanLagDays).toBeCloseTo((2 + 93) / 2, 6);

    /* 只算已提交的话，同一份数据给出 2 天 —— 而那份压了三个月的
       正是这一页存在的理由。 */
    const fake = vs.filter(v => v.reportSubmittedOn);
    expect(mvrLagDays(fake[0]!, T)).toBe(2);
  });

  it("还没做现场的不进分母 —— 它还没有开始计时", () => {
    const l = mvrLoad([{ performedOn: null, reportSubmittedOn: null }], T);
    expect(l.performed).toBe(0);
    expect(l.meanLagDays).toBeNull();
    expect(l.worstLagDays).toBeNull();
  });

  it("刚好卡在时限上不算逾期", () => {
    const on = new Date(Date.parse(T) - MVR_DUE_DAYS * 86_400_000).toISOString().slice(0, 10);
    expect(mvrLoad([{ performedOn: on, reportSubmittedOn: null }], T).overdue).toBe(0);
    const older = new Date(Date.parse(T) - (MVR_DUE_DAYS + 1) * 86_400_000)
      .toISOString().slice(0, 10);
    expect(mvrLoad([{ performedOn: older, reportSubmittedOn: null }], T).overdue).toBe(1);
  });
});

describe("该不该去了", () => {
  const T = "2026-09-02";

  it("超过建议间隔就是逾期未监查", () => {
    const d = monitorDue("2026-06-01", 70, T);
    expect(d.daysSince).toBe(93);
    expect(d.dueOn).toBe("2026-08-10");
    expect(d.overdueDays).toBe(23);
  });

  it("没到期时 overdueDays 是 null，不是 0", () => {
    const d = monitorDue("2026-08-20", 70, T);
    expect(d.overdueDays).toBeNull();
  });

  it("**一次都没监查过的返回 null，不是一个很大的数**", () => {
    const d = monitorDue(null, 70, T);
    expect(d.daysSince).toBeNull();
    expect(d.overdueDays).toBeNull();
    /* 折算成"逾期 9999 天"会让它冲到榜首、盖住真正的逾期；
       折算成 0 又会让它彻底消失。两种都在骗人，所以给 null，
       由界面单说一句"一次都没去过"。 */
  });
});

describe("差旅估算", () => {
  it("**按次不按天** —— 一次两天的监查不是两倍机票", () => {
    expect(travelEstimateCents(3, 285_000)).toBe(855_000);
  });
});
