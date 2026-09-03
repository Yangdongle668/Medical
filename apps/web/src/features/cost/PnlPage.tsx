import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { call } from "../../api/client.js";
import { yuan, pct } from "./money.js";

/* ════════════════════════════════════════════════════════════════════
   成本与毛利（全部中心）。

   ── 这一页只回答一个问题：哪几个中心在亏钱 ────────────────────────
   所以按毛利升序排，亏得最多的在最上面。合计放在顶上，因为
   "公司整体赚不赚"和"哪几个在亏"是两个问题，混在一张表里读不出来。

   ── 合计是**加总**，不是平均 ──────────────────────────────────────
   毛利率的合计 = 总毛利 ÷ 总收入，不是各中心毛利率的平均。
   一个收入 5 万、毛利率 −200% 的新中心，会把二十个中心的均值毁掉，
   而它对公司整体的影响只有十万块。

   ── 列权限在这里同时生效，且由数据决定 ────────────────────────────
   `grossProfitCents` 不在响应里 = 没有 margin 权限。那时这一页
   **整块金额都不画**，而不是画成 0 或「—」：
   把"没权限"显示成 0，等于给了一个错的数字。
   ════════════════════════════════════════════════════════════════════ */

interface Row {
  studySiteId: string; siteCode: string; hospital: string; state: string;
  enrolled: number; screenFailed: number; withdrawn: number; contracted: number;
  revenue: { revenueCents?: number };
  cost: { totalCostCents?: number; unapprovedCostCents?: number; personDays?: number };
  grossProfitCents?: number; grossMargin?: number;
  calcVersion: string;
}

