import { useEffect, useState } from "react";
import { call, ApiError, type ProblemDetails } from "../../api/client.js";
import { loadMe, type Me } from "../login/me.js";
import { yuan, pct } from "../cost/money.js";

/* ════════════════════════════════════════════════════════════════════
   里程碑 · 结算。

   ── 这一页只有一个真正的问题：**钱到哪一步了** ────────────────────
   达成 → 开票 → 回款。三步里每一步之间都会卡，而卡的地方不一样，
   要做的事也完全不一样：

     · 达成了没开票 —— **记录缺口**。钱本来就该收到了，只是没人去开票。
       这一格是这张表最要盯的：它不需要跟客户谈，只需要有人去做。
     · 开了票没回款 —— 应收。逾期了就是要打电话。
     · 逾期 60 天以上 —— 那不再是催收问题。

   ── 排序按「逾期最久」，不按达成日 ────────────────────────────────
   一笔挂了 94 天的应收，比今天刚达成的那笔紧急得多。
   按达成日排的话，最该处理的那几笔会沉在最底下。

   ── 未来的里程碑不在这张表上 ──────────────────────────────────────
   它们是从入组速度推出来的**预测**，在现金流那一页。
   混进台账会让"已经挣到的"和"预计能挣到的"看起来一样，
   而这两个数在跟银行谈的时候差别极大。
   ════════════════════════════════════════════════════════════════════ */

interface Milestone {
  id: string; code: string;
  studySiteId: string; siteCode: string; hospital: string;
  study: { id: string; code: string; shortName: string };
  clientName: string;
  planCode: string; planLabel: string;
  milestoneCents?: number;
  reachedOn: string;
  state: "pending" | "invoiced" | "paid";
  invoicedOn: string | null; dueOn: string | null; paidOn: string | null;
  daysToDue: number | null; overdueDays: number | null;
  note: string | null;
}
interface Aging {
  totalCents?: number; overdueCents?: number; longOverdueCents?: number;
  count: number; overdueCount: number;
  meanOverdueDays: number | null; overdueShare: number | null;
  calcVersion: string;
}

const STATE: Record<Milestone["state"], { text: string; chip: string }> = {
  pending: { text: "待开票", chip: "crit" },
  invoiced: { text: "已开票", chip: "warn" },
  paid: { text: "已回款", chip: "flat" }
};
/** 逾期超过这条线就不再是催收问题 —— 与 calc 的 LONG_OVERDUE_DAYS 同一个数。 */
const LONG_OVERDUE = 60;

