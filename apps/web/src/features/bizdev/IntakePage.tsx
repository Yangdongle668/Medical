import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { call, ApiError, type ProblemDetails } from "../../api/client.js";
import { loadMe, type Me } from "../login/me.js";
import { yuan, pct } from "../cost/money.js";
import { NewIntakeForm } from "./NewIntakeForm.js";

/* ════════════════════════════════════════════════════════════════════
   立项与建档。

   ── 此前系统的第一行数据是凭空出现的 ──────────────────────────────
   项目和中心一直是种子直接灌进去的。真实系统里，一个项目要先有人
   **提出来**、有人**算过账**、有人**批准**，然后才有档案。

   ── 在立项时就算账，不等做完才知道亏 ──────────────────────────────
   一个项目做完之后算出毛利 8%，那是历史；立项时算出 8%，那是决定。
   两者用的是同一条算式，差别只在**什么时候算**。

   ── 保本合同额比毛利率更能推动谈判 ────────────────────────────────
   「毛利率 20.5%，低于 25% 门槛」这句话，谈判桌上用不上。
   「按这个成本，合同额至少要 805 万」—— 对方能拿它回去算。

   ── 「已建档」小于「合同中心数」= 早期成本失控最常见的一种 ─────────
   那几个中心的成本已经在发生（伦理递交、合同谈判、可行性访视），
   收入却还挂不上号。在此之前系统里连「合同写了几个中心」这个数都没有。
   ════════════════════════════════════════════════════════════════════ */

interface Intake {
  id: string; code: string; drug: string; sponsorName: string;
  phase: string; indication: string;
  plannedSites: number; plannedSubjects: number; enrollMonths: number;
  contractCents?: number; estimatedCostCents?: number;
  grossCents?: number; grossMargin?: number;
  belowGate: boolean;
  perSubjectCents?: number; breakEvenContractCents?: number;
  subjectsPerSite: number | null;
  note: string | null;
  submittedBy: string; submittedByName: string; submittedOn: string;
  state: "submitted" | "approved" | "returned";
  decidedByName: string | null; decidedOn: string | null; decisionNote: string | null;
  studyId: string | null; studyCode: string | null;
}
interface Filing {
  studyId: string; studyCode: string; shortName: string; clientName: string;
  phase: string; plannedSubjects: number;
  plannedSites: number; builtSites: number; missingSites: number;
  filedRatio: number | null; contractCents?: number;
}
interface Board {
  open: number; belowGate: number; openContractCents?: number;
  gmGate: number; studies: Filing[]; missingSites: number; calcVersion: string;
}

const STATE: Record<Intake["state"], { text: string; chip: string }> = {
  submitted: { text: "待审批", chip: "warn" },
  approved: { text: "已批准", chip: "flat" },
  returned: { text: "已退回", chip: "crit" }
};

