/* ════════════════════════════════════════════════════════════════════
   内部稽查与 CAPA 有效性。

   ── QA 的价值不在于再发现一批问题 ─────────────────────────────────
   在于回答一个问题：**同类问题是否复发。**

   复发 = 当初只做了纠正，没做预防。
   「研究者集中补签并留痕」是纠正 —— 补完签名，下个月照样缺。
   预防是把签名完整性做进 CRC 每周自查清单并留痕，
   或者改用带强制签名字段的电子源数据。

   **只做纠正不做预防的 CAPA，等于把同一个核查风险往后推了一个季度。**

   ── 两种复发都算数，但要分得开 ────────────────────────────────────
     · 源事件已关闭 → 关闭后复发：CAPA 写错了方向；
     · 源事件还开着 → 整改期内复发：措施根本没起作用。
   后者更急 —— 它说明现在正在做的事没有用，而不是当初做错了。

   ── 「待观察」不能把两件事混在一起 ────────────────────────────────
   原型的判定只有三档，其中「待观察：尚有未关闭项」同时装着
   「正在整改」和「根本没人写措施」。后者不是待观察，是**没人管**。
   所以这里把「欠着措施」单独数出来。
   ════════════════════════════════════════════════════════════════════ */

/** 质量扣分的权重。
 *
 *  **复发与 SAE 超窗并列最高（4）**，理由不同但同样重：
 *  SAE 超窗是单点的、但直接触及受试者安全与法规时限；
 *  复发证明的是**体系失效**，不是单点失误 —— 同一个坑掉进去两次，
 *  说明发现问题的机制在，解决问题的机制不在。 */
export const QUALITY_WEIGHTS = {
  severeOpen: 3, minorOpen: 1, saeLate: 4, staleQuery: 2, capaRepeat: 4
} as const;

/** A：0 分｜B：≤3｜C：≤7｜D：>7 */
export const GRADE_BANDS = { b: 3, c: 7 } as const;

export type QualityGrade = "A" | "B" | "C" | "D";

export interface SiteQualityInput {
  /** 未关闭的重大 / 严重质量事件（不含质疑，它走自己的闭环） */
  severeOpen: number;
  minorOpen: number;
  /** SAE 超出上报时限的次数 */
  saeLate: number;
  /** 挂起超过 7 天仍待中心回复的质疑 */
  staleQueries: number;
  /** 这个中心的稽查发现里，属于「同类问题又出现了」的条数 */
  capaRepeats: number;
}

export function qualityPenalty(x: SiteQualityInput): number {
  const w = QUALITY_WEIGHTS;
  return x.severeOpen * w.severeOpen
    + x.minorOpen * w.minorOpen
    + x.saeLate * w.saeLate
    + x.staleQueries * w.staleQuery
    + x.capaRepeats * w.capaRepeat;
}

export function qualityGrade(penalty: number): QualityGrade {
  if (penalty === 0) return "A";
  if (penalty <= GRADE_BANDS.b) return "B";
  if (penalty <= GRADE_BANDS.c) return "C";
  return "D";
}

export interface SiteGrade {
  penalty: number;
  grade: QualityGrade;
  /** 扣在哪几项。**A 级也要说话** ——「无扣分项」和「还没算」
   *  在界面上长得一样，而前者是可以据以降低监查强度的结论。 */
  reasons: string[];
}

export function gradeSite(x: SiteQualityInput): SiteGrade {
  const penalty = qualityPenalty(x);
  const reasons: string[] = [];
  if (x.capaRepeats) reasons.push(`CAPA 后复发 ${x.capaRepeats} 项`);
  if (x.saeLate) reasons.push(`SAE 超窗 ${x.saeLate} 次`);
  if (x.severeOpen) reasons.push(`重大/严重未关闭 ${x.severeOpen} 项`);
  if (x.staleQueries) reasons.push(`质疑挂起超 7 天 ${x.staleQueries} 条`);
  if (x.minorOpen) reasons.push(`一般未关闭 ${x.minorOpen} 项`);
  if (!reasons.length) reasons.push("无扣分项");
  return { penalty, grade: qualityGrade(penalty), reasons };
}

/* ── CAPA 有效性 ─────────────────────────────────────────────────── */

export interface CapaEvent {
  /** 问题类型（比 kind 细）。按它分组 —— 按 kind 分的话，
   *  「源数据缺陷」和「知情同意版本错误」会落进同一格。 */
  category: string;
  closed: boolean;
  /** 已指派责任人但还没提交整改措施 */
  owesPlan: boolean;
}

export interface CapaRepeat {
  /** 源事件的类型 —— 复发算在**源问题**那一类上，不是稽查发现那一类。 */
  category: string;
  /** 源事件当时是否已关闭 */
  sourceClosed: boolean;
}

export type CapaVerdict = "ineffective" | "effective" | "watching" | "unowned";

export interface CapaCategory {
  category: string;
  total: number;
  closed: number;
  /** 欠着整改措施的条数 —— 「正在整改」和「没人写措施」不是一回事。 */
  owesPlan: number;
  repeatAfterClose: number;
  repeatWhileOpen: number;
  verdict: CapaVerdict;
}

export function capaEffectiveness(
  events: readonly CapaEvent[], repeats: readonly CapaRepeat[]
): CapaCategory[] {
  const byCat = new Map<string, CapaCategory>();
  const row = (category: string) => {
    let r = byCat.get(category);
    if (!r) {
      r = { category, total: 0, closed: 0, owesPlan: 0,
            repeatAfterClose: 0, repeatWhileOpen: 0, verdict: "watching" };
      byCat.set(category, r);
    }
    return r;
  };
  for (const e of events) {
    const r = row(e.category);
    r.total++;
    if (e.closed) r.closed++;
    if (e.owesPlan) r.owesPlan++;
  }
  /* 复发落在**源问题**那一类上，即使这一类此刻一条事件都没有 ——
     那种情况本身就值得看见：问题类型还在复发，而台账上已经清空了。 */
  for (const p of repeats) {
    const r = row(p.category);
    if (p.sourceClosed) r.repeatAfterClose++; else r.repeatWhileOpen++;
  }
  for (const r of byCat.values()) {
    const repeated = r.repeatAfterClose + r.repeatWhileOpen;
    r.verdict = repeated > 0 ? "ineffective"
      /* 欠着措施的排在「待观察」前面 —— 它不是在观察，是没人管。 */
      : r.owesPlan > 0 ? "unowned"
      : r.total > 0 && r.closed === r.total ? "effective"
      : "watching";
  }
  /* 无效的排最前，其次没人管的，再按累计条数 —— 类型名定序兜底，
     否则同一份数据两次渲染给出两个顺序。 */
  const rank: Record<CapaVerdict, number> = {
    ineffective: 0, unowned: 1, watching: 2, effective: 3
  };
  return [...byCat.values()].sort((a, b) =>
    rank[a.verdict] - rank[b.verdict]
    || (b.repeatAfterClose + b.repeatWhileOpen) - (a.repeatAfterClose + a.repeatWhileOpen)
    || b.total - a.total
    || a.category.localeCompare(b.category));
}