export function BillPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [rows, setRows] = useState<Milestone[] | null>(null);
  const [aging, setAging] = useState<Aging | null>(null);
  const [openOnly, setOpenOnly] = useState(false);
  const [acting, setActing] = useState<{ m: Milestone; kind: "invoice" | "pay" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const reload = () => Promise.all([
    call<{ items: Milestone[] }>("listMilestones", { query: { limit: 200 } })
      .then(r => setRows(r.items)),
    call<Aging>("getArAging").then(setAging)
  ]);

  useEffect(() => { void loadMe().then(setMe); void reload(); }, []);

  if (!me || !rows || !aging) return <p className="muted">加载中…</p>;

  const canWrite = me.permissions.actions.includes("bid");
  const seesMoney = aging.totalCents !== undefined;

  const act = async () => {
    if (!acting) return;
    setBusy(true); setProblem(null); setSaid(null);
    try {
      const r = await call<{ data: Milestone; sideEffects: { summary: string }[] }>(
        acting.kind === "invoice" ? "invoiceMilestone" : "payMilestone",
        { params: { id: acting.m.id }, body: {} });
      await reload();
      setActing(null);
      setSaid(r.sideEffects[0]?.summary ?? `${r.data.code} 已更新`);
    } catch (e) {
      if (e instanceof ApiError) setProblem(e.problem); else throw e;
    } finally { setBusy(false); }
  };

  const pending = rows.filter(m => m.state === "pending");
  const overdue = rows.filter(m => (m.overdueDays ?? 0) > 0);
  const longOverdue = overdue.filter(m => m.overdueDays! > LONG_OVERDUE);
  const shown = openOnly ? rows.filter(m => m.state !== "paid") : rows;
  const gapCents = pending.reduce((n, m) => n + (m.milestoneCents ?? 0), 0);

  return (
    <>
      <div className="page-head">
        <h2>里程碑 · 结算</h2>
        <p data-testid="bill-summary">
          {rows.length} 笔已达成。
          {pending.length > 0
            ? <> <b>{pending.length} 笔达成了还没开票</b>
                {seesMoney && <>（{yuan(gapCents)}）</>}。</>
            : " 都开票了。"}
          {overdue.length > 0 && <> 另有 <b>{overdue.length} 笔已逾期</b>。</>}
        </p>
      </div>

      <div className="derive" style={{ marginBottom: 14 }}>
        <b>「达成了没开票」不需要跟客户谈，只需要有人去做。</b>
        钱本来就该收到了 —— 它是记录缺口，不是应收，更不是未来收入。
        <br />
        未来的里程碑<b>不在这张表上</b>：它们是从入组速度推出来的预测，
        在「现金流预测」那一页。混进台账会让「已经挣到的」和「预计能挣到的」
        看起来一样，而这两个数在跟银行谈的时候差别极大。
      </div>

      <div className="stats" style={{ marginBottom: 16 }}>
        <Stat label="待开票" v={String(pending.length)}
          note={seesMoney ? yuan(gapCents) : "记录缺口，不是应收"}
          bad={pending.length > 0} />
        <Stat label="应收" v={seesMoney ? yuan(aging.totalCents!) : String(aging.count)}
          note={`${aging.count} 笔已开票未回款`} />
        <Stat label="其中逾期"
          v={seesMoney ? yuan(aging.overdueCents!) : String(aging.overdueCount)}
          note={aging.overdueShare === null
            ? "没有应收"
            : `占应收 ${pct(aging.overdueShare)}` +
              (aging.meanOverdueDays !== null
                ? ` · 平均 ${Math.round(aging.meanOverdueDays)} 天` : "")}
          bad={aging.overdueCount > 0} />
        <Stat label={`逾期 ${LONG_OVERDUE} 天以上`}
          v={seesMoney ? yuan(aging.longOverdueCents ?? 0) : String(longOverdue.length)}
          note={longOverdue.length ? "这不再是催收问题" : "无"}
          bad={longOverdue.length > 0} />
      </div>

      {aging.overdueShare !== null && (
        <div className="derive" style={{ marginBottom: 14 }} data-testid="bill-share">
          <b>逾期占比比绝对额有用。</b>
          500 万里逾期 50 万，和 80 万里逾期 50 万，是两种完全不同的处境 ——
          所以这一页两个数都给。
          <span className="muted mono" style={{ marginLeft: 8, fontSize: 12 }}>
            口径 {aging.calcVersion}
          </span>
        </div>
      )}

      {problem && (
        <div className="problem stack" data-testid="bill-problem" style={{ marginBottom: 12 }}>
          <strong>{problem.title}</strong>
          {problem.detail && <div>{problem.detail}</div>}
        </div>
      )}
      {said && <p className="muted" data-testid="bill-said">{said}</p>}

      <label className="field" style={{ maxWidth: 280, marginBottom: 12 }}>
        <span>
          <input type="checkbox" checked={openOnly} data-testid="bill-open-only"
            onChange={e => setOpenOnly(e.target.checked)} />
          {" "}只看还没收到钱的
        </span>
      </label>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>编号</th><th>中心 · 项目</th><th>客户</th><th>段</th>
              {seesMoney && <th className="num">金额</th>}
              <th>达成</th><th>开票 / 到期</th><th>状态</th><th />
            </tr>
          </thead>
          <tbody>
            {shown.map(m => {
              const st = STATE[m.state];
              return (
                <tr key={m.id} data-testid="bill-row">
                  <td className="mono">{m.code}</td>
                  <td>
                    <span className="mono">{m.siteCode}</span>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {m.hospital} · {m.study.shortName}
                    </div>
                  </td>
                  <td>{m.clientName}</td>
                  <td>{m.planLabel}</td>
                  {seesMoney && <td className="num">{yuan(m.milestoneCents ?? 0)}</td>}
                  <td className="mono muted">{m.reachedOn}</td>
                  <td>
                    {m.state === "pending"
                      ? <span className="muted" data-testid="bill-not-invoiced">还没开票</span>
                      : <>
                          <span className="mono muted">{m.invoicedOn}</span>
                          <div className="mono muted" style={{ fontSize: 12 }}>
                            至 {m.dueOn}
                          </div>
                        </>}
                  </td>
                  <td>
                    <span className={`chip ${st.chip}`}>{st.text}</span>
                    {m.overdueDays !== null && (
                      <div style={{ marginTop: 4 }}>
                        <span className={m.overdueDays > LONG_OVERDUE ? "chip crit" : "chip warn"}
                          data-testid="bill-overdue">
                          逾期 {m.overdueDays} 天
                        </span>
                      </div>
                    )}
                  </td>
                  <td>
                    {!canWrite
                      ? <span className="muted">—</span>
                      : m.state === "pending"
                        ? <button className="btn primary" data-testid={`bill-invoice-${m.id}`}
                            onClick={() => { setActing({ m, kind: "invoice" }); setProblem(null); }}>
                            开票
                          </button>
                        : m.state === "invoiced"
                          ? <button className="btn" data-testid={`bill-pay-${m.id}`}
                              onClick={() => { setActing({ m, kind: "pay" }); setProblem(null); }}>
                              登记回款
                            </button>
                          : <span className="muted mono">{m.paidOn}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {acting && (
        <div className="card stack" data-testid="bill-form" style={{ marginTop: 16 }}>
          <h3>
            {acting.kind === "invoice" ? "开票" : "登记回款"}
            {" "}<span className="mono">{acting.m.code}</span> · {acting.m.planLabel}
          </h3>
          <div className="derive" style={{ margin: 0 }}>
            {acting.kind === "invoice"
              ? <>到期日由<b>客户的账期</b>算出来并<b>落库固化</b> ——
                  客户之后改账期，这张票的到期日不会跟着变。</>
              : <><b>钱到账是一件不可撤销的事实。</b>
                  登记之后不能改回去；写错了要走冲销，不是改状态。</>}
          </div>
          <div className="row">
            <button className="btn primary" data-testid="bill-submit"
              disabled={busy} onClick={() => void act()}>
              {busy ? "…" : acting.kind === "invoice" ? "确认开票" : "确认回款"}
            </button>
            <button className="btn" onClick={() => setActing(null)}>取消</button>
          </div>
        </div>
      )}

      {!seesMoney && (
        <p className="muted" style={{ marginTop: 12 }} data-testid="bill-no-money">
          你的角色看不到金额（<span className="mono">price</span> 列权限），
          所以金额那一列<b>整列不画</b>。进度与逾期天数还在 —— 它们不是钱。
        </p>
      )}
    </>
  );
}

function Stat({ label, v, note, bad }:
  { label: string; v: string; note: string; bad?: boolean }) {
  return (
    <div className="stat">
      <div className="stat-l">{label}</div>
      <div className="stat-v" style={{ fontSize: 19, ...(bad ? { color: "var(--crit, #c0392b)" } : {}) }}>{v}</div>
      <div className="stat-n">{note}</div>
    </div>
  );
}
