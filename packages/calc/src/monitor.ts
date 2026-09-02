import { roundCents, type Cents } from "./kernel.js";

/* ════════════════════════════════════════════════════════════════════
   监查访视的口径。

   ── 「监查频率来自风险分级，不是一刀切」 ──────────────────────────
   原型把这句话写在了公式框里，但没有落到数据上 ——
   于是它是一句正确的废话：谁都同意，谁也不知道这个中心该多久去一次。

   这里把它算出来。输入是系统里**已经有的**质量信号
   （未关闭事件、SAE 超窗、质疑挂起、入组停滞），
   输出是三样东西：风险档、建议间隔、建议 SDV 抽样比例 ——
   外加**理由**。没有理由的建议值没人会照着做，
   也没人能在核查时解释"为什么这个中心只抽了 30%"。

   ── 报告滞后有一个和 SAE 及时率一样的后门 ────────────────────────
   「已提交的报告平均隔了几天」这个算法里，
   **一份永远不提交的报告永远不进分母。**
   压得越久越不影响这个数 —— 所以未提交的按"到今天为止"计。

   ── 差旅按次算，不按天 ────────────────────────────────────────────
   一次两天的监查不是两倍差旅 —— 机票是一次的。
   按天折算会让"多待一天多看一批源数据"显得更贵，
   而那恰恰是应该鼓励的做法。
   ════════════════════════════════════════════════════════════════════ */

/** 现场做完之后多少天内要提交监查报告。
 *  **它是约定，不是常识** —— 不同申办方写 5 / 10 / 15 个工作日的都有，
 *  但改这个常量等于改全系统的口径。 */
export const MVR_DUE_DAYS = 10;

/** 三档风险对应的监查间隔（自然日）与 SDV 抽样比例（%）。
 *  **这是默认值，不是法规数字。** ICH E6 只说监查的范围与性质应基于风险，
 *  没有给间隔；这里给的是一组可执行的默认档位，项目上可以覆盖。 */
export const MONITOR_PLAN = {
  high:   { intervalDays: 42, sdvSamplePct: 100 },
  normal: { intervalDays: 70, sdvSamplePct: 50 },
  low:    { intervalDays: 98, sdvSamplePct: 25 }
} as const;

/** 入组多少天没动算停滞 —— 停滞的中心要去问为什么，而不是等下一次例行监查。 */
export const ENROLL_STALL_DAYS = 45;

export interface SiteRisk {
  /** 未关闭的重大 / 严重质量事件数 */
  severeOpen: number;
  /** 未关闭的一般质量事件数 */
  minorOpen: number;
  /** SAE 超出上报时限的次数 */
  saeLate: number;
  /** 挂起超过 7 天仍待中心回复的质疑数 */
  staleQueries: number;
  /** 距上一次入组多少天。**null = 这个中心还没入过组** ——
   *  那不是"入组很稳定"，而是另一个问题（见下）。 */
  daysSinceEnroll: number | null;
}

export type RiskBand = "low" | "normal" | "high";

/** 风险扣分。权重与「中心质量评级」同源 ——
 *  两处各写一套，同一个中心会在两张页上得到两个结论。 */
export function riskScore(r: SiteRisk): number {
  return r.severeOpen * 3
    + r.minorOpen * 1
    + r.saeLate * 4
    + r.staleQueries * 2
    /* 入组停滞不是质量问题，但它是**要去现场**的理由：
       停滞的原因（病源、入排、PI 精力）在系统里看不出来，只能去问。 */
    + (r.daysSinceEnroll !== null && r.daysSinceEnroll > ENROLL_STALL_DAYS ? 3 : 0);
}

export function riskBand(score: number): RiskBand {
  if (score >= 6) return "high";
  if (score >= 1) return "normal";
  return "low";
}

export interface MonitorPlan {
  band: RiskBand;
  score: number;
  intervalDays: number;
  sdvSamplePct: number;
  /** 为什么是这一档。**没有理由的建议值没人照着做** ——
   *  也没人能在核查时解释"为什么这个中心只抽了 25%"。 */
  reasons: string[];
}

