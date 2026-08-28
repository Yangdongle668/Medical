import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listEnrollment, pct, type Funnel } from "./api.js";

/* ════════════════════════════════════════════════════════════════════
   入组进度。

   一句话：**落后的排在最前面。** 别的都是附注。

   ── 为什么不按中心代号排 ────────────────────────────────────────
   按代号排的表，读的人要自己从十五行里找出哪几行不对劲 ——
   而"哪几行不对劲"恰恰是这一页唯一要回答的问题。
   代号排序在需要"找某一个中心"时才有用，那是台账页的事。

   ── 为什么达成率不够 ────────────────────────────────────────────
   两个中心都是 50%：一个签了 20 例入了 10 例，另一个签了 4 例入了 2 例。
   前者缺 10 例，后者缺 2 例。**缺口是绝对数，达成率是比例** ——
   排序按缺口，显示两个都给。
   ════════════════════════════════════════════════════════════════════ */

export function EnrollmentPage() {
  const [rows, setRows] = useState<Funnel[] | null>(null);
  const [behindOnly, setBehindOnly] = useState(false);

  useEffect(() => { void listEnrollment(behindOnly).then(r => setRows(r.items)); }, [behindOnly]);

  if (!rows) return <p className="muted">加载中…</p>;

  /* 缺口大的在前；缺口一样时达成率低的在前。 */
  const sorted = [...rows].sort((a, b) =>
    (b.contracted - b.enrolled) - (a.contracted - a.enrolled)
    || (a.attainment ?? 0) - (b.attainment ?? 0));

  const contracted = rows.reduce((n, r) => n + r.contracted, 0);
  const enrolled = rows.reduce((n, r) => n + r.enrolled, 0);
  const behind = rows.filter(r => r.enrolled < r.contracted).length;
  const notStarted = rows.filter(r => r.prescreened === 0).length;

  return (
    <>
      <div className="page-head">
        <h2>入组进度</h2>
        <p data-testid="enr-summary">
          合同 {contracted} 例，已入组 {enrolled} 例（{pct(contracted ? enrolled / contracted : null)}）。
          {behind > 0 && <> <b>{behind} 个中心还差人</b>。</>}
        </p>
      </div>

      {notStarted > 0 && (
        <div className="problem" style={{ marginBottom: 14 }} role="status">
          有 {notStarted} 个中心**一例预筛都还没有**。
          这不是"入组慢"，是还没真正启动 —— 两者要用完全不同的办法处理，
          而只看入组数分不出来。
        </div>
      )}

      <label className="row" style={{ gap: 6, marginBottom: 12, alignItems: "center" }}>
        <input type="checkbox" style={{ width: "auto" }} checked={behindOnly}
          data-testid="behind-only" onChange={e => setBehindOnly(e.target.checked)} />
        <span>只看还差人的</span>
      </label>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>中心</th><th>医院</th>
              <th className="num">合同</th><th className="num">已入组</th>
              <th className="num">缺口</th><th>达成率</th>
              <th className="num">在筛</th><th className="num">脱落</th><th />
            </tr>
          </thead>
          <tbody>
            {sorted.map(r => {
              const gap = r.contracted - r.enrolled;
              return (
                <tr key={r.studySiteId} data-testid="enr-row">
                  <td className="mono">{r.siteCode}</td>
                  <td>{r.hospital}</td>
                  <td className="num">{r.contracted}</td>
                  <td className="num">{r.enrolled}</td>
                  <td className="num">{gap > 0 ? gap : "—"}</td>
                  <td>{chip(r)}</td>
                  <td className="num">{r.inScreening}</td>
                  <td className="num">{r.withdrawn}</td>
                  <td>
                    <Link to={`/sites/${r.studySiteId}`} className="btn"
                      style={{ textDecoration: "none", display: "inline-block" }}>
                      打开
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="derive" style={{ marginTop: 14 }}>
        缺口大的排在最前面，缺口相同时达成率低的在前。
        <b>不按中心代号排</b> —— 按代号排的表，读的人要自己从十五行里找出
        哪几行不对劲，而那正是这一页唯一要回答的问题。
        <br />
        「一例预筛都没有」和「预筛了很多但入不进去」是两个完全不同的问题：
        前者要去问中心为什么还没动，后者要去看筛败原因（见「筛选漏斗与筛败」）。
      </div>
    </>
  );
}

function chip(r: Funnel) {
  if (r.attainment === null) return <span className="chip flat">—</span>;
  const a = r.attainment;
  if (r.enrolled >= r.contracted) return <span className="chip good">{pct(a)} 已达成</span>;
  if (a < 0.4) return <span className="chip crit">{pct(a)}</span>;
  if (a < 0.7) return <span className="chip warn">{pct(a)}</span>;
  return <span className="chip flat">{pct(a)}</span>;
}
