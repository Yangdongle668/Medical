import { useEffect, useState } from "react";
import { call, ApiError, type ProblemDetails } from "../../api/client.js";
import { loadMe, type Me } from "../login/me.js";

/* ════════════════════════════════════════════════════════════════════
   内部稽查 —— 我方的第二道防线。

   ── 机构质控是医院查我们，稽查是我们自己查自己 ────────────────────
   而 QA 真正的价值**不在于再发现一批问题** ——
   在于回答一个问题：**同类问题是否复发。**

   复发 = 当初只做了纠正，没做预防。
   「研究者集中补签并留痕」是纠正 —— 补完签名，下个月照样缺。
   预防是把签名完整性做进 CRC 每周自查清单并留痕，
   或者改用带强制签名字段的电子源数据。

   **只做纠正不做预防的 CAPA，等于把同一个核查风险往后推了一个季度。**

   ── 两种复发都算数，但要分得开 ────────────────────────────────────
     · 源事件已关闭 → 关闭后复发：CAPA 写错了方向；
     · 源事件还开着 → 整改期内复发：措施根本没起作用 —— 这个更急。

   ── 「待观察」里原来混着「根本没人写措施」 ────────────────────────
   那不是待观察，是没人管。所以判定分了四档，
   而「没人管」排在「待观察」前面。
   ════════════════════════════════════════════════════════════════════ */

interface Finding {
  seq: number; severity: string; finding: string;
  repeatOf: string | null; repeatOfCode: string | null;
  repeatAfterClose: boolean | null;
  state: "open" | "closed"; verification: string | null; closedAt: string | null;
}
interface Audit {
  id: string; code: string;
  studySiteId: string; siteCode: string; hospital: string;
  kind: string; auditedOn: string;
  auditorAccountId: string; auditorName: string;
  scope: string; state: "open" | "remediating" | "closed"; closedAt: string | null;
  findings: Finding[]; openFindings: number; repeatFindings: number;
}
interface Capa {
  category: string; total: number; closed: number; owesPlan: number;
  repeatAfterClose: number; repeatWhileOpen: number;
  verdict: "ineffective" | "unowned" | "watching" | "effective";
}
interface Grade {
  studySiteId: string; siteCode: string; hospital: string;
  penalty: number; grade: "A" | "B" | "C" | "D"; reasons: string[];
  severeOpen: number; minorOpen: number; saeLate: number;
  staleQueries: number; capaRepeats: number;
}
interface Board {
  openAudits: number; openFindings: number; repeatFindings: number;
  owesCapaPlan: number;
  capa: Capa[]; sites: Grade[]; calcVersion: string;
}
interface Site { id: string; code: string; hospital: string }

const KIND: Record<string, string> = {
  site: "中心内部稽查", system: "体系稽查",
  capa_check: "CAPA 有效性验证", pre_inspection: "核查前模拟稽查"
};
const SEV: Record<string, { text: string; chip: string }> = {
  critical: { text: "重大", chip: "crit" },
  major: { text: "严重", chip: "crit" },
  minor: { text: "一般", chip: "warn" }
};
const STATE: Record<Audit["state"], { text: string; chip: string }> = {
  open: { text: "进行中", chip: "warn" },
  remediating: { text: "待整改", chip: "warn" },
  closed: { text: "已关闭", chip: "flat" }
};
const VERDICT: Record<Capa["verdict"], { text: string; chip: string }> = {
  ineffective: { text: "无效：需重做根因分析", chip: "crit" },
  unowned: { text: "没人管：欠着整改措施", chip: "crit" },
  watching: { text: "待观察：尚有未关闭项", chip: "warn" },
  effective: { text: "有效：关闭后未复发", chip: "flat" }
};
const GRADE: Record<Grade["grade"], string> = {
  A: "flat", B: "flat", C: "warn", D: "crit"
};

