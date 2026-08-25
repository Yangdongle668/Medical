import { useCallback, useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { call, ApiError, queueOwner, type ProblemDetails } from "../../api/client.js";
import { subscribe } from "../../api/outbox.js";
import { SITE_STATE_LABEL } from "./states.js";

/* ════════════════════════════════════════════════════════════════════
   启动清单 —— 中心详情页上那句"还差 N 项"的落地处。

   这个页面上只有一个数字真正重要：**未清零的阻塞项**。
   其余的（总数、完成数、逾期数）是背景，`blockingOpen` 是闸门本身。
   所以它单独占一行，并且用它自己的话说清后果 ——
   「清零前不能推进 SIV」，而不是一个红色的 0/16。

   非阻塞项照样显示、照样能勾，但不参与闸门：
   把它们混进同一个进度条，会让人以为"做到 90% 就差不多了" ——
   而真相可能是那 10% 全是阻塞项，一项都不能少。

   撤销要填原因，且入口刻意做得比"完成"难按一点：
   撤销可能让一个**已经推进**的中心回到"其实没准备好"的状态。

   ── 断网时这一页长什么样 ────────────────────────────────────────
   勾选的结果来自服务端（`checked={!!it.doneAt}`），断网时那一勾发不出去，
   于是**这一行看不出任何变化**。人接下来会做的事是显而易见的：再勾一次。
   两次点击就是两条命令、两把幂等键 —— 幂等键防不了这个。
   （集成测试里就是这么撞上的：连勾两下，落库只 +1。）

   所以待发的那一项要在**行上**说出来："待发"，且勾不动。
   发件箱角标是全局的，它回答不了"我刚才勾的那一行怎么样了"。
   ════════════════════════════════════════════════════════════════════ */

interface Item {
  id: string; category: string; categoryLabel: string; item: string;
  ownerName: string | null; dueOn: string | null; isBlocking: boolean;
  doneAt: string | null; doneByName: string | null; overdueDays: number | null;
}
interface Checklist {
  studySiteId: string; siteCode: string; hospital: string; state: string;
  sivPlannedOn: string | null; daysToSiv: number | null;
  total: number; done: number; blockingOpen: number; overdue: number;
  items: Item[];
}
interface SideEffect { type: string; summary: string; ref?: string }

/** 服务端已按 category.seq / sort_order 排好，这里只做分组，不重排。 */
function groupByCategory(items: Item[]) {
  const out: { key: string; label: string; items: Item[] }[] = [];
  for (const i of items) {
    const last = out.at(-1);
    if (last && last.key === i.category) last.items.push(i);
    else out.push({ key: i.category, label: i.categoryLabel, items: [i] });
  }
  return out;
}

export function StartupChecklistPage() {
  const { id = "" } = useParams();
  const [cl, setCl] = useState<Checklist | null>(null);
  const [effects, setEffects] = useState<SideEffect[] | null>(null);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [reopening, setReopening] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  /** 待发中的清单项 id —— 断网入队后行上要看得见，刷新也还在（队列落盘）。 */
  const [queued, setQueued] = useState<Set<string>>(new Set());
  useEffect(() => subscribe(s => setQueued(new Set(
    s.pending
      .filter(i => i.operationId === "completeStartupItem"
        && i.accountId === queueOwner()?.accountId)
      .map(i => String(i.params?.["id"] ?? ""))))), []);

  const load = useCallback(async () => {
    setCl(await call<Checklist>("getStartupChecklist", { params: { id } }));
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  if (!cl) return <p className="muted">加载中…</p>;

  async function run(fn: () => Promise<{ sideEffects: SideEffect[] }>, key: string) {
    setBusy(key); setProblem(null);
    try {
      const r = await fn();
      /* 副作用为空时把上一次的清掉 —— 留着会让人以为刚才那一勾又触发了一次 */
      setEffects(r.sideEffects.length ? r.sideEffects : null);
      await load();
    } catch (e) {
      if (e instanceof ApiError) { setProblem(e.problem); setEffects(null); }
      else throw e;
    } finally { setBusy(null); }
  }

  const complete = (itemId: string) => run(
    () => call<{ sideEffects: SideEffect[] }>(
      "completeStartupItem", { params: { id: itemId }, body: {} }), itemId);

  const reopen = (itemId: string) => run(
    async () => {
      const r = await call<{ sideEffects: SideEffect[] }>(
        "reopenStartupItem", { params: { id: itemId }, body: { reason } });
      setReopening(null); setReason("");
      return r;
    }, itemId);

  const groups = groupByCategory(cl.items);

  return (
    <>
      <div className="page-head">
        <Link to={`/sites/${id}`} className="muted">← {cl.siteCode} 中心详情</Link>
        <h2 style={{ marginTop: 6 }}>启动清单</h2>
        <p>
          {cl.hospital} · 当前阶段 {SITE_STATE_LABEL[cl.state] ?? cl.state}
          {cl.sivPlannedOn && <> · 计划 SIV <span className="mono">{cl.sivPlannedOn}</span></>}
          {cl.daysToSiv !== null && (
            cl.daysToSiv >= 0
              ? <> · 还有 <b className="num">{cl.daysToSiv}</b> 天</>
              : <> · 已过计划日 <b className="num">{-cl.daysToSiv}</b> 天</>)}
        </p>
      </div>

      <div className="stack" style={{ maxWidth: 860 }}>
        {/* 闸门本身，单独一行 —— 它不是进度条上的一段 */}
        <section className={`card gatebar ${cl.blockingOpen ? "blocked" : "clear"}`}
          data-testid="blocking-banner">
          {cl.blockingOpen > 0 ? (
            <>
              <strong className="num" data-testid="blocking-open">{cl.blockingOpen}</strong>
              <span>项<b>阻塞</b>未清零 —— 清零前这个中心不能推进到「SIV启动」。</span>
            </>
          ) : (
            <>
              <strong>✓</strong>
              <span>阻塞项已全部清零 —— 闸门对「SIV启动」放行。</span>
            </>
          )}
        </section>

        <div className="row" data-testid="counters">
          <span className="chip flat">共 <b className="num">{cl.total}</b> 项</span>
          <span className="chip flat">已完成 <b className="num">{cl.done}</b></span>
          {cl.overdue > 0 && (
            <span className="chip crit">逾期 <b className="num">{cl.overdue}</b></span>)}
        </div>

        {problem && (
          <div className="problem" data-testid="checklist-problem">
            <strong>{problem.title}</strong><div>{problem.detail}</div>
          </div>
        )}

        {effects && (
          <ul className="effects" data-testid="checklist-effects">
            {effects.map((e, i) => (
              <li key={i}><div className="t">{e.type}</div><div>{e.summary}</div></li>
            ))}
          </ul>
        )}

        {groups.map(g => (
          <section className="card" key={g.key}>
            <h3 style={{ marginBottom: 10 }}>{g.label}</h3>
            <ul className="tasks">
              {g.items.map(it => (
                <li key={it.id} className={it.doneAt ? "done" : ""}
                  data-testid="startup-item" data-blocking={it.isBlocking ? "1" : "0"}
                  data-queued={queued.has(it.id) ? "1" : undefined}>
                  <input type="checkbox" checked={!!it.doneAt || queued.has(it.id)}
                    disabled={!!it.doneAt || queued.has(it.id) || busy === it.id}
                    aria-label={it.item} style={{ width: "auto" }}
                    onChange={() => void complete(it.id)} />
                  <span className="grow">
                    {it.item}
                    <div className="muted">
                      {it.ownerName ?? "未指派"}
                      {it.dueOn && <> · 应完成 <span className="mono">{it.dueOn}</span></>}
                      {it.doneAt && <> · 由 {it.doneByName ?? "—"} 完成</>}
                    </div>
                  </span>
                  {/* 「待发」不是「已完成」：勾是人的意思，落库还没发生。
                      所以计数条上的"已完成"仍然是服务端那个数，不跟着动。 */}
                  {queued.has(it.id) && !it.doneAt &&
                    <span className="chip flat" data-testid="queued-chip">待发</span>}
                  {it.isBlocking && !it.doneAt &&
                    <span className="chip warn" data-testid="blocking-chip">阻塞</span>}
                  {it.overdueDays !== null &&
                    <span className="chip crit">逾期 {it.overdueDays} 天</span>}
                  {it.doneAt && (
                    <button className="btn link" data-testid="reopen"
                      onClick={() => { setReopening(it.id); setReason(""); }}>撤销</button>
                  )}
                </li>
              ))}
            </ul>

            {/* 撤销的表单落在它所属的分组里，避免弹层 —— 手机上弹层最难点 */}
            {g.items.some(i => i.id === reopening) && (
              <div className="stack" style={{ marginTop: 10 }} data-testid="reopen-form">
                <label className="field">
                  <span>
                    撤销原因（必填，至少 4 字）—— 若该中心已推进，
                    撤销意味着它当初的启动条件现在不成立
                  </span>
                  <input value={reason} data-testid="reopen-reason"
                    onChange={e => setReason(e.target.value)} />
                </label>
                <div className="row">
                  <button className="btn" data-testid="reopen-confirm"
                    disabled={reason.trim().length < 4 || busy === reopening}
                    onClick={() => void reopen(reopening!)}>确认撤销</button>
                  <button className="btn link"
                    onClick={() => setReopening(null)}>取消</button>
                </div>
              </div>
            )}
          </section>
        ))}
      </div>
    </>
  );
}
