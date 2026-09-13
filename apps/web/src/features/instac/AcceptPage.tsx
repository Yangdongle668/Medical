import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { call, ApiError, type ProblemDetails } from "../../api/client.js";
import { loadMe, type Me } from "../login/me.js";
import { SubmitAcceptanceForm } from "./SubmitAcceptanceForm.js";
import { RecordLetterForm } from "./RecordLetterForm.js";

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
  letter: { filename: string; sizeBytes: number;
            uploadedAt: string; uploadedByName: string } | null;
}

/** 文件大小说给人听。KB / MB 的分界取 1 MB —— 一份扫描件通常在几百 KB，
 *  报成「0.3 MB」不如报「320 KB」好认。 */
const kb = (n: number) => n < 1048576
  ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;

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
  /** 正在登记意向函的那一条 —— **一次只开一个**：同时摊开几张表，
   *  "我刚才改的是哪一条"就答不出来了。 */
  const [letterFor, setLetterFor] = useState<Acceptance | null>(null);

  const reload = () =>
    call<{ items: Acceptance[] }>("listSiteAcceptances", { query: { limit: 100 } })
      .then(r => setRows(r.items));

  useEffect(() => { void loadMe().then(setMe); void reload(); }, []);

  if (!me || !rows) return <p className="muted">加载中…</p>;

  const canAccept = me.permissions.actions.includes("accept");
  /* 递交要 `advance`（受托方那一侧），受理要 `accept`（机构那一侧）——
     **两端两个动作**，一个人同时有两样是管理员的情形，不是常态。 */
  const canSubmit = me.permissions.actions.includes("advance");
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

      {/* 递交入口。此前只有受理这一端 —— 于是待受理的记录只能来自 seed，
          新建档的中心递不进来，而 irb_submit 那道闸门就成了一堵墙。 */}
      {canSubmit && <SubmitAcceptanceForm onCreated={() => void reload()} />}

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
              {/* 医院名此前不在行上 —— 机构办自己看是「本院」不必说，
                  但受托方与管理员这一页上摆着好几家医院递的材料，
                  少了这一栏就分不清哪条是哪家的。 */}
              <b>{a.hospital}</b>｜{a.sponsorName}｜
              方案 <span className="mono">{a.studyCode}</span>｜
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
              a.docs.length === 0 ? (
                /* **空清单不是「齐备」。** 材料清单从必填改成了可省略
                   （迁移 0048），于是 in_system 上也会出现空清单 ——
                   而 0/0 在界面上长得像"全齐了"。照实说：没列。 */
                <p className="muted" style={{ margin: 0, fontSize: 13 }}
                  data-testid="ac-no-docs">
                  <b>没有列材料清单。</b>递交方没在系统里逐项列 ——
                  这不是「八项都齐」，是这条受理不走本系统的形式审查。
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
            ))}

            {a.state === "amend" && a.amendNote && (
              <p className="problem" style={{ margin: 0, fontSize: 13 }}
                data-testid="ac-amend-note">
                <b>补正通知</b>：{a.amendNote}
              </p>
            )}

            {/* ── 受理意向函 ────────────────────────────────────────────
                日期与那张纸分开两栏，是有意的：日期是一线报上来的事实，
                纸是核查要看的凭证，**先有日期后有纸**是常态。
                所以已受理但没传纸的那些要显眼 —— 那是一件没做完的事。 */}
            {a.letter ? (
              <p className="muted" style={{ margin: 0, fontSize: 13 }} data-testid="ac-letter">
                受理意向函：
                <a href={`/v1/site-acceptances/${a.id}/letter`}
                  target="_blank" rel="noreferrer" data-testid={`ac-letter-open-${a.id}`}>
                  {a.letter.filename}
                </a>
                <span className="t-mut">
                  （{kb(a.letter.sizeBytes)}，{a.letter.uploadedByName} 上传）
                </span>
              </p>
            ) : a.state === "accepted" && a.origin !== "registered" && (
              <p className="problem" style={{ margin: 0, fontSize: 13 }}
                data-testid="ac-letter-missing">
                <b>已受理，但受理意向函还没传。</b>
                核查要看的是那张纸，不是台账上的一个日期 —— 拿到之后回来补一次。
              </p>
            )}

            {a.state === "accepted" ? (
              <>
                <p className="muted" style={{ margin: 0, fontSize: 13 }} data-testid="ac-done">
                  {a.acceptedOn} 受理
                  {a.acceptedByName
                    ? <>，受理人 {a.acceptedByName}</>
                    : <>（受理人不在本系统 —— 医院那边是谁受理的由意向函回答）</>}。
                  {a.studySiteId
                    ? <> 该中心现在可以推进到「伦理递交」。</>
                    : <> <b>受理了但没建档</b> —— 那几个中心的成本已经在发生。</>}
                </p>
                {/* 已受理之后仍然改得动：日期登记错了、纸后来才拿到，
                    都是常事。registered 那种存根除外（它记的是几年前的事）。 */}
                {canSubmit && a.origin !== "registered" && (
                  <div className="row">
                    <button className="btn" data-testid={`ac-letter-edit-${a.id}`}
                      onClick={() => setLetterFor(a)}>
                      {a.letter ? "换一份意向函 / 改日期" : "补传受理意向函"}
                    </button>
                  </div>
                )}
              </>
            ) : canSubmit && a.origin !== "registered" ? (
              /* **一线的那条路。** 它和下面「予以受理」是两条：
                 那一条是机构办在本系统里点的（要先逐项勾清单），
                 这一条是一线把手里那张纸登记进来。
                 多数医院的机构办不在这个系统里，所以这一条才是常走的。 */
              <div className="row" style={{ flexWrap: "wrap" }}>
                <button className="btn btn-p" data-testid={`ac-record-${a.id}`}
                  onClick={() => setLetterFor(a)}>
                  登记受理意向函
                </button>
                <span className="note">
                  拿到医院给的受理意向函之后点这里：填上收到日期，传那份 PDF。
                  {canAccept && <> 机构办在本系统里逐项审的，走右边那条。</>}
                </span>
              </div>
            ) : null}

            {letterFor?.id === a.id && (
              <RecordLetterForm acceptance={a}
                onCancel={() => setLetterFor(null)}
                onDone={() => { setLetterFor(null); void reload(); }} />
            )}

            {a.state !== "accepted" && canAccept && (
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
