import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useToast } from "@sitedesk/ui/react";
import { VISIT_STATUS_LABEL, type VisitStatus } from "@sitedesk/contracts";
import { call, ApiError, type ProblemDetails } from "../../api/client.js";
import { loadMe } from "../login/me.js";
import { yuan } from "../cost/money.js";
import { ReportSaeForm } from "../quality/SaePanel.js";
import { UnmetList, type UnmetItem } from "../../shell/Unmet.js";
import { STATE_LABEL, OPEN_STATES, scheduleVisit, type Subject } from "./api.js";
import { WithdrawForm } from "./WithdrawForm.js";
import type { Visit } from "../today/TodayPage.js";

/* ════════════════════════════════════════════════════════════════════
   受试者详情 —— 「S-0203 现在什么情况？」

   被问到这一句时，原来要翻四页才答得上来：访视在受试者列表和访视页、
   质疑在数据质疑、SAE 在某个中心的质量页、补偿在受试者补偿 ——
   每一页再按筛选号找一遍。这一页把这个人的事按时间排在一条线上，
   该动手的（补排访视、登记脱落、报告 SAE）也在这里。

   数据都来自现成的列表端点：访视与质疑按受试者筛；质量事件与补偿
   只能按中心筛，取回来再按受试者挑（一个中心至多两百条，够用）。
   ════════════════════════════════════════════════════════════════════ */

interface Query { id: string; code: string; form: string; fieldName: string;
  state: string; raisedOn: string; ageDays: number }
interface QualityEvent { id: string; code: string; kind: string; title: string;
  state: string; raisedOn: string; subjectId: string | null }
interface Payment { id: string; subjectId: string; visitLabel: string | null;
  amountCents: number; dueOn: string; paidOn: string | null }

/** 时间线上的一行。date 用来排，其余都是给人看的。 */
interface Entry {
  key: string; date: string; kind: string; title: string; detail: string;
  chip: "crit" | "warn" | "good" | "flat"; href?: string;
}

const QUERY_STATE: Record<string, string> = { open: "待回复", pending_review: "已回复待关闭", closed: "已关闭" };

