import { useEffect, useState } from "react";
import { call, ApiError, type ProblemDetails } from "../../api/client.js";
import { loadMe, type Me } from "../login/me.js";
import { yuan } from "../cost/money.js";

/* ════════════════════════════════════════════════════════════════════
   监查访视。

   ── 四个日期，四个不同的问题 ──────────────────────────────────────
     排了没有        planned_on
     中心知不知道    confirmed_on
     人到底去了没有  performed_on
     报告交了没有    report_submitted_on

   把它们压成一个「状态」字段，「为什么这个中心三个月没人管」
   就答不出来 —— 而那是这一页唯一要回答的问题。

   原型的状态是 待确认 → 已排期 → 已提交，中间少了 **done**：
   **去过了但报告没交。** 那是监查上最常见的欠账 ——
   人去了、问题也看见了，报告压在手上两个月，
   中心那边该整改的事根本没开始。核查时看的是报告日期，不是出差日期。

   ── 「监查频率来自风险分级，不是一刀切」 ──────────────────────────
   原型把这句话写在公式框里，但没算。这一页把它算出来：
   输入是系统里已经有的质量信号，输出是建议间隔与抽样比例，
   **外加理由** —— 没有理由的建议值没人照着做，
   也没人能在核查时解释「为什么这个中心只抽了 25%」。
   ════════════════════════════════════════════════════════════════════ */

interface Item { seq: number; task: string; doneAt: string | null; doneByName: string | null }
interface Visit {
  id: string; code: string;
  studySiteId: string; siteCode: string; hospital: string; studyShortName: string;
  kind: "siv" | "imv" | "cov"; plannedOn: string;
  monitorAccountId: string; monitorName: string;
  days: number; state: "proposed" | "scheduled" | "done" | "reported";
  confirmedOn: string | null; performedOn: string | null; reportSubmittedOn: string | null;
  sdvSamplePct: number | null; note: string | null;
  items: Item[]; openItems: number;
  mvrLagDays: number | null; mvrOverdue: boolean; visitOverdueDays: number | null;
}
interface SitePlan {
  studySiteId: string; siteCode: string; hospital: string; siteState: string;
  band: "low" | "normal" | "high"; riskScore: number;
  intervalDays: number; sdvSamplePct: number; reasons: string[];
  lastVisitOn: string | null; daysSince: number | null;
  dueOn: string | null; overdueDays: number | null;
  neverVisited: boolean; openVisits: number;
}
interface Board {
  load: {
    performed: number; submitted: number; outstanding: number; overdue: number;
    meanLagDays: number | null; worstLagDays: number | null;
  };
  sites: SitePlan[];
  upcomingVisits: number; upcomingDays: number;
  travelEstimateCents?: number;
  calcVersion: string;
}

const KIND: Record<Visit["kind"], string> = { siv: "启动 SIV", imv: "例行 IMV", cov: "关闭 COV" };
const STATE: Record<Visit["state"], { text: string; chip: string }> = {
  proposed: { text: "待确认", chip: "warn" },
  scheduled: { text: "已排期", chip: "flat" },
  done: { text: "已到现场", chip: "warn" },
  reported: { text: "报告已提交", chip: "flat" }
};
const BAND: Record<SitePlan["band"], { text: string; chip: string }> = {
  high: { text: "高风险", chip: "crit" },
  normal: { text: "常规", chip: "warn" },
  low: { text: "稳定", chip: "flat" }
};
/** 与 calc 的 MVR_DUE_DAYS 同一个数。 */
const MVR_DUE = 10;

