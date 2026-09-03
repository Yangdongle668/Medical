import { roundCents, ratio, type Cents } from "./kernel.js";

/* ════════════════════════════════════════════════════════════════════
   现金流预测 · 应收账龄。

   ── 系统此前只有后视镜 ────────────────────────────────────────────
   收入按已入组的例数确认，成本按已填的工时 —— 两者都只回答
   "已经发生了什么"。而现金是另一回事：
   **人力成本每月刚性支出，回款是里程碑制 + 账期。**
   一个毛利率 30% 的项目，完全可能在第四个月付不出工资。

   ── 这套预测最容易骗人的地方 ──────────────────────────────────────
   把"应该已经达成、但没进开票队列"的里程碑算成未来收入。
   那不是未来收入，是**记录缺口** —— 钱本来就该收到了，
   现在只是没人去开票。混进预测会凭空造出现金流，
   而且是在最不该乐观的那个月。

   所以 `forecastMilestones` 把它们单独标出来（`gap: true`），
   `cashFlow` **不把它们计入现金**。
   ════════════════════════════════════════════════════════════════════ */

/** 一个月按几天算。用 30.4 而不是 30：
 *  一个 6 个月的预测差 2.4 天，刚好够把一笔款推到下个月去。 */
export const DAYS_PER_MONTH = 30.4;

/* ── 应收账龄 ────────────────────────────────────────────────────── */

export interface Receivable {
  amountCents: Cents;
  /** 到期日距今天几天。**负数 = 已逾期。** */
  daysToDue: number;
}

export interface ArAging {
  totalCents: Cents;
  /** 已过到期日的。**这是真正要打电话的那部分。** */
  overdueCents: Cents;
  /** 逾期超过 60 天的 —— 这个数不为 0，就该走法务而不是催收了。 */
  longOverdueCents: Cents;
  count: number;
  overdueCount: number;
  /** 逾期部分的平均逾期天数。没有逾期时是 null，不是 0 ——
   *  「一笔都没逾期」和「平均逾期 0 天」是两回事。 */
  meanOverdueDays: number | null;
  /** 逾期金额占比。它比绝对额有用：500 万里逾期 50 万和
   *  80 万里逾期 50 万，是两种完全不同的处境。 */
  overdueShare: number | null;
}

/** 逾期超过这条线就不再是催收问题。 */
export const LONG_OVERDUE_DAYS = 60;

export function arAging(rows: readonly Receivable[]): ArAging {
  const overdue = rows.filter(r => r.daysToDue < 0);
  const totalCents = rows.reduce((n, r) => n + r.amountCents, 0);
  const overdueCents = overdue.reduce((n, r) => n + r.amountCents, 0);
  return {
    totalCents,
    overdueCents,
    longOverdueCents: overdue
      .filter(r => -r.daysToDue > LONG_OVERDUE_DAYS)
      .reduce((n, r) => n + r.amountCents, 0),
    count: rows.length,
    overdueCount: overdue.length,
    meanOverdueDays: overdue.length
      ? overdue.reduce((n, r) => n + -r.daysToDue, 0) / overdue.length : null,
    overdueShare: ratio(overdueCents, totalCents)
  };
}

/* ── 里程碑预测 ──────────────────────────────────────────────────── */

/** 一个中心的现状，够推出它还有哪几段没收。 */
export interface SiteForecastInput {
  contractCents: Cents;
  contracted: number;
  enrolled: number;
  /** 已经达成（落库）的段。 */
  reached: readonly string[];
  /** 每月入组速度。没有 FPI 时是 null —— **不能拿 0 代替**：
   *  0 意味着"永远达不成"，null 意味着"还不知道"，
   *  前者会把这个中心的剩余合同额从预测里整个抹掉。 */
  velocityPerMonth: number | null;
  /** 距计划 SIV 还有几个月。已过 SIV 时是 0，没排期时是 null。 */
  monthsToSiv: number | null;
  /** 合同已签？（状态机已过「合同签署」） */
  contractSigned: boolean;
}

export interface ForecastedMilestone {
  planCode: string;
  amountCents: Cents;
  /** 还要几个月达成。0 表示**现在就该达成了**。 */
  inMonths: number;
  /** **它其实已经达成，只是没进开票队列。**
   *  不是未来收入，是记录缺口 —— 所以不计入现金流。 */
  gap: boolean;
}

/** 计划表：段 → 占合同额的比例。与库里的 `milestone_plan` 同源，
 *  由调用方传进来（服务从表里读），不在这里写死。 */
export type MilestonePlan = readonly { code: string; ratio: number }[];

/** 超过这个月数的不进预测：再远就不是预测，是猜。 */
const HORIZON_MONTHS = 10;
/** 结题在入组做完之后还要几个月（数据清理、关中心）。 */
const CLOSEOUT_TAIL_MONTHS = 4;
/** 速度为 0 或极小时的兜底速度，避免除出一个天文数字的月数。 */
const MIN_VELOCITY = 0.3;

export function forecastMilestones(
  s: SiteForecastInput, plan: MilestonePlan
): ForecastedMilestone[] {
  const done = new Set(s.reached);
  const out: ForecastedMilestone[] = [];

  for (const p of plan) {
    if (done.has(p.code)) continue;
    const inMonths = monthsUntil(p.code, s);
    if (inMonths === null || inMonths > HORIZON_MONTHS) continue;
    out.push({
      planCode: p.code,
      amountCents: roundCents(s.contractCents * p.ratio),
      inMonths,
      /* inMonths === 0 表示这一段其实已经达成，却不在台账里。 */
      gap: inMonths === 0
    });
  }
  return out;
}

