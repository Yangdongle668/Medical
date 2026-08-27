import { ratio } from "./kernel.js";

/* ════════════════════════════════════════════════════════════════════
   SAE 24 小时上报及时率（I6）。

   这一条是 kernel.ts 开头那段话点名的原罪：原型里它是一个**写死的常量**，
   而同一个页面下方就摆着一条超窗的 SAE。演示时没人看得出来，
   真实系统里这就是看板骗人 —— 而质量看板骗人，是要到核查时才付账的。

   ── 一个能把这个数做假的做法，以及为什么这里不那么算 ──────────────
   最省事的算法是「已上报的里面按时的占比」：

       rate = 按时上报数 / 已上报数

   它有一个致命的后门：**一条 SAE 只要永远不上报，就永远不进分母。**
   于是超时越久的那些越不影响这个数字，看板反而越好看。

   所以这里把「已经超过 24 小时、但还没上报」的那些**直接算成迟报**——
   它们是最严重的一类，不是还没轮到统计的一类。
   而「发生了不到 24 小时、还没上报」的那些是**未决**：既不算按时也不算迟，
   单独报数。人看得见"还有 3 条在计时"，才知道现在该去做什么。
   ════════════════════════════════════════════════════════════════════ */

/** 上报时限。它是口径的一部分：不同申办方可能约定 12 或 48 小时，
 *  但那属于「项目参数」，改这个常量等于改全系统的口径。 */
export const SAE_REPORT_DEADLINE_HOURS = 24;

const MS_PER_HOUR = 3_600_000;

export interface SaeRecord {
  /** 事件发生（或研究者知悉）的时刻 */
  occurredAt: Date | string;
  /** 向申办方/伦理上报的时刻；未上报为 null */
  reportedAt: Date | string | null;
}

const ms = (v: Date | string) => (v instanceof Date ? v : new Date(v)).getTime();

/** 从发生到上报经过了多少小时；未上报返回 null。
 *  **不四舍五入** —— 24.4 小时就是迟报，把它显示成"24 小时"是在替人开脱。 */
export const saeReportHours = (r: SaeRecord): number | null =>
  r.reportedAt === null ? null : (ms(r.reportedAt) - ms(r.occurredAt)) / MS_PER_HOUR;

export type SaeStatus = "on_time" | "late" | "pending";

/** 一条 SAE 现在算什么。`now` 显式传入 —— 口径函数不读时钟，
 *  否则同一份数据在两台机器上会算出两个及时率，而没人能说清哪个对。 */
export function saeStatus(r: SaeRecord, now: Date | string): SaeStatus {
  const h = saeReportHours(r);
  if (h !== null) return h <= SAE_REPORT_DEADLINE_HOURS ? "on_time" : "late";
  /* 没上报：已经超过时限的，现在就是迟报 —— 不上报不能换来"未决"。 */
  const elapsed = (ms(now) - ms(r.occurredAt)) / MS_PER_HOUR;
  return elapsed > SAE_REPORT_DEADLINE_HOURS ? "late" : "pending";
}

export interface SaeTimeliness {
  total: number;
  onTime: number;
  late: number;
  /** 发生不足 24 小时且尚未上报 —— 还在计时，不进及时率 */
  pending: number;
  /** 及时率 = onTime / (onTime + late)。两者皆无时为 null（不是 0）——
   *  「还没有 SAE」和「及时率 0%」是两回事。 */
  rate: number | null;
  /** 最长的一次超时（小时）。及时率是 92% 还是 100%，
   *  远不如"最坏的那一条晚了 9 天"更能让人动起来。 */
  worstLateHours: number | null;
}

export function saeTimeliness(rs: readonly SaeRecord[], now: Date | string): SaeTimeliness {
  let onTime = 0, late = 0, pending = 0, worst: number | null = null;
  for (const r of rs) {
    const st = saeStatus(r, now);
    if (st === "on_time") { onTime++; continue; }
    if (st === "pending") { pending++; continue; }
    late++;
    /* 未上报的迟报按"到现在为止"算超时 —— 它还在变大，这正是重点。 */
    const h = saeReportHours(r) ?? (ms(now) - ms(r.occurredAt)) / MS_PER_HOUR;
    if (worst === null || h > worst) worst = h;
  }
  return {
    total: rs.length, onTime, late, pending,
    rate: ratio(onTime, onTime + late),
    worstLateHours: worst
  };
}
