import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  listEnrollment, pct, label, SCREEN_FAIL_LABEL, WITHDRAW_LABEL, type Funnel
} from "./api.js";

/* ════════════════════════════════════════════════════════════════════
   筛选漏斗与筛败。

   **入组数只是漏斗最后一格。** 只盯着它，看不出
   「预筛量不足」与「筛败率过高」是两个完全不同的问题 ——
   前者要加招募渠道，后者要谈方案修订。花的钱、找的人、要多久，
   三样都不一样。

   所以这一页画的是四格漏斗，不是一列数字；
   而且把筛败原因摊开 —— 一个中心 60% 筛败，
   全是"影像学不符合"和全是"受试者撤回知情"，处理办法完全相反。
   ════════════════════════════════════════════════════════════════════ */

export function ScreenPage() {
  const [rows, setRows] = useState<Funnel[] | null>(null);
  const [pick, setPick] = useState<string>("");

  useEffect(() => { void listEnrollment().then(r => setRows(r.items)); }, []);
  if (!rows) return <p className="muted">加载中…</p>;

  const shown = pick ? rows.filter(r => r.studySiteId === pick) : rows;
  const sum = (f: (r: Funnel) => number) => shown.reduce((n, r) => n + f(r), 0);
  const pre = sum(r => r.prescreened), icf = sum(r => r.icfSigned),
        enr = sum(r => r.enrolled), sf = sum(r => r.screenFailed);

  /* 合计不能把各中心的比率平均 —— 那是「比率的平均」，不是「总体比率」。
     一个预筛 2 例全败的中心，会把二十个中心的均值拉得看不懂。 */
  const rate = (a: number, b: number) => b > 0 ? a / b : null;

  const roll = (key: "screenFailBreakdown" | "withdrawBreakdown") => {
    const by = new Map<string, number>();
    for (const r of shown) for (const x of r[key]) by.set(x.reason, (by.get(x.reason) ?? 0) + x.count);
    return [...by].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };
  const sfRoll = roll("screenFailBreakdown"), wdRoll = roll("withdrawBreakdown");

  return (
    <>
      <div className="page-head">
        <h2>筛选漏斗与筛败</h2>
        <p>
          入组数只是最后一格。<b>预筛量不足</b>和<b>筛败率过高</b>是两个完全不同的问题 ——
          前者要加招募渠道，后者要谈方案修订。
        </p>
      </div>

      <label className="field" style={{ maxWidth: 320, marginBottom: 14 }}>
        <span>范围</span>
        <select value={pick} data-testid="site-pick" onChange={e => setPick(e.target.value)}>
          <option value="">全部中心（{rows.length} 个）</option>
          {rows.map(r => (
            <option key={r.studySiteId} value={r.studySiteId}>{r.siteCode} · {r.hospital}</option>
          ))}
        </select>
      </label>

      <div className="stats" style={{ marginBottom: 14 }}>
        <Step label="预筛" n={pre} note="进到漏斗里的人" />
        <Step label="签署知情" n={icf} note={`知情转化 ${pct(rate(icf, pre))}`} />
        <Step label="筛败" n={sf} note={`筛败率 ${pct(rate(sf, icf))}`} bad={rate(sf, icf) !== null && rate(sf, icf)! > 0.5} />
        <Step label="入组" n={enr} note={`总转化 ${pct(rate(enr, pre))}`} />
      </div>

      <div className="row" style={{ gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        <Breakdown title="筛败原因" rows={sfRoll} total={sf} map={SCREEN_FAIL_LABEL}
          empty="还没有筛败记录" testid="sf-breakdown" />
        <Breakdown title="脱落原因" rows={wdRoll} total={sum(r => r.withdrawn)} map={WITHDRAW_LABEL}
          empty="还没有脱落记录" testid="wd-breakdown" />
      </div>

      {!pick && (
        <div className="table-wrap" style={{ marginTop: 14 }}>
          <table>
            <thead>
              <tr>
                <th>中心</th><th className="num">预筛</th><th className="num">知情</th>
                <th className="num">在筛</th><th className="num">筛败</th>
                <th>筛败率</th><th className="num">入组</th><th>总转化</th><th />
              </tr>
            </thead>
            <tbody>
              {[...rows]
                /* 筛败率高的在前；没有分母的（还没预筛）排最后 ——
                   它们不是"表现好"，是还没开始。 */
                .sort((a, b) => (b.screenFailRate ?? -1) - (a.screenFailRate ?? -1))
                .map(r => (
                  <tr key={r.studySiteId} data-testid="screen-row">
                    <td className="mono">{r.siteCode}</td>
                    <td className="num">{r.prescreened}</td>
                    <td className="num">{r.icfSigned}</td>
                    <td className="num">{r.inScreening}</td>
                    <td className="num">{r.screenFailed}</td>
                    <td>
                      {r.screenFailRate === null
                        ? <span className="muted">—</span>
                        : <span className={`chip ${r.screenFailRate > 0.6 ? "crit"
                            : r.screenFailRate > 0.4 ? "warn" : "flat"}`}>
                            {pct(r.screenFailRate)}
                          </span>}
                    </td>
                    <td className="num">{r.enrolled}</td>
                    <td className="muted">{pct(r.yieldRate)}</td>
                    <td>
                      <Link to={`/sites/${r.studySiteId}`} className="btn"
                        style={{ textDecoration: "none", display: "inline-block" }}>打开</Link>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="derive" style={{ marginTop: 14 }}>
        合计那几个比率是<b>总量之比</b>，不是各中心比率的平均 ——
        一个预筛 2 例全败的中心，会把二十个中心的均值拉得看不懂。
        <br />
        筛败率没有分母时显示「—」而不是 0%：一个还没预筛的中心，
        它的筛败率不是零，是<b>没有</b>。这两件事在排序上也不一样 ——
        没分母的排在最后，因为它们不是表现好，是还没开始。
      </div>
    </>
  );
}

function Step({ label, n, note, bad }:
  { label: string; n: number; note: string; bad?: boolean }) {
  return (
    <div className="stat">
      <div className="stat-l">{label}</div>
      <div className="stat-v" style={bad ? { color: "var(--crit, #c0392b)" } : undefined}>{n}</div>
      <div className="stat-n">{note}</div>
    </div>
  );
}

function Breakdown({ title, rows, total, map, empty, testid }: {
  title: string; rows: [string, number][]; total: number;
  map: Record<string, string>; empty: string; testid: string;
}) {
  return (
    <div className="card stack" data-testid={testid} style={{ flex: "1 1 300px" }}>
      <h3>{title}</h3>
      {rows.length === 0
        ? <p className="muted" style={{ margin: 0 }}>{empty}</p>
        : <dl className="kv">
            {rows.map(([reason, n]) => (
              <div key={reason} style={{ display: "contents" }}>
                <dt>{label(map, reason)}</dt>
                <dd className="num">{n}{total > 0 && <span className="muted">（{Math.round(n / total * 100)}%）</span>}</dd>
              </div>
            ))}
          </dl>}
    </div>
  );
}
