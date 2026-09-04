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
  /** 404：不存在，或者不在行范围里 —— 两者对外是同一件事。 */
  const [gone, setGone] = useState(false);
  const [busy, setBusy] = useState(false);
  /* 断网时勾一下、点一下，进的是发件箱 —— 行上要说出来，否则人会再点一次。 */
  const pending = usePending();

  /* **取这一条，不是取一页再在里面找。**
     原来是 `listSubjectVisits({ limit: 200 })` 然后 `.find(v => v.id === id)`。
     种子里只有 10 条访视时，这两种写法看不出任何区别。
     访视上了几百条之后：列表按窗口升序，前 200 条全是更早的历史访视，
     `find` 返回 undefined —— 而 undefined 就是"还没加载完"的那个值，
     于是页面**永远停在「加载中…」**。没有报错，没有空态，
     Network 里那个请求还是 200。这是最难报障的一种坏法。 */
  const load = () =>
    call<Visit>("getSubjectVisit", { params: { id } })
      .then(v => { setVisit(v); setGone(false); })
      .catch(e => {
        if (e instanceof ApiError && e.problem.status === 404) { setVisit(null); setGone(true); return; }
        throw e;
      });
  useEffect(() => { void load(); }, [id]);

  /* 三种状态要分得开：拿到了 / 还在拿 / 拿不到。
     把后两种合成一个「加载中…」，正是上面那个 bug 能藏这么久的原因。 */
  if (gone) return (
    <div className="stack">
      <Link to="/today" className="muted">← 今天</Link>
      <p className="problem" data-testid="visit-gone">
        找不到这次访视，或者它不在你的范围里。
      </p>
    </div>
  );
  if (!visit) return <p className="muted">加载中…</p>;

  const open = visit.tasks.filter(t => !t.doneAt);
  const outOfWindow = actualDate < visit.windowFrom || actualDate > visit.windowTo;
  const done = visit.status !== "planned";

  async function tick(seq: number) {
    await call("completeVisitTask", { params: { id, seq }, body: {} });
    await load();
  }

  /** 标记已录入 EDC。断网时照样能按 —— 与勾任务、完成访视同一条路，
   *  进发件箱，联网后自己发出去。 */
  async function markEdc() {
    setBusy(true); setProblem(null);
    try {
      await call("enterVisitToEdc", { params: { id }, body: {} });
      await load();
    } catch (e) {
      if (e instanceof ApiError) setProblem(e.problem); else throw e;
    } finally { setBusy(false); }
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

        {/* ── 录入 EDC ────────────────────────────────────────────────
            **完成访视和录进 EDC 是两件事。** 访视做完了，数据还躺在
            原始病历上 —— 而数据管理那边看到的是"这一例还没有数"。
            5 个工作日内录入才算及时；超时不阻断，但进及时率统计。

            此前这一步在界面上标不了：访视能完成、能确认，就是没法说
            "数已经录进去了"，于是那个及时率永远只有分母。 */}
        {done && visit.edcStatus === "pending" && (
          <section className="card stack" data-testid="edc-block">
            <div className="card-h">
              <h3>录入 EDC</h3>
              <span className="sub">完成访视和录进 EDC 是两件事</span>
            </div>
            <div className="card-b stack">
              {visit.edcDaysLate != null && visit.edcDaysLate > 0
                ? <div className="problem" data-testid="edc-late">
                    已超出 5 个工作日 <b className="num">{visit.edcDaysLate}</b> 天 ——
                    <b>不阻断，但进及时率统计</b>。
                  </div>
                : <p className="note" style={{ margin: 0 }}>
                    访视完成后 5 个工作日内录入才算及时。
                  </p>}
              <div className="row">
                <button className="btn btn-p" data-testid="edc-entered"
                  disabled={busy || !!pending("enterVisitToEdc", { id })}
                  onClick={() => void markEdc()}>
                  {pending("enterVisitToEdc", { id }) ? "已排进发件箱" : "标记已录入 EDC"}
                </button>
                {pending("enterVisitToEdc", { id }) &&
                  <span className="chip flat" data-testid="edc-queued">待发</span>}
              </div>
            </div>
          </section>
        )}
        {done && visit.edcStatus === "entered" && (
          <p className="muted" data-testid="edc-done">
            <span className="chip good">已录入 EDC</span>
          </p>
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
              {/* 「尚未接上」那一块。现在七个订阅者全接上了，后端下发的
                  pending 是空数组，于是这里一条都不画。
                  **字段和这段渲染都留着** —— 下一个暂时接不上的订阅者
                  出现时，它要能立刻在界面上说出来，而不是先经历一轮
                  "为什么没人知道还差一件事"。 */}
              {result.pending?.map(p => (
                <li key={p.name} className="pending" data-testid="pending-subscribers">
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
