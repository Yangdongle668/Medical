import { useCallback, useEffect, useState } from "react";
import { call, ApiError, type ProblemDetails } from "../../api/client.js";
import { loadMe } from "../login/me.js";
import { yuan } from "./money.js";

/* ════════════════════════════════════════════════════════════════════
   费率卡 —— I2 住在这里。

   **调价是两步，不是改一个数字。**

       ① 给旧卡收口（设 validTo）
       ② 从次日开一张新卡

   为什么不能直接改旧卡的单价：那张卡已经被若干条工时的成本快照引用着，
   它们的成本是按当时那个数算出来的。改掉它，等于改写历史成本 ——
   调价当天所有历史项目的毛利会集体变化，且无法向任何人解释。

   所以这一页把两步做成两步：收口的表单里没有单价那一栏，
   新建的表单里没有"要改哪张卡"。想改数字的人会发现这里没有那个入口，
   而不是改完之后才发现报表变了。

   同一工种/级别的生效区间重叠由**数据库**的 EXCLUDE 约束直接拒绝 ——
   前端不重复这条判定，只把服务端的 422 原样摊开。
   ════════════════════════════════════════════════════════════════════ */

interface Card {
  id: string; roleKind: string; level: string | null;
  /** 受 cost 列权限管辖：无权限时**字段不在** */
  dayCostCents?: number;
  validFrom: string; validTo: string | null; note: string | null;
}
interface SideEffect { type: string; summary: string }

const ROLE_KINDS = ["CRA", "CRC", "PM", "QA", "DM"] as const;
const addDays = (d: string, n: number) => {
  const x = new Date(d); x.setDate(x.getDate() + n);
  return x.toISOString().slice(0, 10);
};
const today = () => new Date().toISOString().slice(0, 10);

