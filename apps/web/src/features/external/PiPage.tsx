import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { call, ApiError, type ProblemDetails } from "../../api/client.js";
import { loadMe, type Me } from "../login/me.js";
import { listEnrollment, pct, type Funnel } from "../enrollment/api.js";
import { daysSince } from "../../shell/dates.js";

/* ════════════════════════════════════════════════════════════════════
   研究者工作台（PI）。

   ── 这一页只为一个动作存在 ────────────────────────────────────────
   PI 在这套系统里能做的事只有一件：**确认访视**。
   他的角色一共两个动作（piConfirm / subjRead）、两个模块（pi / qa）——
   把这一页做成"什么都有一点"的门户，等于让他每次登录都要先找一遍
   那个唯一要点的按钮。

   所以：待确认的排最上面，且**逾期的排在最前**。

   ── 为什么 PI 确认不是走过场 ──────────────────────────────────────
   CRC 说做完了、和 PI 确认做完了，在核查时是两回事：
   前者是记录，后者是**签字**。未确认的访视不计入「已完成」统计 ——
   这一条写在页面上，因为它解释了 PI 眼里的入组数
   为什么可能比 CRC 报的少。

   ── 行范围就是"我担任研究者的中心" ────────────────────────────────
   row_rule = pi，由 `study_site.pi_account_id` 推导。
   同一家医院的另一个科室在做另一个项目，他看不到 —— 这是对的：
   他不是机构办，他只对自己签字的那些中心负责。
   ════════════════════════════════════════════════════════════════════ */

interface Visit {
  id: string; subjectId: string; screeningNo?: string;
  studySiteId: string; siteCode: string;
  visitCode: string; visitLabel: string;
  targetDate: string; actualDate: string | null;
  windowTo: string; outOfWindow: boolean; status: string;
  piConfirmedAt: string | null; piConfirmedByName: string | null;
}
interface Site {
  id: string; code: string; hospital: string; dept: string; state: string;
}
interface Quality {
  id: string; code: string; siteCode: string; kind: string;
  severity: string; state: string; title: string; ageDays: number;
}

const KIND: Record<string, string> = {
  deviation: "方案偏离", query: "数据质疑", ip_discrepancy: "药品不平衡",
  sae: "严重不良事件", sae_late: "SAE 超时上报", other: "其他"
};

