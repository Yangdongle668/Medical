import { useCallback, useEffect, useState } from "react";
import { call, ApiError, type ProblemDetails } from "../../api/client.js";
import { loadMe } from "../login/me.js";
import { usePending } from "../../api/pending.js";

/* ════════════════════════════════════════════════════════════════════
   交接。

   休假、离职、调岗 —— 中心不会因此停下，所以交接不是一张告别贺卡，
   而是一道**闸门**：清单未逐项确认，这笔交接就不算完成；
   交接没完成，原负责人的账号就不该被停用。

   界面上守住两件事：

   ① **逐项确认，不是一次打勾了事。**
      八项里最容易漏也最要命的是「在组受试者逐例交底」——
      哪个依从性差、哪个家属有顾虑、哪个只能周三来，
      这些不在 EDC 里，只在上一个 CRC 脑子里。
      所以每一项单独一次调用、单独一次落库、单独记谁确认的。

   ② **未确认的项要逐条摊开**，而不是给一个禁用的"完成"按钮 ——
      与中心闸门同一条原则：说得出"还差什么"才叫把关。
   ════════════════════════════════════════════════════════════════════ */

interface HItem { seq: number; item: string; doneAt: string | null; doneByName: string | null }
interface Handover {
  id: string; fromAccountId: string; fromName: string;
  toAccountId: string; toName: string; reason: string; plannedOn: string;
  status: string; completedAt: string | null;
  sites: { id: string; code: string; hospital: string }[];
  items: HItem[]; doneCount: number; totalCount: number;
}
interface Staff { accountId: string; displayName: string; roleKind: string; city: string }
interface Site { id: string; code: string; hospital: string }
interface SideEffect { type: string; summary: string }

const STATUS_LABEL: Record<string, string> = {
  pending: "进行中", completed: "已完成", cancelled: "已取消"
};

/** 清单里这一项漏了，交接单签得再齐也等于没交接。 */
const CRITICAL = "在组受试者逐例交底";

export function HandoverPage() {
  const [list, setList] = useState<Handover[] | null>(null);
  const [effects, setEffects] = useState<SideEffect[] | null>(null);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const r = await call<{ items: Handover[] }>("listHandovers", { query: { limit: 50 } });
    /* 进行中的排前面：已完成的是档案，进行中的是待办 */
    setList([...r.items].sort((a, b) =>
      (a.status === "pending" ? 0 : 1) - (b.status === "pending" ? 0 : 1)));
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function run<T extends { sideEffects: SideEffect[] }>(
    key: string, fn: () => Promise<T>
  ) {
    setBusy(key); setProblem(null);
    try {
      const r = await fn();
      setEffects(r.sideEffects.length ? r.sideEffects : null);
      await load();
    } catch (e) {
      if (e instanceof ApiError) { setProblem(e.problem); setEffects(null); }
      else throw e;
    } finally { setBusy(null); }
  }

  /* 断网时确认一项、点一次完成，进的是发件箱 —— 行上要看得见。 */
  const pending = usePending();

  const confirmItem = (h: Handover, seq: number) => run(`${h.id}:${seq}`, () =>
    call<{ sideEffects: SideEffect[] }>("completeHandoverItem",
      { params: { id: h.id, seq }, body: {} }));

  const finish = (h: Handover) => run(h.id, () =>
    call<{ sideEffects: SideEffect[] }>("completeHandover",
      { params: { id: h.id }, body: {} }));

  return (
    <>
      <div className="page-head">
        <div className="spread">
          <h2>交接</h2>
          <button className="btn" data-testid="new-handover"
            onClick={() => setCreating(v => !v)}>{creating ? "收起" : "发起交接"}</button>
        </div>
        <p>清单未逐项确认不得完成 —— 签了字但受试者没交底，等于没交接。</p>
      </div>

      <div className="stack" style={{ maxWidth: 860 }}>
        {creating && <CreateHandover onDone={() => { setCreating(false); void load(); }} />}

        {problem && (
          <div className="problem" data-testid="handover-problem">
            <strong>{problem.title}</strong>
            <div>{problem.detail}</div>
            {problem.unmet && (
              /* 未确认项逐条摊开 —— 后端已经把话说全了，前端别再概括一遍 */
              <ul data-testid="handover-unmet">
                {problem.unmet.map((u, i) => <li key={i}>{u.message}</li>)}
              </ul>
            )}
          </div>
        )}

        {effects && (
          <ul className="effects" data-testid="handover-effects">
            {effects.map((e, i) => (
              <li key={i}><div className="t">{e.type}</div><div>{e.summary}</div></li>
            ))}
          </ul>
        )}

        {list?.length === 0 && <p className="muted" data-testid="no-handover">暂无交接单。</p>}

        {list?.map(h => (
          <section className="card stack" key={h.id} data-testid="handover">
            <div className="spread">
              <h3>
                {h.fromName} <span className="muted">→</span> {h.toName}
              </h3>
              <span className={`chip ${h.status === "pending" ? "warn" : "flat"}`}>
                {STATUS_LABEL[h.status] ?? h.status}
              </span>
            </div>
            <p className="muted">
              计划 <span className="mono">{h.plannedOn}</span> · {h.reason}
            </p>
            <div className="row">
              {h.sites.map(s => (
                <span className="chip flat" key={s.id}>
                  <span className="mono">{s.code}</span> {s.hospital}
                </span>
              ))}
            </div>

            <div className="spread">
              <span className="muted">交接清单</span>
              <span className="muted num" data-testid="handover-progress">
                {h.doneCount}/{h.totalCount}
              </span>
            </div>
            <ul className="tasks">
              {h.items.map(it => (
                <li key={it.seq} className={it.doneAt ? "done" : ""}>
                  <input type="checkbox"
                    checked={!!it.doneAt
                      || !!pending("completeHandoverItem", { id: h.id, seq: it.seq })}
                    disabled={!!it.doneAt || h.status !== "pending"
                      || busy === `${h.id}:${it.seq}`
                      || !!pending("completeHandoverItem", { id: h.id, seq: it.seq })}
                    aria-label={it.item} style={{ width: "auto" }}
                    onChange={() => void confirmItem(h, it.seq)} />
                  <span className="grow">
                    {it.item}
                    {it.doneByName && <div className="muted">由 {it.doneByName} 确认</div>}
                  </span>
                  {pending("completeHandoverItem", { id: h.id, seq: it.seq }) &&
                    <span className="chip flat" data-testid="queued-chip">待发</span>}
                  {it.item.includes(CRITICAL) && !it.doneAt &&
                    <span className="chip crit" data-testid="critical-item">最要命的一项</span>}
                </li>
              ))}
            </ul>

            {h.status === "pending" && (
              <div className="row">
                <button className="btn primary" data-testid="finish-handover"
                  disabled={busy === h.id || !!pending("completeHandover", { id: h.id })}
                  onClick={() => void finish(h)}>
                  {pending("completeHandover", { id: h.id }) ? "已排进发件箱" : "确认交接完成"}
                </button>
                {h.doneCount < h.totalCount && (
                  /* 按钮**不**禁用 —— 这里和中心详情页的推进按钮不一样，值得说清楚：
                     推进有 `GET /gate` 这个**服务端预检**，它的全部意义就是
                     "点下去之前先告诉你"，所以那边按预检结果禁用按钮是在**用**它；
                     交接没有对应的预检端点，唯一能知道还差什么的办法就是提交一次。
                     那就别在前端自己发明一套判定 —— 两边各判一次，
                     迟早长出分歧，而分歧总是倒向放行。
                     这里只提示还差几项，判定仍然由后端给。 */
                  <span className="muted" data-testid="handover-remaining">
                    还有 {h.totalCount - h.doneCount} 项未确认
                  </span>
                )}
              </div>
            )}
            {h.completedAt && (
              <p className="muted">
                完成于 <span className="mono">{h.completedAt.slice(0, 10)}</span> ——
                这些中心的派工已转到 {h.toName} 名下。
              </p>
            )}
          </section>
        ))}
      </div>
    </>
  );
}