export function RateCardPage() {
  const [cards, setCards] = useState<Card[] | null>(null);
  const [canWrite, setCanWrite] = useState<boolean | null>(null);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [effects, setEffects] = useState<SideEffect[] | null>(null);
  const [closing, setClosing] = useState<Card | null>(null);
  const [validTo, setValidTo] = useState(today());
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await call<{ items: Card[] }>("listRateCards", { query: { limit: 100 } });
    /* 未收口的排前面 —— 它们是"现在生效"的那些，也是唯一能被调价的 */
    setCards([...r.items].sort((a, b) =>
      (a.validTo ? 1 : 0) - (b.validTo ? 1 : 0) || a.roleKind.localeCompare(b.roleKind)));
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    void loadMe().then(m => setCanWrite(m.permissions.actions.includes("rateWrite")))
      .catch(() => setCanWrite(null));
  }, []);

  if (!cards) return <p className="muted">加载中…</p>;
  const showCost = cards.some(c => c.dayCostCents !== undefined);

  async function close(card: Card) {
    setBusy(card.id); setProblem(null);
    try {
      const r = await call<{ sideEffects: SideEffect[] }>(
        "closeRateCard", { params: { id: card.id }, body: { validTo } });
      setEffects(r.sideEffects.length ? r.sideEffects : null);
      setClosing(null); await load();
    } catch (e) {
      if (e instanceof ApiError) { setProblem(e.problem); setEffects(null); }
      else throw e;
    } finally { setBusy(null); }
  }

  return (
    <>
      <div className="page-head">
        <h2>费率卡</h2>
        <p>
          <b>调价是两步：先给旧卡收口，再从次日开新卡。</b>
          改旧卡的数字等于改写历史成本 —— 那张卡已经被若干条工时的成本快照引用着。
        </p>
      </div>

      <div className="stack" style={{ maxWidth: 860 }}>
        {canWrite === false && (
          <p className="muted" data-testid="no-rate-write">
            维护费率卡需要「rateWrite」动作权限，只有经营层持有 —— 这里只能查看。
          </p>
        )}

        {problem && (
          <div className="problem" data-testid="rate-problem">
            <strong>{problem.title}</strong><div>{problem.detail}</div>
          </div>
        )}
        {effects && (
          <ul className="effects" data-testid="rate-effects">
            {effects.map((e, i) => (
              <li key={i}><div className="t">{e.type}</div><div>{e.summary}</div></li>
            ))}
          </ul>
        )}

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>工种</th><th>级别</th>
                {showCost && <th>人天单价</th>}
                <th>生效区间</th><th>备注</th>
                {canWrite !== false && <th />}
              </tr>
            </thead>
            <tbody>
              {cards.map(c => (
                <tr key={c.id} data-testid="rate-row"
                  data-open={c.validTo ? "0" : "1"}>
                  <td>{c.roleKind}</td>
                  <td>{c.level ?? <span className="muted">通用</span>}</td>
                  {showCost && (
                    <td className="num">{yuan(c.dayCostCents ?? 0)}</td>
                  )}
                  <td className="mono">
                    {c.validFrom} ~ {c.validTo ?? "至今"}
                    {!c.validTo && (
                      <span className="chip good" style={{ marginLeft: 6 }}>生效中</span>
                    )}
                  </td>
                  <td className="muted">{c.note ?? "—"}</td>
                  {canWrite !== false && (
                    <td>
                      {/* 已收口的卡没有任何可做的动作 —— 它是历史，不是配置 */}
                      {c.validTo ? <span className="muted">—</span> : (
                        <button className="btn link" data-testid="close-card"
                          onClick={() => { setClosing(c); setValidTo(today()); }}>
                          收口
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 第一步：收口。**这张表单里没有单价那一栏** —— 收口不改价。 */}
        {closing && (
          <section className="card stack" data-testid="close-form">
            <h3>第一步 · 给 {closing.roleKind}
              {closing.level ? ` / ${closing.level}` : ""} 这张卡收口</h3>
            <p className="muted">
              收口只设一个「最后生效日」，<b>不动单价</b>。
              这张卡上的历史工时成本因此保持原样。
            </p>
            <label className="field" style={{ maxWidth: 220 }}>
              <span>最后一个生效日（含）</span>
              <input type="date" value={validTo} min={closing.validFrom}
                data-testid="close-valid-to"
                onChange={e => setValidTo(e.target.value)} />
            </label>
            <div className="row">
              <button className="btn primary" data-testid="close-confirm"
                disabled={busy === closing.id || validTo < closing.validFrom}
                onClick={() => void close(closing)}>确认收口</button>
              <button className="btn link" onClick={() => setClosing(null)}>取消</button>
            </div>
          </section>
        )}

        {/* 第二步：开新卡 */}
        {canWrite !== false && (
          <NewRateCard defaultFrom={closing ? addDays(validTo, 1) : today()}
            onDone={() => void load()} />
        )}
      </div>
    </>
  );
}

function NewRateCard(
  { defaultFrom, onDone }: { defaultFrom: string; onDone: () => void }
) {
  const [roleKind, setRole] = useState<string>("CRC");
  const [level, setLevel] = useState("");
  const [dayCost, setDayCost] = useState("");
  const [validFrom, setFrom] = useState(defaultFrom);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [busy, setBusy] = useState(false);

  /* 收口日一变，新卡的起始日跟着走到次日 —— 两步之间不该留一天的缝，
     那一天填的工时会找不到生效的费率卡而被拒绝填报。 */
  useEffect(() => { setFrom(defaultFrom); }, [defaultFrom]);

  async function submit() {
    setBusy(true); setProblem(null);
    try {
      await call("createRateCard", { body: {
        roleKind, level: level || null,
        dayCostCents: Math.round(Number(dayCost) * 100),
        validFrom, ...(note ? { note } : {})
      } });
      setDayCost(""); setNote(""); onDone();
    } catch (e) {
      if (e instanceof ApiError) setProblem(e.problem); else throw e;
    } finally { setBusy(false); }
  }

  return (
    <section className="card stack" data-testid="new-rate-card">
      <h3>第二步 · 开一张新卡</h3>
      <div className="row" style={{ gap: 12, alignItems: "flex-end" }}>
        <label className="field" style={{ flex: "1 1 110px" }}>
          <span>工种</span>
          <select value={roleKind} data-testid="rate-role"
            onChange={e => setRole(e.target.value)}>
            {ROLE_KINDS.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <label className="field" style={{ flex: "1 1 110px" }}>
          <span>级别（留空 = 通用）</span>
          <input value={level} data-testid="rate-level"
            onChange={e => setLevel(e.target.value)} placeholder="如 P4" />
        </label>
        <label className="field" style={{ flex: "1 1 130px" }}>
          <span>人天单价（元）</span>
          <input type="number" step="1" min="1" value={dayCost}
            data-testid="rate-day-cost" onChange={e => setDayCost(e.target.value)} />
        </label>
        <label className="field" style={{ flex: "1 1 150px" }}>
          <span>生效起始日</span>
          <input type="date" value={validFrom} data-testid="rate-valid-from"
            onChange={e => setFrom(e.target.value)} />
        </label>
      </div>
      <label className="field">
        <span>备注（选填，例如「2026 年度调价」）</span>
        <input value={note} data-testid="rate-note"
          onChange={e => setNote(e.target.value)} />
      </label>

      {problem && (
        <div className="problem" data-testid="new-rate-problem">
          <strong>{problem.title}</strong><div>{problem.detail}</div>
        </div>
      )}

      <div>
        <button className="btn primary" data-testid="rate-submit"
          disabled={busy || Number(dayCost) < 1}
          onClick={() => void submit()}>{busy ? "提交中…" : "新增费率卡"}</button>
      </div>
    </section>
  );
}
