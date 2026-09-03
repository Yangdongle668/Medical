import { useEffect, useState } from "react";
import { call, ApiError, type ProblemDetails } from "../../api/client.js";
import { today, daysSince } from "../../shell/dates.js";

/* ════════════════════════════════════════════════════════════════════
   伦理事务。

   ── 一句话：递交了不等于批下来了 ──────────────────────────────────
   关闭闸门看的是**批复**，不是递交。而界面上最容易犯的错，
   就是把"已递交"画成一个绿色的对勾 —— 那会让人以为这件事完了。

   所以这里三种状态各有各的颜色，而且**待批复是警告色不是中性色**：
   一份递上去三个月没动静的修正案，和一份刚递上去的，
   在颜色上必须分得开。

   ── 为什么按中心分组，而不是一张大表 ──────────────────────────────
   伦理是**按中心**批的。同一个项目在 A 医院批了、在 B 医院还没批，
   是完全正常的状态 —— 混成一张按时间排的表，就再也看不出
   "哪个中心还差一份批件"。而那正是这一页要回答的。
   ════════════════════════════════════════════════════════════════════ */

interface Site { id: string; code: string; hospital: string; irbApprovedOn: string | null }
interface Submission {
  id: string; studySiteId: string; kind: string;
  submittedOn: string; decision: string; decidedOn: string | null;
  refNo: string | null; note: string | null;
}

const KIND_LABEL: Record<string, string> = {
  initial: "初始审查", amendment: "方案修正案", annual: "年度/定期跟踪", closeout: "结题报告"
};
const DECISION_LABEL: Record<string, string> = {
  pending: "待批复", approved: "已批准", rejected: "未通过"
};


