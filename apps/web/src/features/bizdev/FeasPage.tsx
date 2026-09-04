import { useEffect, useState } from "react";
import { call, ApiError, type ProblemDetails } from "../../api/client.js";
import { loadMe, type Me } from "../login/me.js";
import { NewFeasibilityForm } from "./NewFeasibilityForm.js";

/* ════════════════════════════════════════════════════════════════════
   中心可行性调查。

   ── 它和报价模型问的不是一个问题 ──────────────────────────────────
   报价模型算「这个项目要花多少人天」，这一页算「**这家能不能出病人**」。
   两者都在签合同之前，但错的时候错法完全不同：
   报价报错，毛利薄一点；选址选错，那个中心一年入组 0 例，
   而合同上的例数一个不少，只能靠别的中心加班补。

   **事后把亏损中心标红是最便宜也最没用的功能** —— 那时钱已经花完了。

   ── 逐项拆解必须画出来，不能只画总分 ──────────────────────────────
   这套分数会被用来拒绝一家医院。被拒的一方（以及内部坚持要选它的人）
   一定会问"凭什么"。一个 38 分的圆圈答不了这个问题；
   「病源 3.6 / 30、既往 0 / 30、启动 0.4 / 15」答得了。

   给不出拆解的评分会在第一次争议里被"我觉得这家不错"覆盖掉。

   ── 「口径回顾」是这一页的第二半 ──────────────────────────────────
   没有回写就没有校准。所以顶上那一块问的不是候选中心，
   是**这套评分自己准不准**：入选的中心，当初预测和实际差多少。
   ════════════════════════════════════════════════════════════════════ */

interface Answers {
  ptYear: number; pastN: number; pastBest: number; compet: number;
  ethicsDays: number; startDays: number; teamN: number; piCommit: number;
  eligPct: number | null;
}
interface Score {
  parts: {
    source: number; past: number; competition: number;
    startup: number; team: number; eligibility: number;
  };
  total: number; predictedPerMonth: number; capPerMonth: number;
  level: "good" | "warn" | "crit"; calcVersion: string;
}
interface Feas {
  id: string; code: string;
  study: { id: string; code: string; shortName: string };
  hospital: string; city: string; dept: string; piName: string;
  surveyedOn: string; surveyedByName: string | null;
  answers: Answers; score: Score;
  status: "assessing" | "selected" | "rejected";
  decidedOn: string | null; decidedByName: string | null;
  studySiteId: string | null; siteCode: string | null;
  overrideReason: string | null; rejectReason: string | null;
  actualRate: number | null; bias: number | null;
}
interface Calibration {
  selected: number; meanBias: number | null;
  overrides: number; overridesGoneBad: number; calcVersion: string;
}

/** 逐项满分。**和服务端的权重表是同一组数** ——
 *  这里只用来画"得了几分 / 满分几分"的分母，算分不在前端。 */
const MAX = {
  source: 30, past: 30, competition: 15, startup: 15, team: 10, eligibility: 9
} as const;
const PART_LABEL: Record<keyof typeof MAX, string> = {
  source: "病源", past: "既往入组表现", competition: "竞争试验",
  startup: "启动效率", team: "团队规模", eligibility: "入排匹配度"
};
const LEVEL: Record<Score["level"], { text: string; chip: string }> = {
  good: { text: "推荐入选", chip: "flat" },
  warn: { text: "谨慎入选", chip: "warn" },
  crit: { text: "不建议入选", chip: "crit" }
};
const STATUS: Record<Feas["status"], string> = {
  assessing: "评估中", selected: "已入选", rejected: "未入选"
};

/** 低于这条线入选要写理由。与服务端的 OVERRIDE_BELOW 同一个数 ——
 *  差一点会让界面上"不用填"而服务端拒绝，那是最难说清的一种报错。 */
const OVERRIDE_BELOW = 65;

const one = (v: number) => v.toFixed(1);
const pctOf = (v: number | null) => v === null ? "—" : `${Math.round(v * 100)}%`;

