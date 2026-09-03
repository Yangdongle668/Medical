import { useEffect, useState } from "react";
import { ApiError, type ProblemDetails } from "../../api/client.js";
import { listPayments, pay, today, anonymous, type Payment } from "./api.js";
import { yuan } from "../cost/money.js";

/* ════════════════════════════════════════════════════════════════════
   受试者补偿。

   ── 为什么它是关闭闸门的七项之一 ──────────────────────────────────
   补偿未发放、或者发了但没有签收凭证，**中心关不掉**。
   理由不是流程洁癖：那笔钱在账上是"已发生"，而在受试者那边可能
   一分钱都没到。关闭中心那天再来对，人已经找不到了。

   所以这一页的重点不是"总共多少钱"，是**哪几笔还没落地**，
   以及每一笔欠了多久。默认只看未发放的。

   ── 登记发放必须同时给凭证编号 ────────────────────────────────────
   只记「发了」而没有凭证，关闭中心时对不上 —— 后端会拒，
   所以这里两个字段一起要，不做成两步。
   ════════════════════════════════════════════════════════════════════ */

export function PaymentsPage() {
  const [rows, setRows] = useState<Payment[] | null>(null);
  const [unpaid, setUnpaid] = useState(true);
  const [paying, setPaying] = useState<Payment | null>(null);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const reload = () => listPayments(unpaid).then(r => setRows(r.items));
  useEffect(() => { void reload(); }, [unpaid]);

  if (!rows) return <p className="muted">加载中…</p>;

  const masked = rows.length > 0 && rows.every(anonymous);
  const open = rows.filter(p => !p.paidOn);
  const owed = open.reduce((n, p) => n + p.amountCents, 0);
  const stale = open.filter(p => p.ageDays > 30);
  /* 发了但没凭证 —— 比"还没发"更危险：账上已经出去了，手上没有回执。 */
  const noReceipt = rows.filter(p => p.paidOn && !p.receiptRef);

  return (
    <>
      <div className="page-head">
        <h2>受试者补偿</h2>
        <p data-testid="pay-summary">
          {open.length} 笔待发放，合计 <b>{yuan(owed)}</b>。
          {stale.length > 0 && <> 其中 <b>{stale.length} 笔超过 30 天</b>。</>}
        </p>
      </div>

      {noReceipt.length > 0 && (
        <div className="problem" role="alert" data-testid="no-receipt" style={{ marginBottom: 14 }}>
          <strong>{noReceipt.length} 笔登记了发放，却没有签收凭证。</strong>
          <div className="muted">
            这比"还没发"更麻烦：账上钱已经出去了，手上没有回执 ——
            关闭中心那天对不上，而那时受试者已经找不到了。
          </div>
        </div>
      )}

      {masked && (
        <div className="problem" data-testid="pay-masked" style={{ marginBottom: 14 }}>
          你的角色看得到金额，看不到<b>是给谁的</b>（筛选号那一列不在响应里）。
        </div>
      )}

      <label className="row" style={{ gap: 6, marginBottom: 12, alignItems: "center" }}>
        <input type="checkbox" style={{ width: "auto" }} checked={unpaid}
          data-testid="unpaid-only" onChange={e => setUnpaid(e.target.checked)} />
        <span>只看未发放的</span>
      </label>

      {problem && (
        <div className="problem stack" data-testid="pay-problem" style={{ marginBottom: 12 }}>
          <strong>{problem.title}</strong>
          {problem.detail && <div>{problem.detail}</div>}
        </div>
      )}
      {said && <p className="muted" data-testid="pay-said">{said}</p>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {!masked && <th>受试者</th>}
              <th>中心</th><th>访视</th><th className="num">金额</th>
              <th>应发日</th><th>状态</th><th>凭证</th><th />
            </tr>
          </thead>
          <tbody>
            {[...rows]
              /* 欠得最久的在最上面。按中心或按金额排都读不出"哪几笔该急" */
              .sort((a, b) => Number(!!a.paidOn) - Number(!!b.paidOn) || b.ageDays - a.ageDays)
              .map(p => (
                <tr key={p.id} data-testid="pay-row">
                  {!masked && <td className="mono">{p.screeningNo ?? "—"}</td>}
                  <td className="mono">{p.siteCode}</td>
                  <td>{p.visitLabel ?? <span className="muted">—</span>}</td>
                  <td className="num">{yuan(p.amountCents)}</td>
                  <td className="mono muted">{p.dueOn}</td>
                  <td>
                    {p.paidOn
                      ? <span className="chip good">已发放 {p.paidOn}</span>
                      : <span className={`chip ${p.ageDays > 30 ? "crit" : p.ageDays > 14 ? "warn" : "flat"}`}>
                          待发放 {p.ageDays} 天
                        </span>}
                  </td>
                  <td className="mono muted">
                    {p.receiptRef ?? (p.paidOn
                      ? <span className="chip crit" data-testid="missing-receipt">缺凭证</span>
                      : "—")}
                  </td>
                  <td>
                    {!p.paidOn && (
                      <button className="btn" data-testid={`pay-${p.id}`}
                        onClick={() => { setPaying(p); setProblem(null); setSaid(null); }}>
                        登记发放
                      </button>
                    )}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {paying && (
        <PayForm p={paying} onCancel={() => setPaying(null)}
          onGo={async (d, ref) => {
            setProblem(null); setSaid(null);
            try {
              await pay(paying.id, d, ref);
              await reload();
              setSaid(`已登记发放 ${yuan(paying.amountCents)}，凭证 ${ref}`);
              setPaying(null);
            } catch (e) {
              if (e instanceof ApiError) setProblem(e.problem); else throw e;
            }
          }} />
      )}

      <div className="derive" style={{ marginTop: 14 }}>
        补偿未发放、或者发了但没有签收凭证，<b>中心关不掉</b> ——
        这是关闭闸门的七项之一。
        <br />
        所以登记发放时<b>两个字段一起要</b>，不做成两步：
        只记「发了」而没有凭证，关闭中心那天对不上，
        而那时受试者已经找不到了。
      </div>
    </>
  );
}

function PayForm({ p, onCancel, onGo }: {
  p: Payment; onCancel: () => void; onGo: (d: string, ref: string) => void;
}) {
  const [d, setD] = useState(today());
  const [ref, setRef] = useState("");
  return (
    <div className="card stack" data-testid="pay-form" style={{ marginTop: 12 }}>
      <div className="spread">
        <h3>登记发放 · {yuan(p.amountCents)}</h3>
        <button className="btn" onClick={onCancel}>取消</button>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        {p.siteCode} · {p.visitLabel ?? "无关联访视"} · 应发日 {p.dueOn}
      </p>
      <div className="grid-form">
        <label className="field"><span>实际发放日</span>
          <input type="date" value={d} data-testid="paid-on"
            onChange={e => setD(e.target.value)} /></label>
        <label className="field"><span>签收凭证编号</span>
          <input value={ref} data-testid="receipt-ref" className="mono"
            onChange={e => setRef(e.target.value)} placeholder="例：RC-2026-0142" /></label>
      </div>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn primary" data-testid="pay-go"
          disabled={!d || !ref.trim()} onClick={() => onGo(d, ref.trim())}>确认</button>
      </div>
    </div>
  );
}
