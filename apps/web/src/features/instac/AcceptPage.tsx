import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { call, ApiError, type ProblemDetails } from "../../api/client.js";
import { loadMe, type Me } from "../login/me.js";

/* ════════════════════════════════════════════════════════════════════
   立项受理（机构办）。

   ── 形式审查只看材料齐不齐，不评价科学性 ──────────────────────────
   科学性是伦理委员会与专业组的事。但形式审查**是一道真闸门**：
   材料不齐就受理，后面每一个环节都带着这个缺口往下走 ——
   递到伦理的那一份，正是机构受理时点过的那一份。
   所以未受理的中心推不到「伦理递交」（中心状态机的闸门）。

   ── 每一项单独勾，缺件说的是名字 ──────────────────────────────────
   一个「材料齐备 6/8」的进度条说不出缺的是哪两份，
   而补正通知要写的正是那两份的名字。只说「材料不齐」，
   递交方只能把八份重寄一遍 —— 重寄之后缺的还是那两份。

   ── 齐备 ≠ 已受理 ────────────────────────────────────────────────
   齐备是清单算出来的，受理是机构的一次决定。合成一个状态，
   「谁受理的、哪天受理的」就没有答案了。

   ── 空清单有两种意思 ──────────────────────────────────────────────
   本系统办的受理，空清单是「八项都齐」；
   系统外登记的存根，空清单是「没人在这儿查过」。
   混起来，这一页就会对着一条谁也没审过的记录报「材料齐备」。
   ════════════════════════════════════════════════════════════════════ */

interface Doc { seq: number; name: string; present: boolean }
interface Acceptance {
  id: string; code: string;
  studyId: string; studyCode: string; drug: string; sponsorName: string; phase: string;
  hospital: string; studySiteId: string | null; siteCode: string | null;
  submittedByName: string; submittedOn: string;
  state: "review" | "amend" | "accepted";
  origin: "in_system" | "registered";
  amendNote: string | null;
  acceptedOn: string | null; acceptedByName: string | null;
  docs: Doc[]; presentDocs: number; missingDocs: string[];
}

const STATE: Record<Acceptance["state"], { text: string; chip: string }> = {
  review: { text: "形式审查中", chip: "warn" },
  amend: { text: "待补正", chip: "crit" },
  accepted: { text: "已受理", chip: "flat" }
};