export function monitorPlan(r: SiteRisk): MonitorPlan {
  const score = riskScore(r);
  const band = riskBand(score);
  const reasons: string[] = [];
  if (r.severeOpen) reasons.push(`${r.severeOpen} 项重大/严重事件未关闭`);
  if (r.saeLate) reasons.push(`SAE 超窗 ${r.saeLate} 次`);
  if (r.staleQueries) reasons.push(`${r.staleQueries} 条质疑挂起超 7 天`);
  if (r.minorOpen) reasons.push(`${r.minorOpen} 项一般事件未关闭`);
  if (r.daysSinceEnroll !== null && r.daysSinceEnroll > ENROLL_STALL_DAYS)
    reasons.push(`入组停滞 ${r.daysSinceEnroll} 天 —— 原因在系统里看不出来，要去问`);
  /* 一条都没有时也要说话。"无扣分项"和"还没算"在界面上长得一样，
     而前者是可以据以降低抽样比例的结论。 */
  if (!reasons.length) reasons.push("无扣分项 —— 可按低风险抽样");
  return { band, score, ...MONITOR_PLAN[band], reasons };
}

/** 一次访视的报告滞后了多少天。
 *  **未提交的按「到今天为止」算** —— 只统计已提交的，
 *  一份永远不交的报告就永远不进分母，压得越久这个数越好看。
 *  还没做现场的返回 null（它还没有开始计时）。 */
export function mvrLagDays(
  v: { performedOn: string | null; reportSubmittedOn: string | null },
  today: string
): number | null {
  if (!v.performedOn) return null;
  const end = v.reportSubmittedOn ?? today;
  return Math.round((Date.parse(end) - Date.parse(v.performedOn)) / 86_400_000);
}

export interface MvrLoad {
  /** 已做现场的次数（分母） */
  performed: number;
  submitted: number;
  /** 做完了但还没交报告 */
  outstanding: number;
  /** 其中已经超过 MVR_DUE_DAYS 的 —— 这些是欠账，不是"在写" */
  overdue: number;
  /** 平均滞后天数。未提交的按到今天计。无现场时为 null。 */
  meanLagDays: number | null;
  /** 最久的那一份压了多少天 */
  worstLagDays: number | null;
}

export function mvrLoad(
  vs: readonly { performedOn: string | null; reportSubmittedOn: string | null }[],
  today: string
): MvrLoad {
  let performed = 0, submitted = 0, outstanding = 0, overdue = 0;
  let sum = 0, worst: number | null = null;
  for (const v of vs) {
    const lag = mvrLagDays(v, today);
    if (lag === null) continue;
    performed++;
    sum += lag;
    if (worst === null || lag > worst) worst = lag;
    if (v.reportSubmittedOn) submitted++;
    else {
      outstanding++;
      if (lag > MVR_DUE_DAYS) overdue++;
    }
  }
  return {
    performed, submitted, outstanding, overdue,
    meanLagDays: performed ? sum / performed : null,
    worstLagDays: worst
  };
}

export interface MonitorDue {
  /** 距上一次监查多少天。**null = 这个中心一次都没监查过** ——
   *  那比"逾期"更值得看一眼，所以不折算成一个很大的数字。 */
  daysSince: number | null;
  /** 按建议间隔，下一次该在什么时候之前 */
  dueOn: string | null;
  /** 超期多少天。没到期或从未监查过为 null。 */
  overdueDays: number | null;
}

const addDays = (d: string, n: number) =>
  new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);

/** 这个中心该不该去了。 */
export function monitorDue(
  lastVisitOn: string | null, intervalDays: number, today: string
): MonitorDue {
  if (!lastVisitOn) return { daysSince: null, dueOn: null, overdueDays: null };
  const daysSince = Math.round((Date.parse(today) - Date.parse(lastVisitOn)) / 86_400_000);
  const dueOn = addDays(lastVisitOn, intervalDays);
  const over = daysSince - intervalDays;
  return { daysSince, dueOn, overdueDays: over > 0 ? over : null };
}

/** 一批访视的差旅估算。**按次不按天** —— 一次两天的监查不是两倍机票。 */
export const travelEstimateCents = (visitCount: number, perVisitCents: Cents): Cents =>
  roundCents(visitCount * perVisitCents);