export function SubjectPage() {
  const { id = "" } = useParams();
  const [s, setS] = useState<Subject | null>(null);
  const [gone, setGone] = useState(false);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const say = useToast();

  const load = useCallback(async () => {
    let sub: Subject;
    try {
      sub = await call<Subject>("getSubject", { params: { id } });
    } catch (e) {
      /* 范围外与不存在对外是同一件事；没有 subjRead 也落在这里 —— 说"看不到"，不说为什么 */
      if (e instanceof ApiError && [403, 404].includes(e.problem.status)) { setGone(true); return; }
      throw e;
    }
    setS(sub);
    const site = sub.studySiteId;
    const [v, q, qe, pay] = await Promise.all([
      call<{ items: Visit[] }>("listSubjectVisits", { query: { subjectId: id, limit: 200 } }),
      call<{ items: Query[] }>("listDataQueries", { query: { subjectId: id, limit: 200 } })
        .catch(() => ({ items: [] as Query[] })),
      call<{ items: QualityEvent[] }>("listQualityEvents", { query: { studySiteId: site, limit: 200 } })
        .catch(() => ({ items: [] as QualityEvent[] })),
      call<{ items: Payment[] }>("listSubjectPayments", { query: { studySiteId: site, limit: 200 } })
        .catch(() => ({ items: [] as Payment[] }))
    ]);

    const list: Entry[] = [
      ...v.items.map((x): Entry => ({
        key: `v:${x.id}`, date: x.actualDate ?? x.targetDate, kind: "访视", title: x.visitLabel,
        detail: x.status === "planned"
          ? `窗口 ${x.windowFrom} ~ ${x.windowTo}` + (x.outOfWindow ? ` · 已超窗 ${-(x.daysLeft ?? 0)} 天` : "")
          : `${x.actualDate} 完成 · ${VISIT_STATUS_LABEL[x.status as VisitStatus] ?? x.status}`,
        chip: x.status === "planned" ? (x.outOfWindow ? "crit" : (x.daysLeft ?? 99) <= 3 ? "warn" : "flat")
          : x.status === "locked" ? "good" : "warn",
        href: `/visits/${x.id}`
      })),
      ...q.items.map((x): Entry => ({
        key: `q:${x.id}`, date: x.raisedOn, kind: "质疑", title: `${x.code} · ${x.form}「${x.fieldName}」`,
        detail: QUERY_STATE[x.state] ?? x.state,
        chip: x.state === "open" ? (x.ageDays > 7 ? "crit" : "warn") : "flat", href: "/queries"
      })),
      ...qe.items.filter(x => x.subjectId === id && x.kind !== "query").map((x): Entry => ({
        key: `e:${x.id}`, date: x.raisedOn, kind: x.kind === "sae" ? "SAE" : "质量事件",
        title: `${x.code} · ${x.title}`, detail: x.state === "closed" ? "已关闭" : "未关闭",
        chip: x.state === "closed" ? "flat" : x.kind === "sae" ? "crit" : "warn",
        href: `/sites/${site}/quality`
      })),
      ...pay.items.filter(x => x.subjectId === id).map((x): Entry => ({
        key: `p:${x.id}`, date: x.paidOn ?? x.dueOn, kind: "补偿",
        title: `${x.visitLabel ?? "补偿"} · ${yuan(x.amountCents)}`,
        detail: x.paidOn ? `${x.paidOn} 已发放` : `${x.dueOn} 起待发放`,
        chip: x.paidOn ? "good" : "warn", href: "/payments"
      }))
    ];
    /* 新的在上：还没做的访视日期在将来，自然排在最上面 —— 那正是"接下来是什么" */
    list.sort((a, b) => b.date.localeCompare(a.date) || a.key.localeCompare(b.key));
    setEntries(list);
  }, [id]);

  useEffect(() => { setGone(false); setS(null); setEntries(null); void load(); }, [load]);
  useEffect(() => {
    void loadMe().then(m => setCanWrite(m.permissions.actions.includes("subjWrite")))
      .catch(() => setCanWrite(false));
  }, []);

  if (gone) return (
    <div className="stack">
      <Link to="/subjects" className="muted">← 受试者</Link>
      <p className="problem" data-testid="subject-gone">找不到这位受试者，或者他不在你的范围里。</p>
    </div>
  );
  if (!s) return <p className="muted">加载中…</p>;

  const open = OPEN_STATES.includes(s.state);
  const needsVisit = !s.nextVisit && ["screening", "enrolled"].includes(s.state);

  const schedule = async () => {
    setBusy(true); setProblem(null);
    try {
      const r = await scheduleVisit(s.id);
      say(r.sideEffects[0]?.summary ?? `已补排 ${r.data.visitLabel}`);
      await load();
    } catch (e) {
      if (e instanceof ApiError) setProblem(e.problem); else throw e;
    } finally { setBusy(false); }
  };

  return (
    <>
      <div className="page-head">
        <Link to="/subjects" className="muted">← 受试者</Link>
        <h2 style={{ marginTop: 6 }} data-testid="subject-title">
          <span className="mono">{s.screeningNo ?? "受试者"}</span>{" "}
          <span className={`chip ${s.state === "enrolled" ? "good"
            : ["screen_failed", "withdrawn"].includes(s.state) ? "flat" : "warn"}`}
            style={{ verticalAlign: "middle" }}>{STATE_LABEL[s.state] ?? s.state}</span>
        </h2>
        <p>
          <Link to={`/sites/${s.studySiteId}`} className="mono">{s.siteCode}</Link>
          {s.randomizationNo && <> · 随机号 <span className="mono">{s.randomizationNo}</span></>}
          {s.icfSignedOn && <> · 知情 {s.icfSignedOn}</>}
          {s.enrolledOn && <> · 入组 {s.enrolledOn}</>}
          {" "}· 访视 <b className="num">{s.visitsDone}/{s.visitsPlanned}</b>
          {s.crcName && <> · CRC {s.crcName}</>}
        </p>
      </div>

      <div className="stack" style={{ maxWidth: 820 }}>
        {/* 接下来 —— 被问到"这个人怎么样了"时，第一句话就是它 */}
        <section className="card spread" data-testid="subject-next" style={{ gap: 12, flexWrap: "wrap" }}>
          {s.nextVisit ? (
            <>
              <div>
                <div className="muted" style={{ fontSize: 12 }}>下一次访视</div>
                <b>{s.nextVisit.visitLabel}</b>{" "}
                <span className="muted mono">{s.nextVisit.windowFrom} ~ {s.nextVisit.windowTo}</span>
                {s.nextVisit.outOfWindow &&
                  <span className="chip crit" style={{ marginLeft: 8 }}>已超窗 {-s.nextVisit.daysLeft} 天</span>}
              </div>
              <Link to={`/visits/${s.nextVisit.id}`} className="btn primary"
                style={{ textDecoration: "none" }}>去做这次访视</Link>
            </>
          ) : (
            <>
              <span className="muted">
                {needsVisit ? "访视没排出来 —— 签知情时本该连筛选期访视一起排出。" : "没有待做的访视。"}
              </span>
              {needsVisit && canWrite && (
                <button className="btn primary" data-testid="subject-schedule" disabled={busy}
                  onClick={() => void schedule()}>补排访视</button>
              )}
            </>
          )}
        </section>

        {problem && (
          <div className="problem stack" data-testid="subject-problem">
            <strong>{problem.title}</strong>
            {problem.detail && <div>{problem.detail}</div>}
            {Array.isArray(problem.unmet) && <UnmetList items={problem.unmet as UnmetItem[]} testid="subject-unmet" />}
          </div>
        )}

        {canWrite && (
          <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "flex-start" }}>
            <ReportSaeForm studySiteId={s.studySiteId} subjectId={s.id} cta="报告 SAE"
              onCreated={() => void load()} />
            {open && !withdrawing && (
              <button className="btn" data-testid="subject-withdraw"
                onClick={() => setWithdrawing(true)}>登记脱落</button>
            )}
          </div>
        )}
        {withdrawing && (
          <WithdrawForm subject={s} style={{ marginTop: 0 }} onCancel={() => setWithdrawing(false)}
            onDone={summary => { setWithdrawing(false); say(summary); void load(); }} />
        )}

        <section className="card stack" data-testid="subject-timeline">
          <h3>时间线 <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
            访视 · 质疑 · SAE 与质量事件 · 补偿，新的在上</span></h3>
          {entries === null ? <p className="muted">加载中…</p>
            : entries.length === 0 ? <p className="muted">还没有任何记录。</p>
            : <ul className="inbox">
                {entries.map(e => (
                  <li key={e.key} className="inbox-item" data-testid="timeline-item" data-kind={e.kind}>
                    <span className="mono muted" style={{ fontSize: 12, flex: "none" }}>{e.date}</span>
                    <span className={`chip ${e.chip}`}>{e.kind}</span>
                    <div className="inbox-main">
                      <div className="inbox-title">{e.title}</div>
                      <div className="inbox-sub muted">{e.detail}</div>
                    </div>
                    {e.href && <Link to={e.href} className="btn inbox-go"
                      style={{ textDecoration: "none" }}>打开</Link>}
                  </li>
                ))}
              </ul>}
        </section>
      </div>
    </>
  );
}