export function AcceptPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [rows, setRows] = useState<Acceptance[] | null>(null);
  const [amending, setAmending] = useState<Acceptance | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const reload = () =>
    call<{ items: Acceptance[] }>("listSiteAcceptances", { query: { limit: 100 } })
      .then(r => setRows(r.items));

  useEffect(() => { void loadMe().then(setMe); void reload(); }, []);

  if (!me || !rows) return <p className="muted">加载中…</p>;

  const canAccept = me.permissions.actions.includes("accept");
  const open = rows.filter(a => a.state !== "accepted");
  const missing = open.filter(a => a.missingDocs.length > 0);
  /* 「受理了但中心还没进台账」—— 建档滞后在医院这一侧的样子。 */
  const unfiled = rows.filter(a => a.state === "accepted" && a.studySiteId === null);

  const run = async (op: string, a: Acceptance, body: object, params?: object) => {
    setBusy(true); setProblem(null); setSaid(null);
    try {
      const r = await call<{ sideEffects: { summary: string }[] }>(
        op, { params: { id: a.id, ...params }, body });
      await reload();
      setAmending(null); setReason("");
      setSaid(r.sideEffects[0]?.summary ?? `${a.code} 已处理`);
    } catch (e) {
      if (e instanceof ApiError) setProblem(e.problem); else throw e;
    } finally { setBusy(false); }
  };

  return (
    <>
      <div className="page-head">
        <h2>立项受理</h2>
        <p data-testid="ac-summary">
          {open.length} 件在办
          {missing.length > 0 && <>，其中 <b>{missing.length} 件材料不齐</b></>}。
          {unfiled.length > 0 && <> 另有 <b>{unfiled.length} 件已受理但中心还没进台账</b>。</>}
        </p>
      </div>

      <div className="derive" style={{ marginBottom: 14 }}>
        <b>形式审查只看材料是否齐备与合规，不评价科学性</b> ——
        那是伦理委员会与专业组的事。但它是一道真闸门：
        <b>材料不齐就受理，后面每一个环节都会带着这个缺口往下走</b> ——
        递到伦理的那一份，正是这里点过的那一份。
        所以未受理的中心<b>推不到「伦理递交」</b>。
      </div>

      {problem && (
        <div className="problem stack" data-testid="ac-problem" style={{ marginBottom: 12 }}>
          <strong>{problem.title}</strong>
          {problem.detail && <div>{problem.detail}</div>}
        </div>
      )}
      {said && <p className="muted" data-testid="ac-said">{said}</p>}

      <div className="stack">
        {rows.length === 0 && (
          <p className="muted" data-testid="ac-empty">没有递到本院的立项申请。</p>
        )}
        {rows.map(a => (
          <div className="card stack" key={a.id} data-testid="ac-row"
            style={a.missingDocs.length > 0 && a.state !== "accepted"
              ? { borderColor: "var(--crit, #c0392b)" } : undefined}>
            <div className="spread">
              <span className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <span className="mono muted" style={{ fontSize: 12 }}>{a.code}</span>
                <b style={{ fontSize: 14 }}>{a.drug}</b>
                <span className="chip flat">{a.phase}</span>
              </span>
              <span className="row" style={{ gap: 6 }}>
                {a.origin === "registered" && (
                  <span className="chip flat" data-testid="ac-registered">系统外受理登记</span>
                )}
                <span className={`chip ${STATE[a.state].chip}`}>{STATE[a.state].text}</span>
              </span>
            </div>

            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              {a.sponsorName}｜方案 <span className="mono">{a.studyCode}</span>｜
              递交人 {a.submittedByName} · {a.submittedOn}｜
              {a.siteCode
                ? <>中心 <span className="mono">{a.siteCode}</span></>
                : <b data-testid="ac-unfiled">该中心还没进受托方台账</b>}
            </p>

            {a.origin === "registered" ? (
              /* 存根不是待办。**空清单在这里是「没人在这儿查过」** ——
                 当成「八项都齐」会让这一页替一件没做过的形式审查背书。 */
              <p className="derive" style={{ margin: 0, fontSize: 13 }}
                data-testid="ac-stub-note">
                <b>这是一条系统外受理的登记存根。</b>
                受理发生在 {a.acceptedOn}，那时候本系统还没有这条流程 ——
                所以它<b>没有受理人，也没有材料清单</b>：
                受理人是医院里某位不在本系统的老师，填谁都是编的；
                而这里的空清单要读成<b>「没人在这儿查过」</b>，
                不是「八项都齐」。它只作数，不能在这里改。
              </p>
            ) : (
              <>
                <div className="spread">
                  <b style={{ fontSize: 13 }}>
                    形式审查清单 {a.presentDocs}/{a.docs.length}
                  </b>
                  {a.missingDocs.length > 0 && (
                    <span className="chip crit" data-testid="ac-missing">
                      缺 {a.missingDocs.length} 项：{a.missingDocs.join("、")}
                    </span>
                  )}
                </div>
                <div className="stack" style={{ gap: 4 }}>
                  {a.docs.map(d => (
                    <label className="row" key={d.seq} style={{ gap: 8, fontSize: 13 }}>
                      <input type="checkbox" checked={d.present}
                        data-testid={`ac-doc-${a.id}-${d.seq}`}
                        disabled={!canAccept || a.state === "accepted" || busy}
                        onChange={e => void run("setAcceptanceDoc", a,
                          { present: e.target.checked }, { seq: d.seq })} />
                      <span style={d.present ? undefined
                        : { color: "var(--crit, #c0392b)" }}>{d.name}</span>
                    </label>
                  ))}
                </div>
              </>
            )}

            {a.state === "amend" && a.amendNote && (
              <p className="problem" style={{ margin: 0, fontSize: 13 }}
                data-testid="ac-amend-note">
                <b>补正通知</b>：{a.amendNote}
              </p>
            )}

            {a.state === "accepted" ? (
              <p className="muted" style={{ margin: 0, fontSize: 13 }} data-testid="ac-done">
                {a.acceptedOn} 受理
                {a.acceptedByName ? <>，受理人 {a.acceptedByName}</> : <>（系统外受理，仅登记受理号）</>}。
                {a.studySiteId
                  ? <> 该中心现在可以推进到「伦理递交」。</>
                  : <> <b>受理了但没建档</b> —— 那几个中心的成本已经在发生。</>}
              </p>
            ) : canAccept && (
              <div className="row" style={{ flexWrap: "wrap" }}>
                <button className="btn primary" data-testid={`ac-accept-${a.id}`}
                  disabled={busy}
                  onClick={() => void run("acceptSite", a, {})}>
                  予以受理
                </button>
                <button className="btn" data-testid={`ac-amend-${a.id}`}
                  disabled={busy}
                  onClick={() => {
                    setAmending(a);
                    setReason(a.missingDocs.length
                      ? `请补齐：${a.missingDocs.join("、")}` : "");
                    setProblem(null);
                  }}>
                  发出补正通知
                </button>
                {a.missingDocs.length > 0 && (
                  <span className="muted" style={{ fontSize: 12 }}>
                    材料不齐时点「予以受理」会被拦下，并列出缺的那几份的名字。
                  </span>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {amending && (
        <div className="card stack" data-testid="ac-form" style={{ marginTop: 16 }}>
          <h3>
            补正通知 · <span className="mono">{amending.code}</span> · {amending.drug}
          </h3>
          <label className="field">
            <span>缺什么，写清楚</span>
            <textarea rows={2} value={reason} data-testid="ac-reason"
              placeholder="例：请补齐组长单位伦理批件与保险单，保险单需覆盖至末例末访后 12 个月。"
              onChange={e => setReason(e.target.value)} />
          </label>
          <div className="derive" style={{ margin: 0 }}>
            <b>补正通知要说清缺什么。</b>
            只说「材料不齐」，递交方只能把八份重寄一遍 ——
            而重寄一遍之后，缺的还是那两份。
          </div>
          <div className="row">
            <button className="btn primary" data-testid="ac-submit"
              disabled={busy || reason.trim().length < 4}
              onClick={() => void run("requestAcceptanceAmend", amending,
                { reason: reason.trim() })}>{busy ? "…" : "发出"}</button>
            <button className="btn" onClick={() => setAmending(null)}>取消</button>
          </div>
        </div>
      )}

      <div className="derive" style={{ marginTop: 16 }} data-testid="ac-note">
        <b>齐备 ≠ 已受理。</b>
        齐备是清单算出来的，受理是机构的一次决定 ——
        合成一个状态，「谁受理的、哪天受理的」就没有答案了。
        <br />
        受理之后本院对这个项目的质量与合规负最终责任，
        接着走 <Link to="/inst/registry">人员备案与准入</Link> 与{" "}
        <Link to="/inst/qc">机构质控</Link>。
      </div>
    </>
  );
}