export function EthicsPage() {
  const [sites, setSites] = useState<Site[] | null>(null);
  const [bySite, setBySite] = useState<Record<string, Submission[]>>({});
  const [adding, setAdding] = useState<Site | null>(null);
  const [deciding, setDeciding] = useState<Submission | null>(null);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const load = async () => {
    const s = await call<{ items: Site[] }>("listStudySites", { query: { limit: 200 } });
    setSites(s.items);
    /* 每个中心一条请求。**这里的 fan-out 是可以接受的**：
       接口按中心开（伦理本来就是按中心批的），而一个人的行范围里
       通常是个位数的中心 —— 经营层 15 个也还好。
       真到了成百上千个中心，该做的是加一条汇总端点，
       而不是在这里加一层缓存。 */
    const all = await Promise.all(s.items.map(x =>
      call<{ items: Submission[] }>("listRegulatorySubmissions",
        { params: { id: x.id }, query: { limit: 100 } })
        .then(r => [x.id, r.items] as const)));
    setBySite(Object.fromEntries(all));
  };

  useEffect(() => { void load(); }, []);

  const run = async (what: string, fn: () => Promise<unknown>) => {
    setProblem(null); setSaid(null);
    try {
      await fn(); await load();
      setSaid(what); setAdding(null); setDeciding(null);
    } catch (e) { if (e instanceof ApiError) setProblem(e.problem); else throw e; }
  };

  if (!sites) return <p className="muted">加载中…</p>;

  const all = Object.values(bySite).flat();
  const pending = all.filter(x => x.decision === "pending");
  const stale = pending.filter(x => daysSince(x.submittedOn) > 60);
  const noApproval = sites.filter(s => !s.irbApprovedOn);

  return (
    <>
      <div className="page-head">
        <h2>伦理事务</h2>
        <p data-testid="ethics-summary">
          {sites.length} 个中心，{all.length} 份递交，<b>{pending.length} 份待批复</b>
          {stale.length > 0 && <>，其中 <b>{stale.length} 份递上去超过 60 天</b></>}。
        </p>
      </div>

      {noApproval.length > 0 && (
        <div className="problem" data-testid="no-irb" style={{ marginBottom: 14 }} role="status">
          <strong>{noApproval.length} 个中心还没有伦理批件日。</strong>
          <div className="muted">
            这不只是一栏没填：<b>知情同意的签署日不能早于批件日</b> ——
            没有批件日的中心，登记知情那一步会被库直接拦下。
            {noApproval.map(s => s.code).join("、")}
          </div>
        </div>
      )}

      {problem && (
        <div className="problem stack" data-testid="ethics-problem" style={{ marginBottom: 12 }}>
          <strong>{problem.title}</strong>
          {problem.detail && <div>{problem.detail}</div>}
        </div>
      )}
      {said && <p className="muted" data-testid="ethics-said">{said}</p>}

      <div className="stack">
        {sites.map(site => {
          const subs = bySite[site.id] ?? [];
          const open = subs.filter(x => x.decision === "pending");
          return (
            <div className="card stack" key={site.id} data-testid="ethics-site">
              <div className="spread">
                <h3>
                  {site.code} <span className="muted" style={{ fontSize: 13 }}>{site.hospital}</span>
                </h3>
                <div className="row" style={{ gap: 8, alignItems: "center" }}>
                  {site.irbApprovedOn
                    ? <span className="muted mono">批件 {site.irbApprovedOn}</span>
                    : <span className="chip crit">无批件日</span>}
                  {open.length > 0 && <span className="chip warn">{open.length} 份待批复</span>}
                  <button className="btn" data-testid={`add-${site.code}`}
                    onClick={() => { setAdding(site); setProblem(null); setSaid(null); }}>
                    登记递交
                  </button>
                </div>
              </div>

              {subs.length === 0
                ? <p className="muted" style={{ margin: 0 }}>还没有递交记录。</p>
                : <div className="table-wrap">
                    <table>
                      <thead>
                        <tr><th>类型</th><th>递交日</th><th>状态</th><th>批复日</th>
                          <th>批件号</th><th>说明</th><th /></tr>
                      </thead>
                      <tbody>
                        {[...subs]
                          /* 待批复的排最前，其余按递交日倒序 */
                          .sort((a, b) =>
                            Number(b.decision === "pending") - Number(a.decision === "pending")
                            || b.submittedOn.localeCompare(a.submittedOn))
                          .map(x => (
                            <tr key={x.id} data-testid="ethics-row">
                              <td>{KIND_LABEL[x.kind] ?? x.kind}</td>
                              <td className="mono muted">{x.submittedOn}</td>
                              <td>{decisionChip(x)}</td>
                              <td className="mono muted">{x.decidedOn ?? "—"}</td>
                              <td className="mono muted">{x.refNo ?? "—"}</td>
                              <td className="muted">{x.note ?? "—"}</td>
                              <td>
                                {x.decision === "pending" && (
                                  <button className="btn" data-testid={`decide-${x.id}`}
                                    onClick={() => { setDeciding(x); setProblem(null); setSaid(null); }}>
                                    登记批复
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>}
            </div>
          );
        })}
      </div>

      {adding && (
        <AddForm site={adding} onCancel={() => setAdding(null)}
          onGo={(b) => void run(`已登记一次${KIND_LABEL[b.kind]}递交`,
            () => call("recordRegulatorySubmission",
              { params: { id: adding.id }, body: b }))} />
      )}

      {deciding && (
        <DecideForm onCancel={() => setDeciding(null)}
          onGo={(b) => void run(
            b.decision === "approved" ? "已登记批准" : "已登记未通过",
            () => call("decideRegulatorySubmission",
              { params: { id: deciding.id }, body: b }))} />
      )}

      <div className="derive" style={{ marginTop: 14 }}>
        <b>递交了不等于批下来了。</b> 关闭闸门看的是批复，不是递交 ——
        所以「待批复」用的是警告色，不是中性色：
        一份递上去三个月没动静的修正案，和一份刚递上去的，必须分得开。
        <br />
        按中心分组而不是一张大表，因为<b>伦理是按中心批的</b>：
        同一个项目在 A 医院批了、在 B 医院还没批是正常状态，
        混成一张按时间排的表就再也看不出「哪个中心还差一份批件」。
      </div>
    </>
  );
}

function decisionChip(x: Submission) {
  if (x.decision === "approved") return <span className="chip good">已批准</span>;
  if (x.decision === "rejected") return <span className="chip crit">未通过</span>;
  const d = daysSince(x.submittedOn);
  return (
    <span className={`chip ${d > 60 ? "crit" : "warn"}`}>
      待批复 {d} 天
    </span>
  );
}

function AddForm({ site, onCancel, onGo }: {
  site: Site; onCancel: () => void;
  onGo: (b: { kind: string; submittedOn: string; refNo?: string; note?: string }) => void;
}) {
  const [kind, setKind] = useState("amendment");
  const [d, setD] = useState(today());
  const [refNo, setRefNo] = useState("");
  const [note, setNote] = useState("");
  return (
    <div className="card stack" data-testid="add-form" style={{ marginTop: 12 }}>
      <div className="spread">
        <h3>登记递交 · {site.code}</h3>
        <button className="btn" onClick={onCancel}>取消</button>
      </div>
      <div className="grid-form">
        <label className="field"><span>类型</span>
          <select value={kind} data-testid="sub-kind" onChange={e => setKind(e.target.value)}>
            {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select></label>
        <label className="field"><span>递交日</span>
          <input type="date" value={d} data-testid="sub-date"
            onChange={e => setD(e.target.value)} /></label>
        <label className="field"><span>受理号（可选）</span>
          <input value={refNo} data-testid="sub-ref" className="mono"
            onChange={e => setRefNo(e.target.value)} /></label>
      </div>
      <label className="field"><span>说明（可选）</span>
        <textarea rows={2} value={note} data-testid="sub-note"
          onChange={e => setNote(e.target.value)}
          placeholder="例：方案 v3.1，新增一次影像评估" /></label>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn primary" data-testid="sub-go" disabled={!kind || !d}
          onClick={() => onGo({
            kind, submittedOn: d,
            ...(refNo.trim() ? { refNo: refNo.trim() } : {}),
            ...(note.trim() ? { note: note.trim() } : {})
          })}>登记</button>
      </div>
    </div>
  );
}

function DecideForm({ onCancel, onGo }: {
  onCancel: () => void;
  onGo: (b: { decision: string; decidedOn: string; note?: string }) => void;
}) {
  const [decision, setDecision] = useState("approved");
  const [d, setD] = useState(today());
  const [note, setNote] = useState("");
  return (
    <div className="card stack" data-testid="decide-form" style={{ marginTop: 12 }}>
      <div className="spread"><h3>登记批复</h3>
        <button className="btn" onClick={onCancel}>取消</button></div>
      <p className="muted" style={{ margin: 0 }}>
        关闭闸门看的是这一步。<b>「未通过」也要登记</b> ——
        一份被退回的修正案留在"待批复"里，会让人以为伦理那边还在审。
      </p>
      <div className="grid-form">
        <label className="field"><span>结论</span>
          <select value={decision} data-testid="dec-decision"
            onChange={e => setDecision(e.target.value)}>
            <option value="approved">已批准</option>
            <option value="rejected">未通过</option>
          </select></label>
        <label className="field"><span>批复日</span>
          <input type="date" value={d} data-testid="dec-date"
            onChange={e => setD(e.target.value)} /></label>
      </div>
      <label className="field"><span>说明（可选）</span>
        <textarea rows={2} value={note} data-testid="dec-note"
          onChange={e => setNote(e.target.value)} /></label>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn primary" data-testid="dec-go" disabled={!d}
          onClick={() => onGo({
            decision, decidedOn: d, ...(note.trim() ? { note: note.trim() } : {})
          })}>确认</button>
      </div>
    </div>
  );
}
