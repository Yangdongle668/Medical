import { useCallback, useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { call, ApiError, type ProblemDetails } from "../../api/client.js";
import { loadMe } from "../login/me.js";
import { SITE_STATE_LABEL, SITE_ORDER } from "./states.js";

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
  study: { code: string; shortName: string };
  irbApprovedOn: string | null; sivOn: string | null;
  sivPlannedOn: string | null; fpiOn: string | null;
  /* 受列权限管辖：无权限时**字段不在**，不是 null */
  unitPriceCents?: number; startupFeeCents?: number;
}
interface Unmet { code: string; message: string; module?: string }
interface Gate { from: string; to: string; satisfied: boolean; unmet: Unmet[] }
interface SideEffect { type: string; summary: string; ref?: string }

/** siv 会写下 siv_on 并放行受试者相关工作，closed 是终态 —— 都走不回来。
 *  这**不是**校验规则（原因是每次都要写的），只是给按钮旁边加一句提醒。 */
const IRREVERSIBLE = new Set(["siv", "closed"]);

const yuan = (cents: number) => (cents / 100).toLocaleString("zh-CN",
  { style: "currency", currency: "CNY", maximumFractionDigits: 0 });

export function SiteDetailPage() {
  const { id = "" } = useParams();
  const [site, setSite] = useState<Site | null>(null);
  const [gate, setGate] = useState<Gate | null>(null);
  const [canAdvance, setCanAdvance] = useState<boolean | null>(null);
  const [reason, setReason] = useState("");
  const [effects, setEffects] = useState<SideEffect[] | null>(null);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const s = await call<Site>("getStudySite", { params: { id } });
    setSite(s);
    /* 闸门预检：**在按钮点下去之前**就给出答案。
       让人点一次再看错误，是把服务端的校验当成了交互设计。
       终态（closed）没有下一节点，后端回 422 —— 这里当作"没有闸门"。 */
    setGate(await call<Gate>("getSiteGate", { params: { id } }).catch(() => null));
  }, [id]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    void loadMe().then(m => setCanAdvance(m.permissions.actions.includes("advance")))
      .catch(() => setCanAdvance(null));
  }, []);

  if (!site) return <p className="muted">加载中…</p>;
  const idx = SITE_ORDER.indexOf(site.state);
  /* 推进是 SENSITIVE_ACTIONS 里的动作 —— **每一次**都要写原因，不分节点。
     所以这里不做"哪些节点要填"的判断：那种判断一旦和策略层分家，
     界面就会放行一次服务端注定拒绝的提交。 */
  const reasonMissing = reason.trim().length < 4;

  async function advance() {
    if (!gate) return;
    setBusy(true); setProblem(null); setEffects(null);
    try {
      const r = await call<{ data: Site; sideEffects: SideEffect[] }>(
        "advanceStudySite",
        { params: { id }, body: { to: gate.to, reason } });
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

        {gate ? (
          <section className="card stack" data-testid="gate">
            <div className="spread">
              <h3>推进到「{SITE_STATE_LABEL[gate.to] ?? gate.to}」</h3>
              {gate.satisfied
                ? <span className="chip good" data-testid="gate-open">前置条件已满足</span>
                : <span className="chip warn" data-testid="gate-blocked">
                    还差 {gate.unmet.length} 项
                  </span>}
            </div>

            {!gate.satisfied && (
              /* 不是一个变灰的按钮，而是一张「还差什么、去哪儿处理」的清单 */
              <ul className="unmet" data-testid="unmet">
                {gate.unmet.map(u => (
                  <li key={u.code}>
                    {u.module && <span className="chip flat">{u.module}</span>}
                    <span>{u.message}</span>
                    {u.module === "startup" && (
                      <Link to={`/sites/${id}/startup`} className="btn go"
                        data-testid="go-startup">去处理</Link>
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
                disabled={busy || !gate.satisfied || canAdvance === false || reasonMissing}
                onClick={() => void advance()}>
                {busy ? "推进中…" : `推进到「${SITE_STATE_LABEL[gate.to] ?? gate.to}」`}
              </button>
              {IRREVERSIBLE.has(gate.to) &&
                <span className="chip warn" data-testid="irreversible">走不回来的一步</span>}
            </div>
          </section>
        ) : (
          <section className="card">
            <p className="muted" data-testid="no-gate">
              「{SITE_STATE_LABEL[site.state] ?? site.state}」已是状态机的最后一个节点。
            </p>
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