export function PnlPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [lossOnly, setLossOnly] = useState(false);

  useEffect(() => {
    void call<{ items: Row[] }>("listPnl",
      { query: { limit: 200, ...(lossOnly ? { lossOnly: true } : {}) } })
      .then(r => setRows(r.items));
  }, [lossOnly]);

  if (!rows) return <p className="muted">加载中…</p>;

  /* 「有没有这一列」由数据决定，不由角色判断 —— 前端不重算权限。 */
  const showMoney = rows.some(r => r.grossProfitCents !== undefined);
  const showCost = rows.some(r => r.cost.totalCostCents !== undefined);

  if (!showMoney && !showCost) return (
    <>
      <div className="page-head"><h2>成本与毛利</h2></div>
      <p className="problem" data-testid="pnl-masked">
        你的角色看得到这些中心，看不到它们的钱。
        这一页除了金额没有别的内容 —— 与其画一排「—」，不如直说。
      </p>
    </>
  );

  const sum = (f: (r: Row) => number | undefined) =>
    rows.reduce((n, r) => n + (f(r) ?? 0), 0);
  const revenue = sum(r => r.revenue.revenueCents);
  const cost = sum(r => r.cost.totalCostCents);
  const profit = sum(r => r.grossProfitCents);
  const unapproved = sum(r => r.cost.unapprovedCostCents);
  const losing = rows.filter(r => (r.grossProfitCents ?? 0) < 0);

  return (
    <>
      <div className="page-head">
        <h2>成本与毛利</h2>
        <p data-testid="pnl-summary">
          {rows.length} 个中心。
          {showMoney && <>合计毛利 <b>{yuan(profit)}</b>
            {revenue > 0 && <>（{pct(profit / revenue)}）</>}。</>}
          {losing.length > 0 && <> <b>{losing.length} 个在亏钱。</b></>}
        </p>
      </div>

      {showMoney && (
        <div className="stats" style={{ marginBottom: 14 }}>
          <Stat label="收入" v={yuan(revenue)} note="启动费 + 入组 − 脱落扣减 + 筛败补偿" />
          <Stat label="成本" v={yuan(cost)} note={`其中待审 ${yuan(unapproved)}`} />
          <Stat label="毛利" v={yuan(profit)} note={revenue > 0 ? pct(profit / revenue) : "还没有收入"}
            bad={profit < 0} />
          <Stat label="亏损中心" v={String(losing.length)} note={losing.length ? "见下表最上面几行" : "无"}
            bad={losing.length > 0} />
        </div>
      )}

      {unapproved > 0 && (
        <div className="problem" style={{ marginBottom: 14 }} role="status">
          成本里有 <b>{yuan(unapproved)}</b> 还没被第二个人看过（待审工时）。
          它<b>已经计入上面的成本</b> —— 未审不等于不发生，人已经把活干了。
          这个数一直不降说明审批积压了，不是成本失控。
        </div>
      )}

      <label className="row" style={{ gap: 6, marginBottom: 12, alignItems: "center" }}>
        <input type="checkbox" style={{ width: "auto" }} checked={lossOnly}
          data-testid="loss-only" onChange={e => setLossOnly(e.target.checked)} />
        <span>只看亏钱的</span>
      </label>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>中心</th><th>医院</th><th className="num">入组</th>
              {showMoney && <th className="num">收入</th>}
              {showCost && <th className="num">成本</th>}
              {showMoney && <><th className="num">毛利</th><th>毛利率</th></>}
              <th />
            </tr>
          </thead>
          <tbody>
            {[...rows]
              /* 毛利升序 —— 亏得最多的在最上面。这一页只回答这一个问题。 */
              .sort((a, b) => (a.grossProfitCents ?? 0) - (b.grossProfitCents ?? 0))
              .map(r => (
                <tr key={r.studySiteId} data-testid="pnl-row">
                  <td className="mono">{r.siteCode}</td>
                  <td>{r.hospital}</td>
                  <td className="num">{r.enrolled}<span className="muted">/{r.contracted}</span></td>
                  {showMoney && <td className="num">{yuan(r.revenue.revenueCents ?? 0)}</td>}
                  {showCost && <td className="num">{yuan(r.cost.totalCostCents ?? 0)}</td>}
                  {showMoney && <>
                    <td className="num">{yuan(r.grossProfitCents ?? 0)}</td>
                    <td>
                      {r.grossMargin === undefined
                        /* 收入为 0 时这个字段整个不出现 ——
                           「还没有收入」不等于「毛利率 0%」。 */
                        ? <span className="muted">还没有收入</span>
                        : <span className={`chip ${r.grossMargin < 0 ? "crit"
                            : r.grossMargin < 0.15 ? "warn" : "good"}`}>
                            {pct(r.grossMargin)}
                          </span>}
                    </td>
                  </>}
                  <td>
                    <Link to={`/sites/${r.studySiteId}/pnl`} className="btn"
                      style={{ textDecoration: "none", display: "inline-block" }}>逐项</Link>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <div className="derive" style={{ marginTop: 14 }}>
        <b>合计毛利率是总毛利 ÷ 总收入</b>，不是各中心毛利率的平均。
        一个收入 5 万、毛利率 −200% 的新中心会把二十个中心的均值毁掉，
        而它对公司整体的影响只有十万块。
        <br />
        「还没有收入」和「毛利率 0%」是两件事，所以前者不显示成 0% ——
        服务端在收入为 0 时**整个不下发** `grossMargin` 这个字段。
        <br />
        每一行点「逐项」看得到 I8′ 四项的拆解：启动费 / 入组 / 脱落扣减 / 筛败补偿。
        只做其中一项修正比两项都不做更危险，因为它看起来是对的。
        <span className="muted"> 口径版本 {rows[0]?.calcVersion}</span>
      </div>
    </>
  );
}

function Stat({ label, v, note, bad }:
  { label: string; v: string; note: string; bad?: boolean }) {
  return (
    <div className="stat">
      <div className="stat-l">{label}</div>
      <div className="stat-v" style={{ fontSize: 18, ...(bad ? { color: "var(--crit, #c0392b)" } : {}) }}>{v}</div>
      <div className="stat-n">{note}</div>
    </div>
  );
}
