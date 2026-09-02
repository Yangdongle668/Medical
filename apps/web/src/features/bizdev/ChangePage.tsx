import { useEffect, useState } from "react";
import { call, ApiError, type ProblemDetails } from "../../api/client.js";
import { loadMe, type Me } from "../login/me.js";
import { yuan, pct, days } from "../cost/money.js";

/* ════════════════════════════════════════════════════════════════════
   合同变更。

   ── 亏损第一大原因是入组延迟，**第二大就是这个** ──────────────────
   方案改了、活多了，没人提变更单 —— 于是它只表现为
   「毛利莫名其妙地薄了」，而复盘时找不到那笔钱去了哪。

   **就算最终要不到钱，也必须记下来。**
   下次报价时该加进去的成本，正是这些要不到钱的活。

   ── 「每例」那几条是这一页最要命的 ────────────────────────────────
   一条「每例多 1.5 人天」的变更，提出那天只影响十几例，
   一年后是一百四十几例 —— **入组越多，白做的越多**。
   所以受影响例数是**算出来的，不存**：存一个数会把它冻在提出那天，
   而那正好是它看起来最无害的时刻。

   ── null 与 0 差别极大 ────────────────────────────────────────────
   金额缺席 = 还没谈（欠账）；金额是 0 = 谈过了，对方不给钱，我们认了（决策）。
   只有前者进未覆盖工作量。把两者混成一个，
   「已经谈过并接受」的那些会永远留在待办里，而人会开始无视这张表。
   ════════════════════════════════════════════════════════════════════ */

interface Change {
  id: string; code: string;
  study: { id: string; code: string; shortName: string };
  studySiteId: string | null; siteCode: string | null;
  kind: string; kindLabel: string;
  raisedOn: string; raisedByName: string | null; what: string;
  personDaysImpact: number; perSubject: boolean;
  affectedSubjects: number; totalPersonDays: number;
  uncoveredCents?: number;
  settledCents?: number;
  status: "draft" | "submitted" | "signed" | "rejected";
  decidedOn: string | null; note: string | null;
}
interface Creep {
  uncoveredDays: number; uncoveredCents?: number;
  signedAmountCents?: number; signedDays: number;
  openCount: number; signedCount: number;
  coverage: number | null; calcVersion: string;
}

const STATUS: Record<Change["status"], { text: string; chip: string }> = {
  draft: { text: "待提出", chip: "crit" },
  submitted: { text: "已提交", chip: "warn" },
  signed: { text: "已签署", chip: "flat" },
  rejected: { text: "未获批", chip: "crit" }
};
/** 覆盖率低于这条线就该找人谈了。 */
const COVERAGE_OK = 0.6;