export function PiPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [pending, setPending] = useState<Visit[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [funnels, setFunnels] = useState<Funnel[]>([]);
  const [quality, setQuality] = useState<Quality[]>([]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const loadPending = () =>
    /* **服务端筛**。取一页回来再在 JS 里挑 piConfirmedAt === null，
       在种子只有十几条访视时看不出区别，上了几百条之后
       第一页全是历史，这一页就永远是空的。 */
    call<{ items: Visit[] }>("listSubjectVisits",
      { query: { limit: 100, pendingPi: true } }).then(r => setPending(r.items));

  useEffect(() => {
    void (async () => {
      const [m, s, f, q] = await Promise.all([
        loadMe(),
        call<{ items: Site[] }>("listStudySites", { query: { limit: 100 } }),
        listEnrollment(),
        call<{ items: Quality[] }>("listQualityEvents", { query: { limit: 100 } })
      ]);
      setMe(m); setSites(s.items); setFunnels(f.items); setQuality(q.items);
      await loadPending();
      setReady(true);
    })();
  }, []);

  if (!ready || !me) return <p className="muted">加载中…</p>;

  const canConfirm = me.permissions.actions.includes("piConfirm");
  /* 无权限时字段**整个不在**响应里（不是 null）—— 所以判断的是 undefined。 */
  const seesSubject = pending.some(v => v.screeningNo !== undefined);

  const confirm = async (v: Visit) => {
    setBusy(v.id); setProblem(null); setSaid(null);
    try {
      await call("confirmSubjectVisit", { params: { id: v.id }, body: {} });
      await loadPending();
      setSaid(`已确认 ${v.siteCode} 的 ${v.visitLabel}`);
    } catch (e) {
      if (e instanceof ApiError) setProblem(e.problem); else throw e;
    } finally { setBusy(null); }
  };

  /* 逾期最久的排最前。**不按中心、不按日期正序** ——
     一次做完了三周没人签字的访视，比今天刚做完的那次紧急得多。 */
  const queue = [...pending].sort((a, b) => {
    const da = daysSince(a.actualDate ?? a.targetDate);
    const db = daysSince(b.actualDate ?? b.targetDate);
    return db - da || a.siteCode.localeCompare(b.siteCode);
  });
  const stale = queue.filter(v => daysSince(v.actualDate ?? v.targetDate) > 7);
  const openQa = quality.filter(q => q.state !== "closed");
  const enrolled = funnels.reduce((n, f) => n + f.enrolled, 0);
  const contracted = funnels.reduce((n, f) => n + f.contracted, 0);

  return (
    <>
      <div className="page-head">
        <h2>研究者工作台</h2>
        <p data-testid="pi-summary">
          {me.account.displayName} · {sites.length} 个中心由你担任研究者。
          {queue.length === 0
            ? " 没有等你确认的访视。"
            : <> <b>{queue.length} 次访视等你确认</b>
                {stale.length > 0 && <>，其中 <b>{stale.length} 次已经等了一周以上</b></>}。</>}
        </p>
      </div>

      <div className="derive" style={{ marginBottom: 14 }}>
        <b>CRC 说做完了，和你确认做完了，是两回事。</b>
        前者是记录，后者是签字 —— 未经确认的访视<b>不计入「已完成」统计</b>。
        所以这里的待确认数一直不降，中心的入组进度就会一直比 CRC 报的低，
        而那不是数据错了。
      </div>

      <div className="stats" style={{ marginBottom: 16 }}>
        <Stat label="待我确认" v={String(queue.length)}
          note={stale.length ? `${stale.length} 次超过 7 天` : "都是最近的"}
          bad={stale.length > 0} />
        <Stat label="我的中心" v={String(sites.length)}
          note={`${sites.filter(s => s.state === "enrolling").length} 个在入组`} />
        <Stat label="入组" v={`${enrolled}/${contracted}`}
          note={contracted ? `达成 ${pct(enrolled / contracted)}` : "还没有合同例数"} />
        <Stat label="未关闭质量事件" v={String(openQa.length)}
          note={openQa.length ? `最久的 ${Math.max(...openQa.map(q => q.ageDays))} 天` : "无"}
          bad={openQa.some(q => q.severity === "critical")} />
      </div>

      {problem && (
        <div className="problem stack" data-testid="pi-problem" style={{ marginBottom: 12 }}>
          <strong>{problem.title}</strong>
          {problem.detail && <div>{problem.detail}</div>}
        </div>
      )}
      {said && <p className="muted" data-testid="pi-said">{said}</p>}

      <h3>等你确认的访视</h3>
      {queue.length === 0 ? (
        <p className="muted" data-testid="pi-empty">
          都签完了。<b>这一页空着是好事</b> —— 它只列等你签字的那些。
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>中心</th>
                {seesSubject && <th>筛选号</th>}
                <th>访视</th><th>完成日</th><th>等了多久</th><th>窗口</th><th />
              </tr>
            </thead>
            <tbody>
              {queue.map(v => {
                const waited = daysSince(v.actualDate ?? v.targetDate);
                return (
                  <tr key={v.id} data-testid="pi-visit">
                    <td className="mono">{v.siteCode}</td>
                    {seesSubject && <td className="mono">{v.screeningNo}</td>}
                    <td>
                      <Link to={`/visits/${v.id}`}>{v.visitLabel}</Link>
                      <span className="mono muted" style={{ marginLeft: 6 }}>{v.visitCode}</span>
                    </td>
                    <td className="mono muted">{v.actualDate ?? "未完成"}</td>
                    <td>
                      {waited > 7
                        ? <span className="chip warn" data-testid="pi-stale">{waited} 天</span>
                        : <span className="muted">{waited} 天</span>}
                    </td>
                    <td>
                      {v.outOfWindow
                        ? <span className="chip crit">超窗</span>
                        : <span className="muted mono">至 {v.windowTo}</span>}
                    </td>
                    <td>
                      {canConfirm ? (
                        <button className="btn primary" data-testid={`pi-confirm-${v.id}`}
                          disabled={busy === v.id} onClick={() => void confirm(v)}>
                          {busy === v.id ? "…" : "我确认"}
                        </button>
                      ) : <span className="muted">不归你签</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <h3 style={{ marginTop: 22 }}>我的中心</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>中心</th><th>医院 · 科室</th><th>阶段</th>
              <th className="num">入组 / 合同</th><th className="num">达成</th>
              <th>未关闭事件</th>
            </tr>
          </thead>
          <tbody>
            {sites.map(s => {
              const f = funnels.find(x => x.studySiteId === s.id);
              const qa = openQa.filter(q => q.siteCode === s.code);
              return (
                <tr key={s.id} data-testid="pi-site">
                  <td className="mono"><Link to={`/sites/${s.id}`}>{s.code}</Link></td>
                  <td>{s.hospital} · <span className="muted">{s.dept}</span></td>
                  <td>{s.state}</td>
                  <td className="num">{f ? `${f.enrolled} / ${f.contracted}` : "—"}</td>
                  <td className="num">{f?.attainment !== null && f
                    ? pct(f.attainment) : "—"}</td>
                  <td>{qa.length === 0
                    ? <span className="muted">无</span>
                    : <span className={qa.some(q => q.severity === "critical")
                        ? "chip crit" : "chip warn"}>{qa.length} 件</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {openQa.length > 0 && (
        <>
          <h3 style={{ marginTop: 22 }}>我这几个中心上未关闭的质量事件</h3>
          <ul className="unmet" data-testid="pi-qa">
            {openQa.sort((a, b) => b.ageDays - a.ageDays).map(q => (
              <li key={q.id}>
                <span className="mono">{q.siteCode}</span> · {KIND[q.kind] ?? q.kind} ·
                {" "}{q.title}
                <span className="muted"> —— 挂了 {q.ageDays} 天</span>
              </li>
            ))}
          </ul>
          <p className="muted">
            列在这里是让你知道<b>你签字的中心上有什么没了结</b>。
            关闭权不在你手上 —— 机构提出的事件由机构关，我方提出的由质量部关。
          </p>
        </>
      )}

      <div className="derive" style={{ marginTop: 14 }}>
        你看到的中心由 <b>行范围</b> 决定（<span className="mono">{me.permissions.rowRule}</span>）：
        <span className="mono">study_site.pi_account_id</span> 指到你的那些。
        同一家医院另一个科室在做的项目你看不到 —— 那不是遗漏：
        你不是机构办，你只对自己签字的中心负责。
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