export function IntakePage() {
  const [me, setMe] = useState<Me | null>(null);
  const [rows, setRows] = useState<Intake[] | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [deciding, setDeciding] = useState<{ x: Intake; ok: boolean } | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const reload = () => Promise.all([
    call<{ items: Intake[] }>("listIntakeApplications", { query: { limit: 100 } })
      .then(r => setRows(r.items)),
    call<Board>("getIntakeBoard", {}).then(setBoard)
  ]);

  useEffect(() => { void loadMe().then(setMe); void reload(); }, []);

  if (!me || !rows || !board) return <p className="muted">加载中…</p>;

  const canDecide = me.permissions.actions.includes("approve");
  /* 提交立项要 `bid`，批准要 `approve` —— **两个动作两个人**。
     同一个人两样都有时他仍然批不了自己的申请（服务端那条规矩）。 */
  const canSubmit = me.permissions.actions.includes("bid");
  const seesPrice = board.openContractCents !== undefined;
  const open = rows.filter(x => x.state === "submitted");

  const decide = async () => {
    if (!deciding) return;
    setBusy(true); setProblem(null); setSaid(null);
    try {
      const r = await call<{ sideEffects: { summary: string }[] }>(
        "decideIntakeApplication", {
          params: { id: deciding.x.id },
          body: {
            result: deciding.ok ? "approved" : "returned",
            ...(reason.trim() ? { reason: reason.trim() } : {})
          }
        });
      await reload();
      setDeciding(null); setReason("");
      setSaid(r.sideEffects[0]?.summary ?? `${deciding.x.code} 已处理`);
    } catch (e) {
      if (e instanceof ApiError) setProblem(e.problem); else throw e;
    } finally { setBusy(false); }
  };

  return (
    <>
      <div className="page-head">
        <h2>立项与建档</h2>
        <p data-testid="intake-summary">
          {board.open} 个待审批
          {seesPrice && <>（合计 {yuan(board.openContractCents!)}）</>}
          {board.belowGate > 0 && <>，<b>{board.belowGate} 个低于毛利门槛</b></>}。
          {board.missingSites > 0 && <> 另有 <b>{board.missingSites} 个中心合同里写了、
            系统里还没建档</b>。</>}
        </p>
      </div>

      <div className="derive" style={{ marginBottom: 14 }}>
        <b>在立项时就算账，不等做完才知道亏。</b>
        一个项目做完之后算出毛利 8%，那是历史；立项时算出 8%，那是决定 ——
        两者用的是同一条算式，差别只在<b>什么时候算</b>。
        低于 {pct(board.gmGate)} 的必须过经营层那一关。
      </div>

      <div className="stats" style={{ marginBottom: 16 }}>
        <Stat label="待审批立项" v={String(board.open)}
          note={seesPrice ? `合计 ${yuan(board.openContractCents!)}` : "等经营层拍板"}
          bad={board.open > 0} />
        <Stat label="低于毛利门槛" v={String(board.belowGate)}
          note={board.belowGate ? "必须过经营层" : "无"} bad={board.belowGate > 0} />
        <Stat label="毛利门槛" v={pct(board.gmGate)} note="口径，不是表结构" />
        <Stat label="待建档中心" v={String(board.missingSites)}
          note={board.missingSites ? "成本已经在发生了" : "都建齐了"}
          bad={board.missingSites > 0} />
      </div>

      {problem && (
        <div className="problem stack" data-testid="intake-problem" style={{ marginBottom: 12 }}>
          <strong>{problem.title}</strong>
          {problem.detail && <div>{problem.detail}</div>}
        </div>
      )}
      {said && <p className="muted" data-testid="intake-said">{said}</p>}

      {/* 提交入口。此前这一页只能批准与退回 —— 于是「立项」这条流程
          只处理得了 seed 里已经躺着的那几份申请。 */}
      {canSubmit && (
        <NewIntakeForm gmGate={board.gmGate} seesPrice={seesPrice} onCreated={() => void reload()} />
      )}

      {/* ── 申请 ─────────────────────────────────────────────────── */}
      <div className="stack" style={{ marginBottom: 16 }}>
        {rows.length === 0 && (
          <p className="muted" data-testid="intake-empty">没有立项申请。</p>
        )}
        {rows.map(x => (
          <div className="card stack" key={x.id} data-testid="intake-row"
            style={x.belowGate && x.state === "submitted"
              ? { borderColor: "var(--crit, #c0392b)" } : undefined}>
            <div className="spread">
              <span className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <span className="mono muted" style={{ fontSize: 12 }}>{x.code}</span>
                <b style={{ fontSize: 14 }}>{x.drug}</b>
                <span className="chip flat">{x.phase}</span>
              </span>
              <span className="row" style={{ gap: 6 }}>
                {x.grossMargin !== undefined && (
                  <span className={x.belowGate ? "chip crit" : "chip flat"}
                    data-testid="intake-gm">
                    测算毛利率 {pct(x.grossMargin)}{x.belowGate && " · 低于门槛"}
                  </span>
                )}
                <span className={`chip ${STATE[x.state].chip}`}>{STATE[x.state].text}</span>
              </span>
            </div>

            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              {x.sponsorName} · {x.indication}｜{x.plannedSites} 中心 ×{" "}
              {x.subjectsPerSite !== null ? Math.round(x.subjectsPerSite) : "—"} 例 ={" "}
              {x.plannedSubjects} 例｜入组期 {x.enrollMonths} 个月｜
              提交人 {x.submittedByName} · {x.submittedOn}
            </p>

            {x.contractCents !== undefined && (
              <div className="row" style={{ gap: 20, flexWrap: "wrap" }}>
                <span>合同总额 <b>{yuan(x.contractCents)}</b></span>
                {x.estimatedCostCents !== undefined &&
                  <span className="muted">预估成本 {yuan(x.estimatedCostCents)}</span>}
                {x.grossCents !== undefined && (
                  <span>预估毛利 <b style={x.belowGate
                    ? { color: "var(--crit, #c0392b)" } : undefined}>
                    {yuan(x.grossCents)}</b></span>
                )}
                {x.perSubjectCents !== undefined &&
                  <span className="muted">单例 {yuan(x.perSubjectCents)}</span>}
                {x.breakEvenContractCents !== undefined && (
                  <span data-testid="intake-breakeven">
                    保本合同额 <b>{yuan(x.breakEvenContractCents)}</b>
                  </span>
                )}
              </div>
            )}

            {x.belowGate && x.state === "submitted" && x.breakEvenContractCents !== undefined && (
              <p className="problem" style={{ margin: 0, fontSize: 13 }}
                data-testid="intake-gate-note">
                <b>低于 {pct(board.gmGate)} 门槛。</b>
                谈判桌上用得上的不是这个百分比，是<b>保本合同额</b> ——
                按当前测算成本，合同额至少要 {yuan(x.breakEvenContractCents)} 才够门槛，
                对方能拿这个数回去算。
              </p>
            )}

            {x.note && (
              <p className="muted" style={{ margin: 0, fontSize: 13 }} data-testid="intake-note">
                <b>提交说明</b>：{x.note}
              </p>
            )}

            {x.state === "submitted"
              ? canDecide && (
                <div className="row" style={{ flexWrap: "wrap" }}>
                  <button className="btn primary" data-testid={`intake-ok-${x.id}`}
                    onClick={() => { setDeciding({ x, ok: true }); setReason(""); setProblem(null); }}>
                    批准立项
                  </button>
                  <button className="btn" data-testid={`intake-no-${x.id}`}
                    onClick={() => { setDeciding({ x, ok: false }); setReason(""); setProblem(null); }}>
                    退回重谈
                  </button>
                  <span className="muted" style={{ fontSize: 12 }}>
                    批准会<b>在同一个事务里建出项目档案</b> ——
                    不存在「批准了但档案没建」这一格。
                  </span>
                </div>
              )
              : <p className="muted" style={{ margin: 0, fontSize: 13 }}
                  data-testid="intake-decided">
                  {x.decidedByName} 于 {x.decidedOn}
                  {x.state === "approved"
                    ? <> 批准，方案编号 <span className="mono">{x.studyCode}</span></>
                    : <> 退回：{x.decisionNote}</>}
                </p>}
          </div>
        ))}
      </div>

      {deciding && (
        <div className="card stack" data-testid="intake-form" style={{ marginBottom: 16 }}>
          <h3>
            {deciding.ok ? "批准" : "退回"}{" "}
            <span className="mono">{deciding.x.code}</span> · {deciding.x.drug}
          </h3>
          <label className="field">
            <span>{deciding.ok ? "批准说明（可选）" : "退回理由"}</span>
            <textarea rows={2} value={reason} data-testid="intake-reason"
              placeholder={deciding.ok
                ? "例：老客户续单，启动成本可复用，同意按此价接。"
                : "例：毛利率低于门槛，需重谈价格或压缩 CRC 驻场 FTE。"}
              onChange={e => setReason(e.target.value)} />
          </label>
          <div className="derive" style={{ margin: 0 }}>
            {deciding.ok
              ? <><b>批准会同时建出项目档案</b>（必要时连客户档案一起建）——
                  库上「已批准」与「有项目档案」互为充要条件，
                  所以不存在「批准了但档案没建」这一格：
                  那是这条流程最容易漏的一格，批的人以为建了，
                  做的人以为批完会自动建。</>
              : <><b>退回必须写理由。</b>
                  不说为什么，提交人只能猜 ——
                  而猜错的代价是拿着同一份价格再谈一轮。</>}
            <br />
            <b>提交人不能批准自己的申请</b> —— 与工时审批同一条规矩。
          </div>
          <div className="row">
            <button className="btn primary" data-testid="intake-submit"
              disabled={busy || (!deciding.ok && reason.trim().length < 4)}
              onClick={() => void decide()}>{busy ? "…" : "确认"}</button>
            <button className="btn" onClick={() => setDeciding(null)}>取消</button>
          </div>
        </div>
      )}

      {/* ── 已立项项目与建档滞后 ─────────────────────────────────── */}
      <div className="card stack">
        <div className="spread">
          <h3>已立项项目</h3>
          <span className="muted" style={{ fontSize: 13 }}>
            「已建档」小于「合同中心数」就是滞后
          </span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>方案编号</th><th>项目 · 客户</th><th>期别</th>
                <th className="num">计划例数</th><th className="num">合同中心</th>
                <th className="num">已建档</th>
                {seesPrice && <th className="num">合同额</th>}
              </tr>
            </thead>
            <tbody>
              {board.studies.map(s => (
                <tr key={s.studyId} data-testid="filing-row"
                  style={s.missingSites > 0
                    ? { background: "rgba(192,57,43,.06)" } : undefined}>
                  <td className="mono">{s.studyCode}</td>
                  <td>
                    {s.shortName}
                    <div className="muted" style={{ fontSize: 12 }}>{s.clientName}</div>
                  </td>
                  <td><span className="chip flat">{s.phase}</span></td>
                  <td className="num">{s.plannedSubjects}</td>
                  <td className="num">{s.plannedSites}</td>
                  <td className="num" data-testid="filing-built">
                    <span style={s.missingSites > 0
                      ? { color: "var(--crit, #c0392b)", fontWeight: 600 } : undefined}>
                      {s.builtSites}
                    </span>
                    {s.missingSites > 0 && (
                      <div className="chip crit" style={{ fontSize: 11, marginTop: 2 }}
                        data-testid="filing-gap">差 {s.missingSites} 个</div>
                    )}
                  </td>
                  {seesPrice && <td className="num">{yuan(s.contractCents ?? 0)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="derive" style={{ margin: 0 }} data-testid="filing-note">
          <b>「已建档」小于「合同中心数」= 合同里写了但还没进系统的中心。</b>
          这些中心的<b>成本已经在发生</b>（伦理递交、合同谈判、可行性访视），
          收入却还挂不上号 —— 建档滞后是早期成本失控最常见的一种。
          在此之前系统里连「合同写了几个中心」这个数都没有。
          <br />
          去 <Link to="/sites">项目 · 中心台账</Link> 建档，
          或去 <Link to="/price">报价模型</Link> 复核测算成本 ——
          <b>立项上那个成本是手填的</b>，报价模型能把它算出来。
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
