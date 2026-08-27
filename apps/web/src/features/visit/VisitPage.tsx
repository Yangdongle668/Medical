import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { call, ApiError, type ProblemDetails } from "../../api/client.js";
import type { Visit } from "../today/TodayPage.js";
import { usePending } from "../../api/pending.js";

/* 完成一次访视 —— 系统里最重要的一个动作。
   界面要做对两件事：
   ① 任务没勾完，提交按钮就该是禁用的，而**旁边写清楚还差什么**；
   ② 提交后把一串后果原样摊开 —— 一线必须立刻知道
      「我刚才不只是打了个卡，系统还替我记了一次方案偏离」。 */

interface SideEffect {
  type: string; summary: string; ref?: string; amountCents?: number;
}
interface CompleteResult {
  data: Visit; sideEffects: SideEffect[];
  pending?: { name: string; what: string; phase: string }[];
}

const today = () => new Date().toISOString().slice(0, 10);

export function VisitPage() {
  const { id = "" } = useParams();
  const [visit, setVisit] = useState<Visit | null>(null);
  const [actualDate, setActualDate] = useState(today());
  const [hours, setHours] = useState("3.5");
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<CompleteResult | null>(null);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [busy, setBusy] = useState(false);
  /* 断网时勾一下、点一下，进的是发件箱 —— 行上要说出来，否则人会再点一次。 */
  const pending = usePending();

  const load = () =>
    call<{ items: Visit[] }>("listSubjectVisits", { query: { limit: 200 } })
      .then(r => setVisit(r.items.find(v => v.id === id) ?? null));
  useEffect(() => { void load(); }, [id]);

  if (!visit) return <p className="muted">加载中…</p>;

  const open = visit.tasks.filter(t => !t.doneAt);
  const outOfWindow = actualDate < visit.windowFrom || actualDate > visit.windowTo;
  const done = visit.status !== "planned";

  async function tick(seq: number) {
    await call("completeVisitTask", { params: { id, seq }, body: {} });
    await load();
  }

  async function submit() {
    setBusy(true); setProblem(null);
    try {
      const r = await call<CompleteResult>("completeSubjectVisit", {
        params: { id },
        body: {
          actualDate, hours: Number(hours),
          ...(outOfWindow && reason ? { outOfWindowReason: reason } : {})
        }
      });
      setResult(r); await load();
    } catch (e) {
      if (e instanceof ApiError) setProblem(e.problem); else throw e;
    } finally { setBusy(false); }
  }

  return (
    <>
      <div className="page-head">
        <Link to="/today" className="muted">← 今天</Link>
        <h2 style={{ marginTop: 6 }}>{visit.visitLabel}</h2>
        <p>
          <span className="mono">{visit.screeningNo ?? "—"}</span> ·{" "}
          <span className="mono">{visit.siteCode}</span> · 窗口{" "}
          <span className="mono">{visit.windowFrom} ~ {visit.windowTo}</span>
        </p>
      </div>

      <div className="stack" style={{ maxWidth: 720 }}>
        <section className="card">
          <div className="spread" style={{ marginBottom: 10 }}>
            <h3>访视任务</h3>
            <span className="muted num" data-testid="task-count">
              {visit.tasks.length - open.length}/{visit.tasks.length}
            </span>
          </div>
          <ul className="tasks">
            {visit.tasks.map(t => (
              <li key={t.seq} className={t.doneAt ? "done" : ""}>
                <input type="checkbox"
                  checked={!!t.doneAt || !!pending("completeVisitTask", { id, seq: t.seq })}
                  disabled={!!t.doneAt || done || !!pending("completeVisitTask", { id, seq: t.seq })}
                  onChange={() => void tick(t.seq)}
                  aria-label={t.task} style={{ width: "auto" }} />
                <span>{t.task}</span>
                {/* 「待发」不是「已完成」：勾是人的意思，落库还没发生。 */}
                {pending("completeVisitTask", { id, seq: t.seq }) &&
                  <span className="chip flat" data-testid="queued-chip">待发</span>}
              </li>
            ))}
          </ul>
        </section>

        {!done && (
          <section className="card stack">
            <h3>完成访视</h3>
            <div className="row" style={{ gap: 14 }}>
              <label className="field" style={{ flex: "1 1 160px" }}>
                <span>实际完成日</span>
                <input type="date" value={actualDate} data-testid="actual-date"
                  onChange={e => setActualDate(e.target.value)} />
              </label>
              <label className="field" style={{ flex: "1 1 120px" }}>
                <span>本次投入工时</span>
                <input type="number" step="0.5" min="0.25" max="24" value={hours}
                  data-testid="hours" onChange={e => setHours(e.target.value)} />
              </label>
            </div>

            {outOfWindow && (
              <label className="field">
                <span>
                  超窗原因（必填）—— 它会原样进入方案偏离记录
                </span>
                <textarea rows={2} value={reason} data-testid="oow-reason"
                  onChange={e => setReason(e.target.value)}
                  placeholder="例如：受试者外地务工，返院延迟" />
              </label>
            )}

            {open.length > 0 && (
              <p className="muted" data-testid="blocked-hint">
                还有 {open.length} 项任务未完成：{open.map(t => t.task).join("、")}
              </p>
            )}

            <div className="row">
              <button className="btn primary" data-testid="submit"
                disabled={busy || open.length > 0 || !!pending("completeSubjectVisit", { id })
                  || (outOfWindow && reason.trim().length < 4)}
                onClick={() => void submit()}>
                {pending("completeSubjectVisit", { id }) ? "已排进发件箱"
                  : busy ? "提交中…" : "完成访视"}
              </button>
              {pending("completeSubjectVisit", { id }) &&
                <span className="chip flat" data-testid="queued-chip">待发</span>}
              {outOfWindow && <span className="chip crit">超窗提交</span>}
            </div>
          </section>
        )}

        {problem && (
          <div className="problem" data-testid="problem">
            <strong>{problem.title}</strong>
            <div>{problem.detail}</div>
            {problem.unmet && (
              <ul>{problem.unmet.map((u, i) => <li key={i}>{u.message}</li>)}</ul>
            )}
          </div>
        )}

        {result && (
          <section className="card stack" data-testid="effects">
            <h3>这一次提交，系统还做了这些</h3>
            <ul className="effects">
              {result.sideEffects.map((e, i) => (
                <li key={i}>
                  <div className="t">{e.type}</div>
                  <div>{e.summary}</div>
                </li>
              ))}
              {result.pending?.map(p => (
                <li key={p.name} className="pending">
                  <div className="t">尚未接上</div>
                  <div>{p.name}：{p.what}（{p.phase}）</div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </>
  );
}
