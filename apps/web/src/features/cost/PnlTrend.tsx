import { useEffect, useState } from "react";
import { call } from "../../api/client.js";
import { yuan } from "./money.js";

/* ════════════════════════════════════════════════════════════════════
   分月损益（欠账 D6）。

   累计口径回答不了「这个月比上个月差在哪」，而那正是经营层每个月
   要问的那一句。

   ── 为什么是柱子而不是折线 ────────────────────────────────────────
   毛利有正有负，而**负毛利是这一页最该被看见的东西**。
   折线画负值要么截断在 0（谎），要么整条线往下挪（一眼看不出正负）。
   柱子从零轴两边长出去，正负一眼分明。

   ── 为什么不画收入与成本两条线 ───────────────────────────────────
   两条线的交叉点没有业务含义，而人会去找它。这里画的是**毛利**一根柱，
   收入与成本放在每一列的数字里 —— 要对比的是月与月，不是收入与成本。
   ════════════════════════════════════════════════════════════════════ */

interface Period {
  month: string;
  enrolled: number; screenFailed: number; withdrawn: number;
  revenueCents?: number; costCents?: number;
  personDays?: number; grossProfitCents?: number;
}
interface Trend {
  studySiteId: string; siteCode: string; hospital: string;
  months: Period[]; calcVersion: string;
}

/** `2026-08` → `8月`；跨年时带上年份，否则 12 个柱子里认不出哪个是去年的。 */
function label(month: string, prev?: string): string {
  const [y, m] = month.split("-");
  const showYear = !prev || prev.slice(0, 4) !== y;
  return showYear ? `${y!.slice(2)}年${Number(m)}月` : `${Number(m)}月`;
}

export function PnlTrend({ studySiteId }: { studySiteId: string }) {
  const [t, setTrend] = useState<Trend | null>(null);
  useEffect(() => {
    void call<Trend>("getSitePnlTrend",
      { params: { id: studySiteId }, query: { months: 12 } })
      .then(setTrend).catch(() => setTrend(null));
  }, [studySiteId]);

  if (!t) return null;
  const hasMoney = t.months.some(m => m.grossProfitCents !== undefined);

  /* 量纲取**绝对值的最大值**：正负两侧共用一个比例尺，
     否则一个 -3 万的月份会画得比 +30 万的月份还长。 */
  const scale = Math.max(1, ...t.months.map(m => Math.abs(m.grossProfitCents ?? 0)));

  return (
    <section className="card stack" data-testid="pnl-trend">
      <div className="spread">
        <h3 style={{ margin: 0 }}>分月</h3>
        <span className="muted" style={{ fontSize: 11 }}>
          按<b>事件发生的那个月</b>归属，不是按录入时间
        </span>
      </div>

      {!hasMoney ? (
        /* 一线看得到例数，看不到钱 —— 与累计页同一套列权限 */
        <p className="muted" style={{ margin: 0 }} data-testid="trend-counts-only">
          钱那几栏不在你的可见范围里 —— 下面只有例数。
        </p>
      ) : null}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>月份</th>
              <th>入组</th>
              {hasMoney && <th>收入</th>}
              {hasMoney && <th>成本</th>}
              {hasMoney && <th>毛利</th>}
              {hasMoney && <th style={{ minWidth: 160 }}>　</th>}
            </tr>
          </thead>
          <tbody>
            {t.months.map((m, i) => {
              const gp = m.grossProfitCents ?? 0;
              /* 半宽居中的零轴：正的往右长，负的往左长。 */
              const w = Math.round(Math.abs(gp) / scale * 50);
              return (
                <tr key={m.month} data-testid="trend-row">
                  <td className="mono">{label(m.month, t.months[i - 1]?.month)}</td>
                  <td className="num">{m.enrolled || "—"}</td>
                  {hasMoney && (
                    <td className="num">{m.revenueCents ? yuan(m.revenueCents) : "—"}</td>
                  )}
                  {hasMoney && (
                    <td className="num">{m.costCents ? yuan(m.costCents) : "—"}</td>
                  )}
                  {hasMoney && (
                    <td className="num" data-testid="trend-gp"
                      style={{ color: gp < 0 ? "var(--crit)" : undefined }}>
                      {gp ? yuan(gp) : "—"}
                    </td>
                  )}
                  {hasMoney && (
                    <td>
                      {/* 零轴在中间。负毛利是这一页最该被看见的东西，
                          所以它从中线往左长，颜色也不一样。 */}
                      <div style={{ display: "flex", alignItems: "center", height: 14 }}>
                        <div style={{ width: "50%", display: "flex", justifyContent: "flex-end" }}>
                          {gp < 0 && (
                            <span data-testid="bar-negative" style={{
                              width: `${w * 2}%`, height: 10, borderRadius: 2,
                              background: "var(--crit)"
                            }} />
                          )}
                        </div>
                        <div style={{
                          width: 1, height: 14, background: "var(--line-2)", flex: "0 0 1px"
                        }} />
                        <div style={{ width: "50%" }}>
                          {gp > 0 && (
                            <span data-testid="bar-positive" style={{
                              display: "block", width: `${w * 2}%`, height: 10,
                              borderRadius: 2, background: "var(--good)"
                            }} />
                          )}
                        </div>
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        各月加起来<b>不一定</b>等于上面的累计：累计里的脱落扣减按<b>当前</b>访视完成度算，
        而它会随时间变化。两个数字回答的不是同一个问题。
      </p>
    </section>
  );
}