export function FeasPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [rows, setRows] = useState<Feas[] | null>(null);
  const [cal, setCal] = useState<Calibration | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<
    { id: string; decision: "selected" | "rejected" } | null>(null);
  const [reason, setReason] = useState("");
  /** 正在回填哪一条的实际月入组 —— 行内编辑，不弹层：
   *  这一格是拿着预测那一行对照着填的，弹层会把参照物盖住。 */
  const [actualFor, setActualFor] = useState<string | null>(null);
  const [actual, setActual] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const reload = () => Promise.all([
    call<{ items: Feas[] }>("listFeasibility", { query: { limit: 100 } })
      .then(r => setRows(r.items)),
    call<Calibration>("getFeasibilityCalibration").then(setCal)
  ]);

  useEffect(() => { void loadMe().then(setMe); void reload(); }, []);

  if (!me || !rows || !cal) return <p className="muted">加载中…</p>;

  const canDecide = me.permissions.actions.includes("bid");

  /** 回填实际月入组。**评分唯一能自我修正的地方** —— 预测与实际摆在一起，
   *  下一次报价才有东西可以校准，而不是又一次「我觉得这家不错」。 */
  const saveActual = async (id: string) => {
    setBusy(true); setProblem(null); setSaid(null);
    try {
      const r = await call<{ data: Feas; sideEffects: { summary: string }[] }>(
        "recordFeasibilityActual",
        { params: { id }, body: { actualRate: Number(actual) } });
      await reload();
      setActualFor(null); setActual("");
      setSaid(r.sideEffects[0]?.summary ?? `${r.data.hospital} 的实际入组已回填`);
    } catch (e) {
      if (e instanceof ApiError) setProblem(e.problem); else throw e;
    } finally { setBusy(false); }
  };

  const decide = async () => {
    if (!deciding) return;
    setBusy(true); setProblem(null); setSaid(null);
    try {
      const r = await call<{ data: Feas; sideEffects: { summary: string }[] }>(
        "decideFeasibility",
        { params: { id: deciding.id }, body: {
          decision: deciding.decision,
          ...(reason.trim() ? { reason: reason.trim() } : {})
        } });
      await reload();
      setDeciding(null); setReason("");
      setSaid(r.sideEffects[0]?.summary
        ?? `${r.data.hospital} 已${deciding.decision === "selected" ? "入选" : "拒绝"}`);
    } catch (e) {
      if (e instanceof ApiError) setProblem(e.problem); else throw e;
    } finally { setBusy(false); }
  };

  /* 评估中的排最前（它们要人做决定），其余按分数降序。
     **不按调查日排** —— 一条挂了三个月没人定的调查，
     正是这一页要顶出来的东西。 */
  const shown = [...rows].sort((a, b) =>
    Number(b.status === "assessing") - Number(a.status === "assessing")
    || b.score.total - a.score.total);
  const todo = rows.filter(f => f.status === "assessing");

  return (
    <>
      <div className="page-head">
        <h2>中心可行性调查</h2>
        <p data-testid="feas-summary">
          {rows.length} 家候选中心
          {todo.length > 0
            ? <>，<b>{todo.length} 家还没定</b>。</>
            : "，都定完了。"}
        </p>
      </div>

      <div className="derive" style={{ marginBottom: 14 }}>
        报价模型算「这个项目要花多少<b>人天</b>」，这一页算「这家<b>能不能出病人</b>」。
        <br />
        选址选错，那个中心一年入组 0 例，而合同上的例数一个不少 ——
        只能靠别的中心加班补。<b>事后把亏损中心标红是最便宜也最没用的功能</b>：
        那时钱已经花完了。
      </div>

      {/* ── 口径回顾：这一页的第二半 ───────────────────────────────── */}
      <div className="card stack" data-testid="feas-calibration" style={{ marginBottom: 18 }}>
        <div className="spread">
          <h3>口径回顾</h3>
          <span className="muted mono" style={{ fontSize: 12 }}>
            口径 {cal.calcVersion}
          </span>
        </div>
        <div className="stats">
          <Stat label="已回填实际入组" v={String(cal.selected)}
            note={cal.selected ? "才谈得上准不准" : "还没有一条回填过"} />
          <Stat label="实际 ÷ 预测" v={cal.meanBias === null ? "—" : one(cal.meanBias)}
            note={cal.meanBias === null ? "无从判断"
              : cal.meanBias < 0.8 ? "打得偏乐观 —— PI 承诺系数该往下调"
              : cal.meanBias > 1.2 ? "打得偏保守 —— 可能漏掉了同样条件的候选中心"
              : "口径基本准"}
            bad={cal.meanBias !== null && cal.meanBias < 0.8} />
          <Stat label="低分入选" v={String(cal.overrides)}
            note={cal.overrides ? "每一个都有写下来的理由" : "无"} />
          <Stat label="其中真的没做出来" v={String(cal.overridesGoneBad)}
            note={cal.overridesGoneBad
              ? "月入组不到 1 例 —— 「当初说了不行」的兑现次数"
              : "无"}
            bad={cal.overridesGoneBad > 0} />
        </div>
        <p className="muted" style={{ margin: 0 }}>
          <b>没有回写就没有校准。</b> 入选的中心不回填实际入组，
          这套评分就只是一套自洽的说法 —— 而自洽的说法
          在第一次争议里会被「我觉得这家不错」覆盖掉。
        </p>
      </div>

      {problem && (
        <div className="problem stack" data-testid="feas-problem" style={{ marginBottom: 12 }}>
          <strong>{problem.title}</strong>
          {problem.detail && <div>{problem.detail}</div>}
        </div>
      )}
      {said && <p className="muted" data-testid="feas-said">{said}</p>}

      {/* 登记入口。此前这一页只能对已有的调查做入选/不选的判定 ——
          而「这家医院查过没有」本身就没法从界面上记下来。 */}
      {canDecide && <NewFeasibilityForm onCreated={() => void reload()} />}

      <div className="stack">
        {shown.map(f => {
          const lv = LEVEL[f.score.level];
          const open = openId === f.id;
          const capped = f.score.predictedPerMonth >= f.score.capPerMonth - 1e-9;
          return (
            <div className="card stack" key={f.id} data-testid="feas-row">
              <div className="spread">
                <h3>
                  {f.hospital}
                  <span className="muted" style={{ fontSize: 13, marginLeft: 8 }}>
                    {f.city} · {f.dept} · PI {f.piName}
                  </span>
                </h3>
                <span>
                  <span className={`chip ${lv.chip}`} data-testid="feas-level">
                    {Math.round(f.score.total)} 分 · {lv.text}
                  </span>
                  <span className="chip flat" style={{ marginLeft: 6 }}>
                    {STATUS[f.status]}
                  </span>
                </span>
              </div>

              <div className="muted" style={{ fontSize: 13 }}>
                <span className="mono">{f.code}</span> · {f.study.shortName} ·
                {" "}{f.surveyedOn} 调查{f.surveyedByName && ` · ${f.surveyedByName}`}
                {f.siteCode && <> · 已建档 <span className="mono">{f.siteCode}</span></>}
              </div>

              <div className="row" style={{ gap: 18, flexWrap: "wrap" }}>
                <span>
                  预测月入组 <b data-testid="feas-pred">{one(f.score.predictedPerMonth)}</b> 例
                  {capped && (
                    <span className="chip warn" style={{ marginLeft: 6 }}
                      data-testid="feas-capped">
                      撞到病源上限
                    </span>
                  )}
                </span>
                <span className="muted">
                  PI 自报 {one(f.answers.piCommit)} 例/月 ·
                  {" "}病源上限 {one(f.score.capPerMonth)} 例/月
                </span>
                {f.actualRate !== null && (
                  <span data-testid="feas-actual">
                    实际 <b>{one(f.actualRate)}</b> 例/月
                    {f.bias !== null && (
                      <span className={f.bias < 0.5 ? "chip crit" : "chip flat"}
                        style={{ marginLeft: 6 }}>
                        是预测的 {Math.round(f.bias * 100)}%
                      </span>
                    )}
                  </span>
                )}
              </div>

              {capped && (
                <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                  预测被病源封住了 —— <b>瓶颈是病人，不是团队</b>。
                  这家再加人也快不了，能改的只有入排标准或者换一家。
                </p>
              )}

              {(f.overrideReason || f.rejectReason) && (
                <div className={f.overrideReason ? "problem" : "derive"}
                  data-testid="feas-reason" style={{ margin: 0 }}>
                  {f.overrideReason
                    ? <><b>评分 {Math.round(f.score.total)} 分仍入选</b>，理由：{f.overrideReason}</>
                    : <>未入选，理由：{f.rejectReason}</>}
                </div>
              )}

              <div className="row">
                <button className="btn" data-testid={`feas-toggle-${f.id}`}
                  onClick={() => setOpenId(open ? null : f.id)}>
                  {open ? "收起评分明细" : "评分明细"}
                </button>
                {f.status === "assessing" && canDecide && (
                  <>
                    <button className="btn primary" data-testid={`feas-select-${f.id}`}
                      onClick={() => {
                        setDeciding({ id: f.id, decision: "selected" });
                        setReason(""); setProblem(null);
                      }}>入选</button>
                    <button className="btn" data-testid={`feas-reject-${f.id}`}
                      onClick={() => {
                        setDeciding({ id: f.id, decision: "rejected" });
                        setReason(""); setProblem(null);
                      }}>不选</button>
                  </>
                )}
                {f.status === "assessing" && !canDecide && (
                  <span className="muted">你的角色不能定选址</span>
                )}
                {/* 回填实际月入组。**只有已入选的中心谈得上实际入组速度** ——
                    没选的那家没有"实际"，评估中的那家还没开始。

                    契约把这一条叫做「整套评分唯一能自我修正的地方」：
                    没有它，评分只是一套自洽的说法，而自洽的说法
                    在第一次争议里会被「我觉得这家不错」覆盖掉。 */}
                {f.status === "selected" && canDecide && (
                  actualFor === f.id ? (
                    <span className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                      <input value={actual} type="number" data-testid={`feas-actual-input-${f.id}`}
                        aria-label="实际月入组（例/月）" placeholder="例/月"
                        style={{ width: 96 }}
                        onChange={e => setActual(e.target.value)} />
                      <button className="btn btn-p" data-testid={`feas-actual-save-${f.id}`}
                        disabled={busy || actual === "" || Number(actual) < 0}
                        onClick={() => void saveActual(f.id)}>存下来</button>
                      <button className="btn link"
                        onClick={() => { setActualFor(null); setActual(""); }}>取消</button>
                    </span>
                  ) : (
                    <button className="btn" data-testid={`feas-actual-${f.id}`}
                      onClick={() => {
                        setActualFor(f.id);
                        setActual(f.actualRate === null ? "" : String(f.actualRate));
                        setProblem(null);
                      }}>
                      {f.actualRate === null ? "回填实际月入组" : "改实际月入组"}
                    </button>
                  )
                )}
              </div>

              {open && (
                <div data-testid="feas-parts">
                  <table>
                    <thead>
                      <tr><th>项</th><th className="num">得分</th><th className="num">满分</th>
                        <th>依据</th></tr>
                    </thead>
                    <tbody>
                      {(Object.keys(MAX) as (keyof typeof MAX)[]).map(k => (
                        <tr key={k}>
                          <td>{PART_LABEL[k]}</td>
                          <td className="num">{one(f.score.parts[k])}</td>
                          <td className="num muted">
                            {k === "competition" ? `−${MAX[k]}` : MAX[k]}
                          </td>
                          <td className="muted">{basis(k, f.answers)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {f.answers.eligPct === null && (
                    <p className="muted" style={{ fontSize: 13 }}
                      data-testid="feas-no-elig">
                      <b>入排匹配度这一栏是空的 —— 当时问卷里没有这一项。</b>
                      它是复盘一次「评分 82 分入选、实际筛败率 57%」之后才加的：
                      病源足、团队强、启动快全部说对了，
                      但没有人问过「你们的病人符合我们这套入排吗」。
                      空着不扣分，因为那是<b>我们没问</b>，不是这家不行。
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {deciding && (() => {
        const f = rows.find(x => x.id === deciding.id);
        if (!f) return null;
        const low = f.score.total < OVERRIDE_BELOW;
        const must = deciding.decision === "rejected" || low;
        return (
          <div className="card stack" data-testid="feas-form" style={{ marginTop: 16 }}>
            <h3>
              {deciding.decision === "selected" ? "入选" : "不选"} {f.hospital}
              <span className="muted" style={{ fontSize: 13, marginLeft: 8 }}>
                {Math.round(f.score.total)} 分
              </span>
            </h3>
            {deciding.decision === "selected" && low && (
              <div className="problem" data-testid="feas-override-warn">
                <b>这家评分 {Math.round(f.score.total)} 分，低于 {OVERRIDE_BELOW} 分。</b>
                系统<b>不阻止</b>你选它 —— 商务上的取舍本来就不归一套评分决定
                （申办方指定 PI、为赶 FPI 凑中心数，都发生过）。
                但必须写下理由：半年后复盘「这家怎么会选进来」时，
                有那句话和没有那句话，是完全不同的两次会。
              </div>
            )}
            <label className="field">
              <span>
                {deciding.decision === "rejected" ? "不选的理由" : "入选的理由"}
                {must ? "（必填）" : "（选填）"}
              </span>
              <textarea rows={3} value={reason} data-testid="feas-reason-input"
                placeholder={deciding.decision === "rejected"
                  ? "「评分不够」不是答案 —— 年就诊多少、既往做过几次、启动要多久"
                  : "为什么明知分数不够还是要选它"}
                onChange={e => setReason(e.target.value)} />
            </label>
            <div className="row">
              <button className="btn primary" data-testid="feas-submit"
                disabled={busy || (must && reason.trim().length < 4)}
                onClick={() => void decide()}>
                {busy ? "…" : deciding.decision === "selected" ? "确认入选" : "确认不选"}
              </button>
              <button className="btn" onClick={() => { setDeciding(null); setReason(""); }}>
                取消
              </button>
            </div>
          </div>
        );
      })()}

      <div className="derive" style={{ marginTop: 14 }}>
        评分口径<b>全部公开</b>，逐项拆解就在上面 —— 给不出拆解的评分等于没有评分，
        它会在第一次争议里被「我觉得这家不错」覆盖掉。
        <br />
        这张表<b>外部方一行都看不到</b>：这里存的是「我们在评估哪几家医院、
        各打了多少分、谁被拒了」，让被比较的医院看见它，
        是可以直接毁掉合作关系的那种泄漏。
      </div>
    </>
  );
}

/** 每一项的依据 —— **画的是问卷里的那个数**，不是解释文案。
 *  "病源不足"是判断，"年就诊 45 例"是事实；被质疑时能拿出来的是后者。 */
function basis(k: keyof typeof MAX, a: Answers): string {
  switch (k) {
    case "source": return `年就诊 ${a.ptYear} 例`;
    case "past": return a.pastN === 0
      ? "从没做过同类试验 —— 没有历史就是 0 分，不按承诺折算"
      : `做过 ${a.pastN} 次，最好 ${a.pastBest} 例/月`;
    case "competition": return a.compet === 0 ? "无同期竞争试验" : `${a.compet} 个竞争试验在抢人`;
    case "startup": return `立项到 SIV ${a.startDays} 天 · 伦理 ${a.ethicsDays} 天`;
    case "team": return `研究团队 ${a.teamN} 人`;
    case "eligibility": return a.eligPct === null
      ? "当时问卷里没有这一项" : `按本方案入排估 ${pctOf(a.eligPct)} 合格`;
  }
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