export function MonPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [rows, setRows] = useState<Visit[] | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const reload = () => Promise.all([
    call<{ items: Visit[] }>("listMonitorVisits", { query: { limit: 200 } })
      .then(r => { setRows(r.items); setSel(s => s ?? r.items.find(v => v.state !== "reported")?.id ?? r.items[0]?.id ?? null); }),
    call<Board>("getMonitorBoard", {}).then(setBoard)
  ]);

  useEffect(() => { void loadMe().then(setMe); void reload(); }, []);

  if (!me || !rows || !board) return <p className="muted">加载中…</p>;

  const canWrite = me.permissions.actions.includes("monitor");
  const seesCost = board.travelEstimateCents !== undefined;
  const cur = rows.find(v => v.id === sel) ?? null;
  const overdueSites = board.sites.filter(s => (s.overdueDays ?? 0) > 0);
  const never = board.sites.filter(s => s.neverVisited);

  const act = async (
    op: "confirmMonitorVisit" | "performMonitorVisit" | "submitMonitorReport", v: Visit
  ) => {
    setBusy(true); setProblem(null); setSaid(null);
    try {
      const r = await call<{ sideEffects: { summary: string }[] }>(op,
        { params: { id: v.id }, body: {} });
      await reload();
      setSaid(r.sideEffects[0]?.summary ?? `${v.code} 已更新`);
    } catch (e) {
      if (e instanceof ApiError) setProblem(e.problem); else throw e;
    } finally { setBusy(false); }
  };

  const toggle = async (v: Visit, seq: number, done: boolean) => {
    setBusy(true); setProblem(null);
    try {
      await call("setMonitorItemDone", { params: { id: v.id, seq }, body: { done } });
      await reload();
    } catch (e) {
      if (e instanceof ApiError) setProblem(e.problem); else throw e;
    } finally { setBusy(false); }
  };

  return (
    <>
      <div className="page-head">
        <h2>监查访视</h2>
        <p data-testid="mon-summary">
          未来四周 <b>{board.upcomingVisits} 次</b>（{board.upcomingDays} 人天）
          {seesCost && <>，预估差旅 <b>{yuan(board.travelEstimateCents!)}</b></>}。
          {board.load.outstanding > 0 && <> <b>{board.load.outstanding} 份监查报告没交</b>
            {board.load.overdue > 0 && <>（其中 {board.load.overdue} 份已超 {MVR_DUE} 天）</>}。</>}
        </p>
      </div>

      <div className="derive" style={{ marginBottom: 14 }}>
        <b>「去过了」和「报告交了」是两件事。</b>
        人去了、问题也看见了，报告压在手上两个月 ——
        中心那边该整改的事根本没开始，而<b>核查时看的是报告日期，不是出差日期</b>。
        所以这一页把「已到现场」单独列成一格，而不是从「已排期」直接跳到「已提交」。
      </div>

      <div className="stats" style={{ marginBottom: 16 }}>
        <Stat label="未来四周" v={String(board.upcomingVisits)}
          note={`${board.upcomingDays} 人天`} />
        <Stat label="逾期未监查" v={String(overdueSites.length)}
          note={overdueSites.length
            ? `最久的 ${overdueSites[0]!.overdueDays} 天` : "都在建议间隔内"}
          bad={overdueSites.length > 0} />
        <Stat label="报告没交" v={String(board.load.outstanding)}
          note={board.load.overdue ? `${board.load.overdue} 份已超时` : "都在时限内"}
          bad={board.load.overdue > 0} />
        <Stat label="平均报告滞后"
          v={board.load.meanLagDays === null
            ? "—" : `${board.load.meanLagDays.toFixed(1)} 天`}
          note={`目标 ≤ ${MVR_DUE} 天`}
          bad={(board.load.meanLagDays ?? 0) > MVR_DUE} />
      </div>

      {board.load.performed > 0 && (
        <div className="derive" style={{ marginBottom: 14 }} data-testid="mon-lag-note">
          <b>平均报告滞后把没交的也算进去了。</b>
          只统计已提交的那些，一份永远不交的报告就永远不进分母 ——
          压得越久这个数越好看
          {board.load.worstLagDays !== null &&
            <>，而最久的那一份已经压了 <b>{board.load.worstLagDays} 天</b></>}。
          <span className="muted mono" style={{ marginLeft: 8, fontSize: 12 }}>
            口径 {board.calcVersion}
          </span>
        </div>
      )}

      {problem && (
        <div className="problem stack" data-testid="mon-problem" style={{ marginBottom: 12 }}>
          <strong>{problem.title}</strong>
          {problem.detail && <div>{problem.detail}</div>}
        </div>
      )}
      {said && <p className="muted" data-testid="mon-said">{said}</p>}

      <div className="row" style={{ gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
        {/* ── 排期 ─────────────────────────────────────────────── */}
        <div className="card stack" style={{ flex: "1 1 340px", minWidth: 320 }}>
          <div className="spread">
            <h3>访视排期</h3>
            <span className="muted" style={{ fontSize: 13 }}>SIV 启动 · IMV 例行 · COV 关闭</span>
          </div>
          {rows.length === 0
            ? <p className="muted" style={{ margin: 0 }} data-testid="mon-empty">
                范围内没有排期。
              </p>
            : rows.map(v => {
              const st = STATE[v.state];
              const done = v.items.length - v.openItems;
              return (
                <button key={v.id} data-testid="mon-row"
                  className={v.id === sel ? "btn primary" : "btn"}
                  style={{ display: "block", width: "100%", textAlign: "left", padding: 10 }}
                  onClick={() => setSel(v.id)}>
                  <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                    <span className="mono" style={{ fontSize: 12 }}>{v.plannedOn}</span>
                    <span className="chip flat">{KIND[v.kind]}</span>
                    <span className={`chip ${st.chip}`}>{st.text}</span>
                    {v.visitOverdueDays !== null && (
                      <span className="chip crit" data-testid="mon-visit-overdue">
                        计划日已过 {v.visitOverdueDays} 天
                      </span>
                    )}
                    {v.mvrOverdue && (
                      <span className="chip crit" data-testid="mon-mvr-overdue">
                        报告压了 {v.mvrLagDays} 天
                      </span>
                    )}
                  </span>
                  <div style={{ fontSize: 13, marginTop: 4 }}>{v.hospital}</div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {v.monitorName} · {v.days} 天 · 跟进项 {done}/{v.items.length}
                  </div>
                </button>
              );
            })}
        </div>

        {/* ── 跟进项 ───────────────────────────────────────────── */}
        <div className="card stack" style={{ flex: "1 1 380px", minWidth: 340 }}>
          {!cur
            ? <p className="muted" style={{ margin: 0 }}>选择左边一次访视看它的跟进项。</p>
            : <>
                <div className="spread">
                  <h3>监查报告跟进项</h3>
                  <span className="chip flat">{cur.code}</span>
                </div>
                <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                  {cur.hospital} · {cur.studyShortName} · {cur.monitorName}
                  {cur.sdvSamplePct !== null
                    ? <> · <b>SDV 抽样 {cur.sdvSamplePct}%</b></>
                    : <> · <span data-testid="mon-no-sample">抽样比例这次没单独定</span></>}
                </p>

                <div className="row" style={{ gap: 16, flexWrap: "wrap", fontSize: 13 }}>
                  <span>计划 <span className="mono">{cur.plannedOn}</span></span>
                  <span>确认 <span className="mono">{cur.confirmedOn ?? "—"}</span></span>
                  <span>到现场 <span className="mono">{cur.performedOn ?? "—"}</span></span>
                  <span>报告 <span className="mono">{cur.reportSubmittedOn ?? "—"}</span></span>
                </div>

                <ul className="unmet" style={{ margin: 0 }}>
                  {cur.items.map(i => (
                    <li key={i.seq} data-testid="mon-item">
                      <label style={{ cursor: canWrite ? "pointer" : "default" }}>
                        <input type="checkbox" checked={i.doneAt !== null}
                          data-testid={`mon-item-${i.seq}`}
                          disabled={!canWrite || busy || cur.state === "reported"}
                          onChange={e => void toggle(cur, i.seq, e.target.checked)} />
                        {" "}
                        <span style={i.doneAt ? { textDecoration: "line-through", opacity: .6 } : undefined}>
                          {i.task}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>

                {cur.state === "reported"
                  ? <p className="muted" style={{ margin: 0, fontSize: 13 }}
                      data-testid="mon-frozen">
                      报告已提交（{cur.reportSubmittedOn}），<b>跟进项已冻结</b> ——
                      交上去的报告和台账对不上，比台账上少一项严重得多。
                      要改就出一份补充报告。
                    </p>
                  : canWrite && (
                    <div className="row" style={{ flexWrap: "wrap" }}>
                      {cur.state === "proposed" && (
                        <button className="btn primary" data-testid="mon-confirm"
                          disabled={busy} onClick={() => void act("confirmMonitorVisit", cur)}>
                          与中心确认
                        </button>
                      )}
                      {cur.state === "scheduled" && (
                        <button className="btn primary" data-testid="mon-perform"
                          disabled={busy} onClick={() => void act("performMonitorVisit", cur)}>
                          登记已到现场
                        </button>
                      )}
                      {cur.state === "done" && (
                        <button className="btn primary" data-testid="mon-report"
                          disabled={busy} onClick={() => void act("submitMonitorReport", cur)}>
                          提交监查报告
                        </button>
                      )}
                      <span className="muted" style={{ fontSize: 12 }}>
                        {cur.state === "done"
                          ? <><b>跟进项全部关闭之前提不了</b> —— 现在还差 {cur.openItems} 项。</>
                          : cur.state === "proposed"
                            ? "确认之后中心那边才知道我们要去。"
                            : "登记到现场之后开始计报告时限。"}
                      </span>
                    </div>
                  )}
                {!canWrite && (
                  <p className="muted" style={{ margin: 0, fontSize: 13 }}
                    data-testid="mon-readonly">
                    你的角色对监查<b>只读</b>：排期、到现场、交报告都要
                    {" "}<span className="mono">monitor</span> 动作权限。
                  </p>
                )}
              </>}
        </div>
      </div>

      {/* ── 风险分级 ─────────────────────────────────────────────── */}
      <div className="card stack" style={{ marginTop: 16 }}>
        <div className="spread">
          <h3>该多久去一次</h3>
          <span className="muted" style={{ fontSize: 13 }}>
            监查频率来自风险分级，不是一刀切
          </span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>中心</th><th>风险</th><th className="num">建议间隔</th>
                <th className="num">建议抽样</th><th>上次监查</th><th>理由</th>
              </tr>
            </thead>
            <tbody>
              {board.sites.map(s => (
                <tr key={s.studySiteId} data-testid="mon-site-row"
                  style={(s.overdueDays ?? 0) > 0
                    ? { background: "rgba(192,57,43,.06)" } : undefined}>
                  <td>
                    <span className="mono">{s.siteCode}</span>
                    <div className="muted" style={{ fontSize: 12 }}>{s.hospital}</div>
                  </td>
                  <td>
                    <span className={`chip ${BAND[s.band].chip}`}>{BAND[s.band].text}</span>
                    <div className="muted" style={{ fontSize: 12 }}>扣分 {s.riskScore}</div>
                  </td>
                  <td className="num">{s.intervalDays} 天</td>
                  <td className="num">{s.sdvSamplePct}%</td>
                  <td>
                    {/* **一次都没监查过 ≠ 刚去过。** 折算成 0 天会让它消失，
                        折算成一个很大的数又会盖住真正的逾期。所以单说一句。 */}
                    {s.neverVisited
                      ? <span className="chip warn" data-testid="mon-never">一次都没去过</span>
                      : <>
                          <span className="mono">{s.lastVisitOn}</span>
                          <div className={(s.overdueDays ?? 0) > 0 ? "chip crit" : "muted"}
                            style={{ fontSize: 12, marginTop: 2 }}
                            data-testid={(s.overdueDays ?? 0) > 0 ? "mon-overdue" : undefined}>
                            {(s.overdueDays ?? 0) > 0
                              ? `逾期 ${s.overdueDays} 天`
                              : `${s.daysSince} 天前 · 下次 ${s.dueOn} 前`}
                          </div>
                        </>}
                  </td>
                  <td style={{ fontSize: 12 }} data-testid="mon-reasons">
                    {s.reasons.join("；")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="derive" style={{ margin: 0 }}>
          质量稳定的中心可以降低 SDV 抽样比例、拉长间隔；
          有未关闭严重事件或入组停滞的要加密。
          <b>建议值一定带理由</b> —— 没有理由的建议值没人照着做，
          也没人能在核查时解释「为什么这个中心只抽了 {board.sites.at(-1)?.sdvSamplePct ?? 25}%」。
          实际用了多少<b>落在访视行上</b>：不采纳建议是可以的，
          但不采纳这件事本身要留得下来。
        </div>
      </div>
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