export function QaAuditPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [rows, setRows] = useState<Audit[] | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [opening, setOpening] = useState(false);
  const [siteId, setSiteId] = useState("");
  const [kind, setKind] = useState("site");
  const [scope, setScope] = useState("");
  const [closing, setClosing] = useState<{ a: Audit; seq: number } | null>(null);
  const [verification, setVerification] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const reload = () => Promise.all([
    call<{ items: Audit[] }>("listInternalAudits", { query: { limit: 100 } })
      .then(r => setRows(r.items)),
    call<Board>("getAuditBoard", {}).then(setBoard)
  ]);

  useEffect(() => {
    void loadMe().then(setMe);
    void reload();
    void call<{ items: Site[] }>("listStudySites", { query: { limit: 200 } })
      .then(r => { setSites(r.items); setSiteId(s => s || r.items[0]?.id || ""); })
      .catch(() => setSites([]));
  }, []);

  if (!me || !rows || !board) return <p className="muted">加载中…</p>;

  const canAudit = me.permissions.actions.includes("audit");
  const gradeD = board.sites.filter(s => s.grade === "D");
  const worst = board.capa.filter(c => c.verdict === "ineffective");

  const openAudit = async () => {
    setBusy(true); setProblem(null); setSaid(null);
    try {
      const r = await call<{ sideEffects: { summary: string }[] }>("openInternalAudit", {
        body: { studySiteId: siteId, kind, scope: scope.trim() }
      });
      await reload();
      setOpening(false); setScope("");
      setSaid(r.sideEffects[0]?.summary ?? "已发起");
    } catch (e) {
      if (e instanceof ApiError) setProblem(e.problem); else throw e;
    } finally { setBusy(false); }
  };

  const closeFinding = async () => {
    if (!closing) return;
    setBusy(true); setProblem(null); setSaid(null);
    try {
      const r = await call<{ sideEffects: { summary: string }[] }>("closeAuditFinding", {
        params: { id: closing.a.id, seq: closing.seq },
        body: { verification: verification.trim() }
      });
      await reload();
      setClosing(null); setVerification("");
      setSaid(r.sideEffects[0]?.summary ?? "已关闭");
    } catch (e) {
      if (e instanceof ApiError) setProblem(e.problem); else throw e;
    } finally { setBusy(false); }
  };

  return (
    <>
      <div className="page-head">
        <h2>内部稽查</h2>
        <p data-testid="audit-summary">
          {board.openAudits} 项稽查进行中，<b>{board.openFindings} 项发现待整改</b>
          {board.repeatFindings > 0 && <>，其中 <b>{board.repeatFindings} 项是复发</b></>}。
        </p>
      </div>

      <div className="derive" style={{ marginBottom: 14 }}>
        机构质控是医院查我们，稽查是我们<b>自己查自己</b>。
        而 QA 的价值<b>不在于再发现一批问题</b> ——
        在于回答一个问题：<b>同类问题是否复发</b>。
        复发 = 当初只做了纠正，没做预防。
      </div>

      <div className="stats" style={{ marginBottom: 16 }}>
        <Stat label="进行中稽查" v={String(board.openAudits)}
          note={board.openAudits ? "发现项逐条验证" : "无"} bad={board.openAudits > 0} />
        <Stat label="待整改发现" v={String(board.openFindings)}
          note={board.openFindings ? "验证之后才关得掉" : "无"} bad={board.openFindings > 0} />
        <Stat label="复发问题" v={String(board.repeatFindings)}
          note={board.repeatFindings ? "证明的是体系失效" : "无"}
          bad={board.repeatFindings > 0} />
        <Stat label="D 级中心" v={String(gradeD.length)}
          note={gradeD.length ? gradeD.map(s => s.siteCode).join("、") : "无"}
          bad={gradeD.length > 0} />
      </div>

      {problem && (
        <div className="problem stack" data-testid="audit-problem" style={{ marginBottom: 12 }}>
          <strong>{problem.title}</strong>
          {problem.detail && <div>{problem.detail}</div>}
        </div>
      )}
      {said && <p className="muted" data-testid="audit-said">{said}</p>}

      {/* ── CAPA 有效性 ──────────────────────────────────────────── */}
      <div className="card stack" style={{ marginBottom: 16 }}>
        <div className="spread">
          <h3>CAPA 有效性验证</h3>
          <span className="muted" style={{ fontSize: 13 }}>
            复发 = 当初只做了纠正，没做预防
          </span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>问题类型</th><th className="num">累计</th><th className="num">已关闭</th>
                <th className="num">欠措施</th><th className="num">复发</th><th>判定</th>
              </tr>
            </thead>
            <tbody>
              {board.capa.map(c => (
                <tr key={c.category} data-testid="capa-row">
                  <td>{c.category}</td>
                  <td className="num">{c.total}</td>
                  <td className="num">{c.closed}</td>
                  <td className="num" style={c.owesPlan
                    ? { color: "var(--crit, #c0392b)", fontWeight: 600 } : undefined}>
                    {c.owesPlan}
                  </td>
                  <td className="num" style={c.repeatAfterClose + c.repeatWhileOpen
                    ? { color: "var(--crit, #c0392b)", fontWeight: 600 } : undefined}>
                    {c.repeatAfterClose + c.repeatWhileOpen}
                    {c.repeatWhileOpen > 0 && (
                      <div className="muted" style={{ fontSize: 11 }}
                        data-testid="capa-while-open">整改期内</div>
                    )}
                  </td>
                  <td>
                    <span className={`chip ${VERDICT[c.verdict].chip}`}
                      data-testid="capa-verdict">
                      {VERDICT[c.verdict].text}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {worst.length > 0 && (
          <div className="problem" style={{ margin: 0 }} data-testid="capa-warning">
            <b>{worst.map(c => c.category).join("、")} 在 CAPA 之后又出现了。</b>
            {" "}以「源数据缺陷」为例：CAPA 写的是「集中补签并留痕」——
            <b>那是纠正，不是预防</b>。补完签名，下个月照样缺。
            真正的预防应当是把签名完整性做进 CRC 每周自查清单并留痕，
            或改用带强制签名字段的电子源数据。
            <br />
            <b>只做纠正不做预防的 CAPA，等于把同一个核查风险往后推了一个季度。</b>
            {worst.some(c => c.repeatWhileOpen > 0) && (
              <><br /><b>其中还有整改期内就复发的</b> ——
                那说明现在正在做的事没有用，比「当初做错了」更急。</>
            )}
          </div>
        )}
        {board.owesCapaPlan > 0 && (
          <p className="muted" style={{ margin: 0, fontSize: 13 }} data-testid="capa-owed">
            另有 <b>{board.owesCapaPlan} 条事件只指了责任人、还没提交整改措施</b> ——
            它不是「正在整改」，是有人欠着一份措施。判定里把它从「待观察」拆了出来。
          </p>
        )}
      </div>

      {/* ── 稽查列表 ─────────────────────────────────────────────── */}
      <div className="card stack" style={{ marginBottom: 16 }}>
        <div className="spread">
          <h3>稽查与发现项</h3>
          {canAudit
            ? <button className="btn primary" data-testid="audit-new"
                onClick={() => { setOpening(o => !o); setProblem(null); }}>
                + 发起内部稽查
              </button>
            : <span className="muted" style={{ fontSize: 13 }}
                data-testid="audit-cannot">
                发起与验证关闭都要 <span className="mono">audit</span> 动作权限
              </span>}
        </div>

        {opening && canAudit && (
          <div className="stack" data-testid="audit-form"
            style={{ borderTop: "1px solid var(--line, #e5e5e5)", paddingTop: 10 }}>
            <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
              <label className="field" style={{ minWidth: 260 }}>
                <span>受稽查中心</span>
                <select value={siteId} data-testid="audit-site"
                  onChange={e => setSiteId(e.target.value)}>
                  {sites.map(s => (
                    <option key={s.id} value={s.id}>{s.code} {s.hospital}</option>
                  ))}
                </select>
              </label>
              <label className="field" style={{ minWidth: 200 }}>
                <span>稽查类型</span>
                <select value={kind} data-testid="audit-kind"
                  onChange={e => setKind(e.target.value)}>
                  {Object.entries(KIND).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </label>
            </div>
            <label className="field">
              <span>稽查范围</span>
              <textarea rows={2} value={scope} data-testid="audit-scope"
                placeholder="例：针对该中心质疑挂起超 7 天与源数据签名问题的专项稽查。"
                onChange={e => setScope(e.target.value)} />
            </label>
            <div className="row">
              <button className="btn primary" data-testid="audit-submit"
                disabled={busy || scope.trim().length < 4}
                onClick={() => void openAudit()}>发起</button>
              <span className="muted" style={{ fontSize: 12 }}>
                <b>空范围的稽查等于没查</b> —— 事后说不清当时看了什么。
              </span>
            </div>
          </div>
        )}

        {rows.map(a => (
          <div className="stack" key={a.id} data-testid="audit-row"
            style={{ borderTop: "1px solid var(--line, #e5e5e5)", paddingTop: 10 }}>
            <div className="spread">
              <span className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <span className="mono muted" style={{ fontSize: 12 }}>{a.code}</span>
                <b style={{ fontSize: 13 }}>{KIND[a.kind] ?? a.kind}</b>
                <span className="muted" style={{ fontSize: 12 }}>
                  {a.hospital} · {a.auditedOn} · {a.auditorName}
                </span>
              </span>
              <span className={`chip ${STATE[a.state].chip}`}>{STATE[a.state].text}</span>
            </div>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>{a.scope}</p>

            {a.findings.length === 0
              ? <p className="muted" style={{ margin: 0, fontSize: 12 }}
                  data-testid="audit-no-finding">还没有记录发现项。</p>
              : a.findings.map(f => (
                <div key={f.seq} data-testid="audit-finding"
                  style={{
                    borderLeft: `2px solid var(--${f.state === "closed" ? "flat" : "crit"}, #c0392b)`,
                    paddingLeft: 10
                  }}>
                  <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                    <span className={`chip ${SEV[f.severity]?.chip ?? "flat"}`}>
                      {SEV[f.severity]?.text ?? f.severity}
                    </span>
                    {f.repeatOf && (
                      <span className="chip crit" data-testid="audit-repeat">
                        复发 · 源自 {f.repeatOfCode}
                        {f.repeatAfterClose === false && "（整改期内）"}
                      </span>
                    )}
                    <span className="chip flat">
                      {f.state === "closed" ? "已关闭" : "待整改"}
                    </span>
                  </span>
                  <div style={{ fontSize: 13, marginTop: 4 }}>{f.finding}</div>
                  {f.verification && (
                    <p className="muted" style={{ margin: "4px 0 0", fontSize: 12 }}
                      data-testid="audit-verification">
                      验证：{f.verification}
                    </p>
                  )}
                  {f.state === "open" && canAudit && (
                    <button className="btn" style={{ marginTop: 6 }}
                      data-testid={`audit-close-${a.id}-${f.seq}`}
                      onClick={() => {
                        setClosing({ a, seq: f.seq }); setVerification(""); setProblem(null);
                      }}>
                      验证整改并关闭
                    </button>
                  )}
                </div>
              ))}
          </div>
        ))}
      </div>

      {closing && (
        <div className="card stack" data-testid="audit-close-form" style={{ marginBottom: 16 }}>
          <h3>
            验证 <span className="mono">{closing.a.code}</span> 第 {closing.seq + 1} 条发现
          </h3>
          <label className="field">
            <span>验证说明</span>
            <textarea rows={2} value={verification} data-testid="audit-verification-input"
              placeholder="例：已抽查复核 20 份原始病历，签名与日期齐全，整改证据已归档。"
              onChange={e => setVerification(e.target.value)} />
          </label>
          <div className="derive" style={{ margin: 0 }}>
            <b>「已整改」三个字不是验证。</b>
            核查时看的是<b>你怎么确认它真的改了</b> —— 抽查了多少、结果如何、证据在哪。
            <br />
            全部发现项关闭时这次稽查<b>自动结案</b> ——
            留一个手动的「关闭稽查」按钮，就会出现「发现项全关了但稽查还开着」
            这种只有系统自己知道的状态。
          </div>
          <div className="row">
            <button className="btn primary" data-testid="audit-close-submit"
              disabled={busy || verification.trim().length < 10}
              onClick={() => void closeFinding()}>确认关闭</button>
            <button className="btn" onClick={() => setClosing(null)}>取消</button>
          </div>
        </div>
      )}

      {/* ── 中心质量评级 ─────────────────────────────────────────── */}
      <div className="card stack">
        <div className="spread">
          <h3>中心质量评级</h3>
          <span className="muted" style={{ fontSize: 13 }}>A–D 四级</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>中心</th><th>评级</th><th className="num">扣分</th><th>扣在哪</th></tr>
            </thead>
            <tbody>
              {board.sites.map(s => (
                <tr key={s.studySiteId} data-testid="grade-row">
                  <td>
                    <span className="mono">{s.siteCode}</span>
                    <div className="muted" style={{ fontSize: 12 }}>{s.hospital}</div>
                  </td>
                  <td>
                    <span className={`chip ${GRADE[s.grade]}`}
                      style={{ fontWeight: 700 }} data-testid="grade-letter">
                      {s.grade}
                    </span>
                  </td>
                  <td className="num">{s.penalty}</td>
                  <td style={{ fontSize: 12 }} data-testid="grade-reasons">
                    {s.reasons.join("；")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="derive" style={{ margin: 0 }}>
          质量扣分 = 重大/严重未关闭×3 + 一般未关闭×1 + SAE 超窗×4
          + 质疑挂起超 7 天×2 + <b>CAPA 后复发×4</b>。
          A：0 分｜B：≤3｜C：≤7｜D：&gt;7 ——
          <b>复发权重最高，因为它证明的是体系失效，不是单点失误</b>。
          <br />
          <b>每个中心都评，不只是入组中的那些</b> ——
          一个还没入组、却已经有三条未关闭发现的中心，
          正是最该在启动前处理掉的那一个。
          <span className="muted mono" style={{ marginLeft: 8, fontSize: 12 }}>
            口径 {board.calcVersion}
          </span>
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
