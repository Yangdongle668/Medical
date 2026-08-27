import { useEffect, useState } from "react";
import { call } from "../../api/client.js";

/* ════════════════════════════════════════════════════════════════════
   SAE 台账与 24 小时及时率（I6）。

   这一页存在的理由写在 `packages/calc/src/kernel.ts` 的开头：
   原型里「SAE 24h 及时率」是一个**写死的常量**，而同一个页面下方
   就摆着一条超窗的 SAE。演示时没人看得出来，真实系统里这就是看板骗人。

   所以这里画三样东西，缺一不可：
   ① 及时率本身，带口径版本号；
   ② **最坏的那一条晚了多久** —— 92% 促不成任何动作，"最坏一条晾了 8 天"能；
   ③ 还在计时的那几条 —— 人要知道现在该去做什么，而不是事后再看一个百分比。
   ════════════════════════════════════════════════════════════════════ */

interface Sae {
  id: string; code: string; title: string; detail: string;
  occurredAt: string | null; reportedAt: string | null; reportHours: number | null;
  state: string;
}
interface Timeliness {
  total: number; onTime: number; late: number; pending: number;
  rate: number | null; worstLateHours: number | null; calcVersion: string;
}
interface Ledger { items: Sae[]; timeliness: Timeliness }

const DEADLINE_HOURS = 24;

/** 小时读起来太长时换成天。`8.3 天` 比 `199.2 小时` 更能让人有反应。 */
function howLong(h: number): string {
  return h < 48 ? `${h.toFixed(1)} 小时` : `${(h / 24).toFixed(1)} 天`;
}

const when = (iso: string | null) => iso ? iso.replace("T", " ").slice(0, 16) : "—";

export function SaePanel({ studySiteId }: { studySiteId: string }) {
  const [led, setLed] = useState<Ledger | null>(null);
  useEffect(() => {
    call<Ledger>("listSaeEvents", { params: { id: studySiteId }, query: { limit: 50 } })
      .then(setLed).catch(() => setLed(null));
  }, [studySiteId]);

  if (!led) return null;
  const t = led.timeliness;

  return (
    <section className="card stack" data-testid="sae-panel">
      <div className="spread">
        <h3 style={{ margin: 0, fontSize: 14 }}>SAE 24 小时上报</h3>
        <span className="muted mono" style={{ fontSize: 11 }}>
          口径 {t.calcVersion}
        </span>
      </div>

      {t.total === 0 ? (
        /* 「还没有 SAE」和「及时率 100%」是两回事。
            后者是在用一个没有分母的数字给人安全感。 */
        <p className="muted" data-testid="sae-none" style={{ margin: 0 }}>
          这个中心还没有 SAE 记录 —— 及时率没有分母，所以这里不给数字。
        </p>
      ) : (
        <>
          <div className="row" style={{ gap: 16, flexWrap: "wrap" }}>
            <div>
              <div className="muted" style={{ fontSize: 11 }}>及时率</div>
              <b className="num" data-testid="sae-rate" style={{ fontSize: 20 }}>
                {t.rate === null ? "—" : `${Math.round(t.rate * 100)}%`}
              </b>
              <div className="muted" style={{ fontSize: 11 }}>
                {t.onTime} 按时 / {t.onTime + t.late} 已到点
              </div>
            </div>
            {t.worstLateHours !== null && (
              /* 一个百分比促不成任何动作，"最坏的那一条"能。 */
              <div>
                <div className="muted" style={{ fontSize: 11 }}>最坏的一条超时</div>
                <b className="num" data-testid="sae-worst" style={{ fontSize: 20 }}>
                  {howLong(t.worstLateHours - DEADLINE_HOURS)}
                </b>
                <div className="muted" style={{ fontSize: 11 }}>超过 24 小时时限</div>
              </div>
            )}
            {t.pending > 0 && (
              <div>
                <div className="muted" style={{ fontSize: 11 }}>还在计时</div>
                <b className="num" data-testid="sae-pending" style={{ fontSize: 20 }}>
                  {t.pending}
                </b>
                <div className="muted" style={{ fontSize: 11 }}>未满 24 小时，未上报</div>
              </div>
            )}
          </div>

          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            超过 24 小时仍未上报的<b>直接计入迟报</b> ——
            否则一条永远不上报的 SAE 就永远不进分母，越拖越好看。
          </p>

          <ul className="stack" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {led.items.map(e => {
              const late = e.reportHours === null
                ? Date.now() - new Date(e.occurredAt ?? 0).getTime() > DEADLINE_HOURS * 3.6e6
                : e.reportHours > DEADLINE_HOURS;
              return (
                <li key={e.id} className="card" data-testid="sae-row">
                  <div className="spread">
                    <span className="mono">{e.code}</span>
                    <span className={`chip ${late ? "crit" : e.reportedAt ? "good" : "warn"}`}
                      data-testid="sae-chip">
                      {e.reportedAt
                        ? (late ? "超时上报" : "按时上报")
                        : (late ? "尚未上报（已超时）" : "尚未上报（计时中）")}
                    </span>
                  </div>
                  <div style={{ margin: "6px 0 2px" }}>{e.title}</div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    发生 {when(e.occurredAt)} · 上报 {when(e.reportedAt)}
                    {e.reportHours !== null && (
                      /* 不四舍五入：把 24.4 小时显示成 24 小时是在替人开脱 */
                      <> · 经过 <b className="num">{e.reportHours.toFixed(1)}</b> 小时</>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