/* ── 发起交接 ─────────────────────────────────────────────────────
   接手人只能是**同工种**的在职人员：CRA 与 CRC 不能互相顶替。
   这条规则由后端强制（invariant `handover-same-role-kind`），
   前端只把候选人缩到同工种 —— 是筛选，不是复刻校验。 */
function CreateHandover({ onDone }: { onDone: () => void }) {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [myKind, setMyKind] = useState<string | null>(null);
  const [to, setTo] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [plannedOn, setPlannedOn] = useState(new Date().toISOString().slice(0, 10));
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const me = await loadMe();
      const s = await call<{ items: Staff[] }>("listStaff", { query: { limit: 200 } });
      const sites = await call<{ items: Site[] }>("listStudySites", { query: { limit: 200 } });
      const mine = s.items.find(x => x.accountId === me.account.id);
      setMyKind(mine?.roleKind ?? null);
      setStaff(s.items.filter(x => x.accountId !== me.account.id));
      setSites(sites.items);
    })();
  }, []);

  const candidates = myKind ? staff.filter(s => s.roleKind === myKind) : staff;

  async function submit() {
    setBusy(true); setProblem(null);
    try {
      await call("createHandover", { body: {
        toAccountId: to, studySiteIds: picked, reason, plannedOn } });
      onDone();
    } catch (e) {
      if (e instanceof ApiError) setProblem(e.problem); else throw e;
    } finally { setBusy(false); }
  }

  return (
    <section className="card stack" data-testid="create-handover">
      <h3>发起交接</h3>
      <label className="field">
        <span>接手人{myKind && `（同为 ${myKind}）`}</span>
        <select value={to} data-testid="handover-to" onChange={e => setTo(e.target.value)}>
          <option value="">请选择</option>
          {candidates.map(s => (
            <option key={s.accountId} value={s.accountId}>
              {s.displayName} · {s.roleKind} · {s.city}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>交接的中心（只能交接自己当前负责的）</span>
        <select multiple size={Math.min(6, Math.max(3, sites.length))}
          data-testid="handover-sites"
          value={picked}
          onChange={e => setPicked(
            Array.from(e.target.selectedOptions, o => o.value))}>
          {sites.map(s => (
            <option key={s.id} value={s.id}>{s.code} {s.hospital}</option>
          ))}
        </select>
      </label>

      <div className="row" style={{ gap: 14, alignItems: "flex-end" }}>
        <label className="field" style={{ flex: "2 1 260px" }}>
          <span>交接原因（至少 5 字）</span>
          <input value={reason} data-testid="handover-reason"
            onChange={e => setReason(e.target.value)} placeholder="例如：产假，为期六个月" />
        </label>
        <label className="field" style={{ flex: "1 1 150px" }}>
          <span>计划交接日</span>
          <input type="date" value={plannedOn} data-testid="handover-planned"
            onChange={e => setPlannedOn(e.target.value)} />
        </label>
      </div>

      {problem && (
        <div className="problem" data-testid="create-problem">
          <strong>{problem.title}</strong><div>{problem.detail}</div>
        </div>
      )}

      <div>
        <button className="btn primary" data-testid="handover-submit"
          disabled={busy || !to || picked.length === 0 || reason.trim().length < 5}
          onClick={() => void submit()}>发起</button>
      </div>
    </section>
  );
}