function monthsUntil(code: string, s: SiteForecastInput): number | null {
  switch (code) {
    case "contract":
      return s.contractSigned ? 0 : 2;
    case "siv":
      return s.monthsToSiv ?? 3;
    case "closeout":
      /* 结题：把剩下的例数做完，再加尾巴（数据清理、关中心）。

         速度未知时给 12 —— 它**通常会被下面的地平线筛掉**，那正是对的：
         一个还不知道入组速度的中心，什么时候结题是猜不是预测。
         给 12 而不是 null，是为了让"已经快做完、只是没记速度"的那种
         情况仍有机会落进区间；而不是从一开始就把整段合同额抹掉。 */
      return s.velocityPerMonth === null
        ? 12
        : (s.contracted - s.enrolled) / Math.max(s.velocityPerMonth, MIN_VELOCITY)
          + CLOSEOUT_TAIL_MONTHS;
    case "half":
    case "eighty": {
      const target = s.contracted * (code === "half" ? 0.5 : 0.8);
      if (s.enrolled >= target) return 0;
      /* 速度未知或为 0：**不给月数**（返回 null 而不是 Infinity）——
         "不知道什么时候" 和 "很久以后" 在现金流上是两回事，
         后者会在第 10 个月凭空长出一笔钱。 */
      if (!s.velocityPerMonth || s.velocityPerMonth <= 0) return null;
      return (target - s.enrolled) / s.velocityPerMonth;
    }
    default:
      return null;
  }
}

/* ── 现金流 ──────────────────────────────────────────────────────── */

/** 一笔预计进账。`kind` 决定它在压力情景里被推迟多久。 */
export interface CashIn {
  amountCents: Cents;
  /** 第几个月（1 起）。 */
  month: number;
  label: string;
  kind: "invoiced" | "overdue" | "pending" | "forecast";
}

export interface CashMonth {
  /** `YYYY-MM` */
  month: string;
  inCents: Cents;
  outCents: Cents;
  netCents: Cents;
  /** 累计净额。**最低点落在哪个月，就是要提前多久去谈的答案。** */
  cumCents: Cents;
  items: CashIn[];
}

export interface CashFlow {
  months: CashMonth[];
  /** 每月刚性支出。 */
  burnCents: Cents;
  /** 累计最低点与它所在的月份。 */
  troughCents: Cents;
  troughMonth: string | null;
  /** 压力情景：逾期的再拖 3 个月、预计达成的延后 1 个月。 */
  stress: { months: CashMonth[]; troughCents: Cents; troughMonth: string | null };
  /** 已达成但没进开票队列的金额 —— **不在上面任何一个数里。** */
  recordGapCents: Cents;
}

/** 压力情景里各类款项各推迟几个月。
 *  逾期的推 3 个月不是悲观：**它之所以逾期，恰恰是因为对方还没打算付。** */
const STRESS_SHIFT: Record<CashIn["kind"], number> = {
  overdue: 3, forecast: 1, invoiced: 0, pending: 0
};

export function cashFlow(
  ins: readonly CashIn[],
  burnCents: Cents,
  months: number,
  startMonth: string,
  recordGapCents: Cents = 0
): CashFlow {
  const keys = monthKeys(startMonth, months);
  const build = (rows: readonly CashIn[]): CashMonth[] => {
    const out: CashMonth[] = keys.map(month => ({
      month, inCents: 0, outCents: burnCents, netCents: 0, cumCents: 0, items: []
    }));
    for (const r of rows) {
      const b = out[r.month - 1];
      /* 落到区间外的**视为本期收不到** —— 直接丢掉，不折回最后一个月。
         折回去会让最后一个月凭空多出一大笔，而那正是压力情景要拆穿的假象。 */
      if (!b) continue;
      b.inCents += r.amountCents;
      b.items.push(r);
    }
    let cum = 0;
    for (const b of out) { b.netCents = b.inCents - b.outCents; cum += b.netCents; b.cumCents = cum; }
    return out;
  };

  const base = build(ins);
  const stressed = build(ins.map(r =>
    ({ ...r, month: r.month + STRESS_SHIFT[r.kind] })));

  return {
    months: base,
    burnCents,
    ...trough(base),
    stress: { months: stressed, ...trough(stressed) },
    recordGapCents
  };
}

/** 累计净额的最低点。**一个月都没有时给 0 而不是 Infinity** ——
 *  Infinity 序列化成 JSON 是 null，界面上会显示成"没有最低点"，
 *  而那和"最低点是 0"看起来一模一样。 */
function trough(ms: readonly CashMonth[]) {
  let troughCents = Infinity, troughMonth: string | null = null;
  for (const b of ms) if (b.cumCents < troughCents) {
    troughCents = b.cumCents; troughMonth = b.month;
  }
  return {
    troughCents: troughMonth === null ? 0 : troughCents,
    troughMonth
  };
}

/** 从 `YYYY-MM` 起，往后 n 个月的键。
 *  **用 UTC 构造** —— 本地时区在月初那一天会把 1 号推成上个月的最后一天。 */
export function monthKeys(startMonth: string, n: number): string[] {
  const [y, m] = startMonth.split("-").map(Number) as [number, number];
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 + i + 1, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });
}
