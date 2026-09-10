import { useCallback, useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { call, ApiError, type ProblemDetails } from "../../api/client.js";
import { loadMe } from "../login/me.js";
import { SITE_STATE_LABEL, SITE_ORDER } from "./states.js";
import { SubmitAcceptanceForm } from "../instac/SubmitAcceptanceForm.js";

/* ════════════════════════════════════════════════════════════════════
   中心详情 = 状态机 + 闸门。

   界面上最要紧的一件事：**推进按钮不能只是变灰。**
   一个禁用的按钮只说明"你不能点"，说不出"为什么"和"去哪儿处理" ——
   而 CRC 需要的正是后两件。

   而且"不能点"其实有**两个完全不同的原因**，混成一个灰按钮就都说不清了：

   ① 闸门没过 —— 事没做完。这是**当事人自己的活**，
      所以逐条摊开，每条带模块名，能跳的直接给链接。
   ② 没有 advance 动作权限 —— 事做完了也轮不到他点。
      种子里 CRC 恰恰**没有** advance（只有 boss / pm 有）：
      让 CRC 对着一个永远点不亮的按钮猜是哪种情况，
      是把权限模型的复杂度转嫁给了最没空琢磨它的人。

   所以这里把两者分开说，且 ① 无论有没有 ② 都照常显示 ——
   清单是 CRC 的活，跟谁来按最后那一下无关。
   ════════════════════════════════════════════════════════════════════ */

interface Site {
  id: string; code: string; hospital: string; dept: string; city: string;
  piName: string; state: string; contracted: number;
  study: { id: string; code: string; shortName: string };
  irbApprovedOn: string | null; sivOn: string | null;
  sivPlannedOn: string | null; fpiOn: string | null;
  /* 受列权限管辖：无权限时**字段不在**，不是 null */
  unitPriceCents?: number; startupFeeCents?: number;
}
interface Unmet { code: string; message: string; module?: string }
interface Gate { from: string; to: string; satisfied: boolean; unmet: Unmet[] }
interface SideEffect { type: string; summary: string; ref?: string }

/* 闸门的四种状态。**「读不到」和「没有」不是一回事** ——
   这里原来只有 `Gate | null`，而 null 是 `.catch(() => null)` 兜出来的：
   403、500、断网、超时，全都落成同一个 null，界面照着 null 画出的是

       「入组中」已是状态机的最后一个节点。

   一个正在入组的中心，因为一次网络抖动被告知它已经走到头了。
   服务端只在**真的没有下一节点**时回 422（site.service.ts 的 gate()），
   所以只有那一种才算「没有」，其余一律是「不知道」。 */
type GateState =
  | { kind: "loading" }
  | { kind: "gate"; gate: Gate }
  | { kind: "terminal" }
  | { kind: "unreadable"; problem: ProblemDetails | null };

/** siv 会写下 siv_on 并放行受试者相关工作，closed 是终态 —— 都走不回来。
 *  这**不是**校验规则（原因是每次都要写的），只是给按钮旁边加一句提醒。 */
const IRREVERSIBLE = new Set(["siv", "closed"]);

const yuan = (cents: number) => (cents / 100).toLocaleString("zh-CN",
  { style: "currency", currency: "CNY", maximumFractionDigits: 0 });

export function SiteDetailPage() {
  const { id = "" } = useParams();
  const [site, setSite] = useState<Site | null>(null);
  const [gate, setGate] = useState<GateState>({ kind: "loading" });
  const [canAdvance, setCanAdvance] = useState<boolean | null>(null);
  /** 递交立项材料要 `advance` —— 与推进同一个动作：
   *  两者都是「把这个中心往前推一格」，只是一个推的是自己的状态机，
   *  一个推的是医院那一侧的流程。 */
  const [canSubmitAcceptance, setCanSubmitAcceptance] = useState(false);
  const [reason, setReason] = useState("");
  const [effects, setEffects] = useState<SideEffect[] | null>(null);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const s = await call<Site>("getStudySite", { params: { id } });
    setSite(s);
    /* 闸门预检：**在按钮点下去之前**就给出答案。
       让人点一次再看错误，是把服务端的校验当成了交互设计。

       终态（closed）没有下一节点，后端回 422 —— 只有这一种当作"没有闸门"。
       别的错误（没权限、服务端出错、断网）是**读不到**，得照实说：
       兜底成"没有"的话，界面会替服务端编一句它从没说过的话。 */
    try {
      setGate({ kind: "gate", gate: await call<Gate>("getSiteGate", { params: { id } }) });
    } catch (e) {
      if (e instanceof ApiError)
        setGate(e.problem.status === 422
          ? { kind: "terminal" }
          : { kind: "unreadable", problem: e.problem });
      else setGate({ kind: "unreadable", problem: null });
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    void loadMe().then(m => {
      setCanAdvance(m.permissions.actions.includes("advance"));
      setCanSubmitAcceptance(m.permissions.actions.includes("advance"));
    }).catch(() => setCanAdvance(null));
  }, []);

  if (!site) return <p className="muted">加载中…</p>;
  const idx = SITE_ORDER.indexOf(site.state);
  /* 推进是 SENSITIVE_ACTIONS 里的动作 —— **每一次**都要写原因，不分节点。
     所以这里不做"哪些节点要填"的判断：那种判断一旦和策略层分家，
     界面就会放行一次服务端注定拒绝的提交。 */
  const reasonMissing = reason.trim().length < 4;
  /* 收窄一次，下面整段渲染都用它 —— 也就把"读不到"挡在了这张卡片之外。 */
  const g = gate.kind === "gate" ? gate.gate : null;
  /* 单独取一次：下面是按 g 分支的，TS 没法从 g 反推 gate 已经收窄成哪一支。 */
  const gateProblem = gate.kind === "unreadable" ? gate.problem : null;

  async function advance() {
    if (!g) return;
    setBusy(true); setProblem(null); setEffects(null);
    try {
      const r = await call<{ data: Site; sideEffects: SideEffect[] }>(
        "advanceStudySite",
        { params: { id }, body: { to: g.to, reason } });
      setEffects(r.sideEffects); setReason(""); await load();
    } catch (e) {
      if (e instanceof ApiError) setProblem(e.problem); else throw e;
    } finally { setBusy(false); }
  }

  return (
    <>
      <div className="page-head">
        <Link to="/sites" className="muted">← 我的中心</Link>
        <h2 style={{ marginTop: 6 }}>
          <span className="mono">{site.code}</span> {site.hospital}
        </h2>
        <p>{site.study.shortName} · {site.dept} · {site.city} · 研究者 {site.piName}</p>
      </div>

      <div className="stack" style={{ maxWidth: 760 }}>
        {/* 状态机：走到哪一步一眼看得出来 */}
        <section className="card">
          <h3 style={{ marginBottom: 10 }}>阶段</h3>
          <ol className="flow" data-testid="flow">
            {SITE_ORDER.map((st, i) => (
              <li key={st} className={i < idx ? "past" : i === idx ? "now" : ""}
                aria-current={i === idx ? "step" : undefined}>
                {SITE_STATE_LABEL[st]}
              </li>
            ))}
          </ol>
        </section>

        {g ? (
          <section className="card stack" data-testid="gate">
            <div className="spread">
              <h3>推进到「{SITE_STATE_LABEL[g.to] ?? g.to}」</h3>
              {g.satisfied
                ? <span className="chip good" data-testid="gate-open">前置条件已满足</span>
                : <span className="chip warn" data-testid="gate-blocked">
                    还差 {g.unmet.length} 项
                  </span>}
            </div>

            {!g.satisfied && (
              /* 不是一个变灰的按钮，而是一张「还差什么、去哪儿处理」的清单 */
              <ul className="unmet" data-testid="unmet">
                {g.unmet.map(u => (
                  <li key={u.code}>
                    {u.module && <span className="chip flat">{u.module}</span>}
                    <span>{u.message}</span>
                    {u.module === "startup" && (
                      <Link to={`/sites/${id}/startup`} className="btn go"
                        data-testid="go-startup">去处理</Link>
                    )}
                    {/* 「还没递交立项材料」是这张清单上**唯一一条受托方
                        自己就能办掉的** —— 其余几条要么是本方的活
                        （启动清单），要么球在医院那边（等受理通知）。
                        所以这一条给的不是「去处理」的链接，是当场就能填的表：
                        项目与医院都来自这个中心自己，不用再挑一遍。 */}
                    {u.code === "site-acceptance" && canSubmitAcceptance
                      && u.message.includes("还没") && (
                      <span data-testid="gate-submit-acceptance">
                        <SubmitAcceptanceForm
                          fixed={{
                            studyId: site.study.id, hospital: site.hospital,
                            label: `${site.study.code} · ${site.study.shortName}`
                          }}
                          onCreated={() => void load()} />
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {/* ② 与 ① 分开说：没权限不等于没做完，做完了也不等于轮到你按 */}
            {canAdvance === false && (
              <p className="muted" data-testid="no-advance-action">
                推进阶段需要「advance」动作权限，你的角色没有 ——
                清单清零后，请知会项目经理或经营层执行推进。
              </p>
            )}

            {canAdvance !== false && (
              <label className="field">
                <span>
                  推进原因（必填，至少 4 字）—— 核查员问的从来不是"推了吗"，
                  而是"为什么在这一天推"
                </span>
                <input value={reason} data-testid="advance-reason"
                  onChange={e => setReason(e.target.value)}
                  placeholder="例如：启动阻塞项已全部清零，机构同意排期" />
              </label>
            )}

            <div className="row">
              <button className="btn primary" data-testid="advance"
                disabled={busy || !g.satisfied || canAdvance === false || reasonMissing}
                onClick={() => void advance()}>
                {busy ? "推进中…" : `推进到「${SITE_STATE_LABEL[g.to] ?? g.to}」`}
              </button>
              {IRREVERSIBLE.has(g.to) &&
                <span className="chip warn" data-testid="irreversible">走不回来的一步</span>}
            </div>
          </section>
        ) : gate.kind === "terminal" ? (
          <section className="card">
            <p className="muted" data-testid="no-gate">
              「{SITE_STATE_LABEL[site.state] ?? site.state}」已是状态机的最后一个节点。
            </p>
          </section>
        ) : gate.kind === "loading" ? (
          <section className="card">
            <p className="muted" data-testid="gate-loading">正在读取闸门…</p>
          </section>
        ) : (
          /* **读不到 ≠ 没有。** 这一屏原来说的是「已是最后一个节点」——
             一个正在入组的中心，因为一次 403 或断网被告知它走到头了。
             照实说：读不到，而且把服务端的原话摆出来。 */
          <section className="card">
            <p className="problem" data-testid="gate-unreadable">
              <strong>读不到这个中心的闸门。</strong>
              {" "}下一步能不能推、还差什么，现在**都不知道** ——
              这不表示它已经走到最后一个节点。
            </p>
            {gateProblem && (
              <p className="muted">
                服务端说：{gateProblem.title}
                {gateProblem.detail ? ` —— ${gateProblem.detail}` : ""}
              </p>
            )}
            <div className="row">
              <button className="btn" data-testid="gate-retry"
                onClick={() => void load()}>重试</button>
            </div>
          </section>
        )}

        {problem && (
          <div className="problem" data-testid="advance-problem">
            <strong>{problem.title}</strong>
            <div>{problem.detail}</div>
            {problem.unmet && <ul>{problem.unmet.map((u, i) =>
              <li key={i}>{u.message}</li>)}</ul>}
          </div>
        )}

        {effects && (
          <section className="card stack" data-testid="advance-effects">
            <h3>这一次推进，系统还做了这些</h3>
            <ul className="effects">
              {effects.map((e, i) => (
                <li key={i}><div className="t">{e.type}</div><div>{e.summary}</div></li>
              ))}
            </ul>
          </section>
        )}

        <section className="card">
          <h3 style={{ marginBottom: 10 }}>关键日期</h3>
          <dl className="kv">
            <dt>伦理批件</dt><dd className="mono">{site.irbApprovedOn ?? "—"}</dd>
            <dt>计划 SIV</dt><dd className="mono">{site.sivPlannedOn ?? "—"}</dd>
            <dt>实际 SIV</dt><dd className="mono">{site.sivOn ?? "—"}</dd>
            <dt>首例入组</dt><dd className="mono">{site.fpiOn ?? "—"}</dd>
            <dt>合同例数</dt><dd className="num">{site.contracted}</dd>
            {/* 无权限时字段不在响应里，这两行就整行不出现 */}
            {site.unitPriceCents !== undefined && <>
              <dt>单例单价</dt><dd className="num">{yuan(site.unitPriceCents)}</dd></>}
            {site.startupFeeCents !== undefined && <>
              <dt>启动费</dt><dd className="num">{yuan(site.startupFeeCents)}</dd></>}
          </dl>
        </section>

        <div className="row">
          <Link to={`/sites/${id}/startup`} className="btn go"
            data-testid="open-startup">启动清单</Link>
          <Link to={`/sites/${id}/pnl`} className="btn go"
            data-testid="open-pnl">损益</Link>
        </div>
      </div>
    </>
  );
}