export function ChangePage() {
  const [me, setMe] = useState<Me | null>(null);
  const [rows, setRows] = useState<Change[] | null>(null);
  const [creep, setCreep] = useState<Creep | null>(null);
  const [uncoveredOnly, setUncoveredOnly] = useState(false);
  const [settling, setSettling] = useState<Change | null>(null);
  const [next, setNext] = useState<"submitted" | "signed" | "rejected">("submitted");
  const [amountYuan, setAmountYuan] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const reload = () => Promise.all([
    call<{ items: Change[] }>("listContractChanges", { query: { limit: 200 } })
      .then(r => setRows(r.items)),
    call<Creep>("getScopeCreep").then(setCreep)
  ]);

  useEffect(() => { void loadMe().then(setMe); void reload(); }, []);

  if (!me || !rows || !creep) return <p className="muted">加载中…</p>;

  const canWrite = me.permissions.actions.includes("bid");
  const seesMoney = creep.uncoveredCents !== undefined;

  const settle = async () => {
    if (!settling) return;
    setBusy(true); setProblem(null); setSaid(null);
    try {
      const cents = next === "signed"
        ? Math.round(Number(amountYuan || "0") * 100) : undefined;
      const r = await call<{ data: Change; sideEffects: { summary: string }[] }>(
        "settleContractChange", { params: { id: settling.id }, body: {
          status: next, ...(cents !== undefined ? { settledCents: cents } : {})
        } });
      await reload();
      setSettling(null); setAmountYuan("");
      setSaid(r.sideEffects[0]?.summary ?? `${r.data.code} 已转为「${STATUS[next].text}」`);
    } catch (e) {
      if (e instanceof ApiError) setProblem(e.problem); else throw e;
    } finally { setBusy(false); }
  };

  /* 没签的排前面，同样没签的按**白做的人天**排 ——
     不按提出日：一条挂了半年、每例 0.8 人天的变更，
     现在已经吃掉一百多人天，而它在日期排序里沉在最底下。 */
  const shown = rows
    .filter(c => !uncoveredOnly || c.status !== "signed")
    .slice().sort((a, b) =>
      Number(a.status === "signed") - Number(b.status === "signed")
      || Math.abs(b.totalPersonDays) - Math.abs(a.totalPersonDays));
  const open = rows.filter(c => c.status !== "signed");
  const worst = [...open].sort((a, b) => b.totalPersonDays - a.totalPersonDays)[0];
  /* **「每例」那条单独顶出来，不管它是不是最大的那张。**
     它是这一页最要紧的一句话（入组越多白做越多），
     而"碰巧最大"是个随时会变的条件 —— 挂在它上面，
     这句话会在某天悄无声息地从界面上消失。 */
  const worstPerSubject = [...open].filter(c => c.perSubject)
    .sort((a, b) => b.totalPersonDays - a.totalPersonDays)[0];

  return (
    <>
      <div className="page-head">
        <h2>合同变更</h2>
        <p data-testid="change-summary">
          {creep.openCount === 0
            ? "没有未了结的变更单。"
            : <><b>{creep.openCount} 张变更单没有对应金额</b>，
                合计 <b>{days(creep.uncoveredDays)}</b> 人天
                {seesMoney && <>（约 {yuan(creep.uncoveredCents!)}）</>}。</>}
        </p>
      </div>

      <div className="derive" style={{ marginBottom: 14 }}>
        亏损第一大原因是入组延迟，<b>第二大就是 scope creep 没有变更单</b>。
        方案改了、活多了，没人提变更 —— 于是它只表现为「毛利莫名其妙地薄了」，
        而复盘时找不到那笔钱去了哪。
        <br />
        <b>就算最终要不到钱，也必须记下来</b> ——
        下次报价该加进去的成本，正是这些要不到钱的活。
      </div>

      <div className="card stack" data-testid="change-creep" style={{ marginBottom: 18 }}>
        <div className="spread">
          <h3>未覆盖的工作量</h3>
          <span className="muted mono" style={{ fontSize: 12 }}>口径 {creep.calcVersion}</span>
        </div>
        <div className="stats">
          <Stat label="白做的人天" v={days(creep.uncoveredDays)}
            note={`${creep.openCount} 张单子没有金额`}
            bad={creep.uncoveredDays > 0} />
          {seesMoney && (
            <Stat label="折成钱" v={yuan(creep.uncoveredCents!)}
              note="按今天现行的 CRC 人天成本"
              bad={(creep.uncoveredCents ?? 0) > 0} />
          )}
          <Stat label="已签署带回" v={seesMoney ? yuan(creep.signedAmountCents ?? 0) : "—"}
            note={`${creep.signedCount} 张 · ${days(creep.signedDays)} 人天`} />
          <Stat label="覆盖率"
            v={creep.coverage === null ? "—" : pct(creep.coverage)}
            note={creep.coverage === null ? "还没有变更单"
              : creep.coverage < COVERAGE_OK ? "该找申办方谈了" : "大部分活有对应的钱"}
            bad={creep.coverage !== null && creep.coverage < COVERAGE_OK} />
        </div>
        <p className="muted" style={{ margin: 0 }}>
          <b>三种「没有金额」都算</b>：还没提、提了没签、明确不给钱。
          已签署的不算 —— 哪怕金额是 0：那是<b>谈过之后的决定</b>，不是欠账。
        </p>
        {worst && (
          <p className="muted" style={{ margin: 0 }} data-testid="change-worst">
            现在最贵的一张是 <span className="mono">{worst.code}</span>：
            {days(worst.totalPersonDays)} 人天（{worst.kindLabel}）。
          </p>
        )}
        {worstPerSubject && (
          <p className="muted" style={{ margin: 0 }} data-testid="change-growing">
            <span className="mono">{worstPerSubject.code}</span> 是按<b>每例</b>算的：
            每例 {worstPerSubject.personDaysImpact} 人天 ×
            已入组 {worstPerSubject.affectedSubjects} 例 =
            <b> {days(worstPerSubject.totalPersonDays)} 人天</b> ——
            <b>入组越多，白做的越多</b>。它提出那天还只有十几例。
          </p>
        )}
      </div>

      {problem && (
        <div className="problem stack" data-testid="change-problem" style={{ marginBottom: 12 }}>
          <strong>{problem.title}</strong>
          {problem.detail && <div>{problem.detail}</div>}
        </div>
      )}
      {said && <p className="muted" data-testid="change-said">{said}</p>}

      <label className="field" style={{ maxWidth: 280, marginBottom: 12 }}>
        <span>
          <input type="checkbox" checked={uncoveredOnly} data-testid="change-uncovered-only"
            onChange={e => setUncoveredOnly(e.target.checked)} />
          {" "}只看没有金额的
        </span>
      </label>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>编号</th><th>项目 · 中心</th><th>类型</th><th>内容</th>
              <th className="num">人天</th>
              {seesMoney && <th className="num">金额</th>}
              <th>状态</th><th />
            </tr>
          </thead>
          <tbody>
            {shown.map(c => {
              const st = STATUS[c.status];
              return (
                <tr key={c.id} data-testid="change-row">
                  <td className="mono">{c.code}</td>
                  <td>
                    {c.study.shortName}
                    <div className="muted mono" style={{ fontSize: 12 }}>
                      {c.siteCode ?? "全项目"}
                    </div>
                  </td>
                  <td>{c.kindLabel}</td>
                  <td>
                    {c.what}
                    <div className="muted" style={{ fontSize: 12 }}>
                      {c.raisedOn} · {c.raisedByName ?? "—"}
                      {c.note && ` · ${c.note}`}
                    </div>
                  </td>
                  <td className="num">
                    <b>{days(c.totalPersonDays)}</b>
                    {c.perSubject && (
                      <div className="muted" style={{ fontSize: 12 }}
                        data-testid="change-per-subject">
                        每例 {c.personDaysImpact} × {c.affectedSubjects} 例
                      </div>
                    )}
                  </td>
                  {seesMoney && (
                    <td className="num">
                      {c.settledCents !== undefined
                        ? yuan(c.settledCents)
                        : <span className="muted" data-testid="change-no-amount">
                            还没谈
                          </span>}
                      {c.uncoveredCents !== undefined && (
                        <div className="muted" style={{ fontSize: 12 }}>
                          白做 {yuan(c.uncoveredCents)}
                        </div>
                      )}
                    </td>
                  )}
                  <td><span className={`chip ${st.chip}`}>{st.text}</span></td>
                  <td>
                    {["draft", "submitted"].includes(c.status) && canWrite
                      ? <button className="btn" data-testid={`change-settle-${c.id}`}
                          onClick={() => {
                            setSettling(c);
                            setNext(c.status === "draft" ? "submitted" : "signed");
                            setAmountYuan(""); setProblem(null);
                          }}>推进</button>
                      : <span className="muted mono">{c.decidedOn ?? ""}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {settling && (
        <div className="card stack" data-testid="change-form" style={{ marginTop: 16 }}>
          <h3>推进 <span className="mono">{settling.code}</span> · {settling.kindLabel}</h3>
          <label className="field" style={{ maxWidth: 220 }}>
            <span>转为</span>
            <select value={next} data-testid="change-next"
              onChange={e => setNext(e.target.value as typeof next)}>
              {settling.status === "draft" && <option value="submitted">已提交</option>}
              <option value="signed">已签署</option>
              <option value="rejected">未获批</option>
            </select>
          </label>

          {next === "signed" && (
            <>
              <label className="field" style={{ maxWidth: 320 }}>
                <span>谈下来的金额（元，可以是 0）</span>
                <input type="number" value={amountYuan} data-testid="change-amount"
                  onChange={e => setAmountYuan(e.target.value)} />
              </label>
              <div className="derive" style={{ margin: 0 }}>
                <b>填 0 和不填是两件事。</b>
                0 表示「谈过了，对方不给钱，我们认了」——
                它<b>从未覆盖工作量里出去</b>，因为那是一个决定。
                不填表示「还没谈」，那才是欠账。
              </div>
            </>
          )}
          {next === "rejected" && (
            <div className="problem" style={{ margin: 0 }} data-testid="change-reject-note">
              未获批的变更<b>仍然算白做</b>：
              这张单子的 {days(settling.totalPersonDays)} 人天不会消失，
              只是没有对应的钱。
              <b>它会留在未覆盖工作量里</b> —— 下次报价时该加进去的正是它。
            </div>
          )}

          <div className="row">
            <button className="btn primary" data-testid="change-submit"
              disabled={busy || (next === "signed" && amountYuan.trim() === "")}
              onClick={() => void settle()}>
              {busy ? "…" : "确认"}
            </button>
            <button className="btn" onClick={() => setSettling(null)}>取消</button>
          </div>
        </div>
      )}

      <div className="derive" style={{ marginTop: 14 }}>
        「每例」的那几条，受影响例数是<b>算出来的，不存</b> ——
        一条「每例多 1.5 人天」的变更，提出那天只影响十几例，一年后是一百多例。
        存一个数会把它冻在提出那天，<b>而那正好是它看起来最无害的时刻</b>。
        <br />
        表按<b>白做的人天</b>排，不按提出日：一条挂了半年的每例变更，
        在日期排序里会沉在最底下，而它现在是最贵的那张。
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
