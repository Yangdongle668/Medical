import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { call } from "../../api/client.js";
import { SITE_STATE_LABEL } from "./states.js";

/* ════════════════════════════════════════════════════════════════════
   中心启动清单（各中心汇总）。

   ── 一句话：启动慢一个月，这个中心的整条收入曲线右移一个月 ────────
   所以这一页按**阻塞项**排，不按完成度：完成度 15/16 听起来很好，
   但如果差的那一项是阻塞项，这个中心一天都开不了工。
   而 8/16 且阻塞项已清零的中心，明天就能启动。

   ── 「没有清单」和「清单没做完」是两件事 ──────────────────────────
   已经在入组的中心通常一行清单都没有 —— 它们早就过了启动期。
   把它们和"卡住了"的中心画成同一个样子（0/0，进度条空着），
   会让这一页看起来到处都是问题。
   ════════════════════════════════════════════════════════════════════ */

interface Row {
  studySiteId: string; siteCode: string; hospital: string; state: string;
  sivPlannedOn: string | null; daysToSiv: number | null;
  total: number; done: number; blockingOpen: number; overdue: number;
}

export function StartupSummaryPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [blockedOnly, setBlockedOnly] = useState(false);

  useEffect(() => {
    void call<{ items: Row[] }>("listStartupChecklists",
      { query: { limit: 200, ...(blockedOnly ? { blockedOnly: true } : {}) } })
      .then(r => setRows(r.items));
  }, [blockedOnly]);

  if (!rows) return <p className="muted">加载中…</p>;

  /* 还在启动期的 —— 有清单行的那些。没有清单行的是早就过了启动期。 */
  const active = rows.filter(r => r.total > 0);
  const past = rows.filter(r => r.total === 0);
  const blocked = active.filter(r => r.blockingOpen > 0);
  const overdue = active.filter(r => r.overdue > 0);
  /* SIV 日已经过了、阻塞项还没清 —— 这一类最要命：计划已经作废了 */
  const late = blocked.filter(r => r.daysToSiv !== null && r.daysToSiv < 0);

  return (
    <>
      <div className="page-head">
        <h2>中心启动清单</h2>
        <p data-testid="startup-summary">
          {active.length} 个中心在启动期
          {past.length > 0 && <span className="muted">（另有 {past.length} 个已过启动期）</span>}。
          {blocked.length > 0 && <> <b>{blocked.length} 个还有阻塞项没清</b>。</>}
        </p>
      </div>

      {late.length > 0 && (
        <div className="problem" role="alert" data-testid="siv-late" style={{ marginBottom: 14 }}>
          <strong>{late.map(r => r.siteCode).join("、")} 已经过了计划 SIV 日，阻塞项还没清零。</strong>
          <div className="muted">
            计划已经作废了 —— 重排一个真的做得到的日子，比让它继续挂在过去有用。
            <b>启动慢一个月，这个中心的整条收入曲线右移一个月。</b>
          </div>
        </div>
      )}

      <div className="stats" style={{ marginBottom: 14 }}>
        <Stat label="启动期中心" v={active.length} note={`共 ${rows.length} 个在范围内`} />
        <Stat label="有阻塞项" v={blocked.length} note="阻塞项不清零，不得推进 SIV" bad={blocked.length > 0} />
        <Stat label="有逾期项" v={overdue.length} note="过了应完成日" bad={overdue.length > 0} />
        <Stat label="SIV 已过期" v={late.length} note={late.length ? "计划已作废" : "无"} bad={late.length > 0} />
      </div>

      <label className="row" style={{ gap: 6, marginBottom: 12, alignItems: "center" }}>
        <input type="checkbox" style={{ width: "auto" }} checked={blockedOnly}
          data-testid="blocked-only" onChange={e => setBlockedOnly(e.target.checked)} />
        <span>只看还有阻塞项的</span>
      </label>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>中心</th><th>医院</th><th>阶段</th>
              <th>进度</th><th className="num">阻塞项</th><th className="num">逾期</th>
              <th>计划 SIV</th><th />
            </tr>
          </thead>
          <tbody>
            {[...rows]
              /* 阻塞项多的最前；同数时 SIV 越近越前。
                 **没有清单的排最后** —— 它们不是卡住了，是早就过去了。 */
              .sort((a, b) =>
                Number(b.total > 0) - Number(a.total > 0)
                || b.blockingOpen - a.blockingOpen
                || (a.daysToSiv ?? 9999) - (b.daysToSiv ?? 9999))
              .map(r => (
                <tr key={r.studySiteId} data-testid="startup-row"
                  style={r.total === 0 ? { opacity: .55 } : undefined}>
                  <td className="mono">{r.siteCode}</td>
                  <td>{r.hospital}</td>
                  <td className="muted">{SITE_STATE_LABEL[r.state] ?? r.state}</td>
                  <td>
                    {r.total === 0
                      /* 不画成 0/0 —— 那看起来像"一项都没做"，
                         而实际是"这一段早就过去了"。 */
                      ? <span className="muted" data-testid="no-checklist">已过启动期</span>
                      : <span className={r.done === r.total ? "chip good" : "mono"}>
                          {r.done}/{r.total}
                        </span>}
                  </td>
                  <td className="num">
                    {r.total === 0 ? "—"
                      : r.blockingOpen > 0
                        ? <span className="chip crit">{r.blockingOpen}</span>
                        : <span className="chip good">已清零</span>}
                  </td>
                  <td className="num">
                    {r.total === 0 ? "—"
                      : r.overdue > 0 ? <span className="chip warn">{r.overdue}</span> : "—"}
                  </td>
                  <td>{sivChip(r)}</td>
                  <td>
                    <Link to={`/sites/${r.studySiteId}/startup`} className="btn"
                      style={{ textDecoration: "none", display: "inline-block" }}>逐项</Link>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <div className="derive" style={{ marginTop: 14 }}>
        <b>按阻塞项排，不按完成度。</b> 15/16 听起来很好，但如果差的那一项是
        阻塞项，这个中心一天都开不了工；而 8/16 且阻塞项已清零的中心，
        明天就能启动。完成度是过程，阻塞项是闸门。
        <br />
        「已过启动期」不画成 0/0：那看起来像一项都没做，
        而实际是这一段早就过去了 —— 两者混在一起，
        这一页会看起来到处都是问题，然后没人再看它。
      </div>
    </>
  );
}

function sivChip(r: Row) {
  if (!r.sivPlannedOn) return <span className="muted">未排</span>;
  if (r.total === 0) return <span className="mono muted">{r.sivPlannedOn}</span>;
  const d = r.daysToSiv;
  if (d === null) return <span className="mono muted">{r.sivPlannedOn}</span>;
  if (d < 0) return <span className="chip crit">已过 {-d} 天</span>;
  if (d <= 14) return <span className="chip warn">还有 {d} 天</span>;
  return <span className="mono muted">{r.sivPlannedOn}</span>;
}

function Stat({ label, v, note, bad }:
  { label: string; v: number; note: string; bad?: boolean }) {
  return (
    <div className="stat">
      <div className="stat-l">{label}</div>
      <div className="stat-v" style={bad ? { color: "var(--crit, #c0392b)" } : undefined}>{v}</div>
      <div className="stat-n">{note}</div>
    </div>
  );
}
