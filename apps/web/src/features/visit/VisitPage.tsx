import { useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { call, ApiError, type ProblemDetails } from "../../api/client.js";
import { KIND, type Visit, type Inbox, type InboxItem } from "../today/TodayPage.js";
import { usePending } from "../../api/pending.js";
import { loadMe, type Me } from "../login/me.js";
import { today } from "../../shell/dates.js";
import { UnmetList } from "../../shell/Unmet.js";
import { EffectItem } from "../../shell/Effects.js";
import { Why } from "../../shell/Why.js";

/* 完成一次访视 —— 系统里最重要的一个动作。
   界面要做对两件事：
   ① 任务没勾完，提交按钮就该是禁用的，而**旁边写清楚还差什么**；
   ② 提交后把一串后果原样摊开 —— 一线必须立刻知道
      「我刚才不只是打了个卡，系统还替我记了一次方案偏离」。 */

interface SideEffect {
  type: string; summary: string; ref?: string; amountCents?: number;
}
interface CompleteResult {
  data: Visit; sideEffects: SideEffect[];
  pending?: { name: string; what: string; phase: string }[];
}

export function VisitPage() {
  const { id = "" } = useParams();
  const [visit, setVisit] = useState<Visit | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [actualDate, setActualDate] = useState(today());
  const [hours, setHours] = useState("3.5");
  /** 人改过工时就不再拿默认值覆盖 —— 重读访视（勾一项任务就重读一次）不该把他填的冲掉。 */
  const hoursTouched = useRef(false);
  const [reason, setReason] = useState("");
  /** PI 哪天签的字。载入访视之后默认成访视当天 —— 见下面那一段。 */
  const [confirmedOn, setConfirmedOn] = useState("");
  const [result, setResult] = useState<CompleteResult | null>(null);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  /** 404：不存在，或者不在行范围里 —— 两者对外是同一件事。 */
  const [gone, setGone] = useState(false);
  const [busy, setBusy] = useState(false);
  /* 断网时勾一下、点一下，进的是发件箱 —— 行上要说出来，否则人会再点一次。 */
  const pending = usePending();

  /* **取这一条，不是取一页再在里面找。**
     原来是 `listSubjectVisits({ limit: 200 })` 然后 `.find(v => v.id === id)`。
     种子里只有 10 条访视时，这两种写法看不出任何区别。
     访视上了几百条之后：列表按窗口升序，前 200 条全是更早的历史访视，
     `find` 返回 undefined —— 而 undefined 就是"还没加载完"的那个值，
     于是页面**永远停在「加载中…」**。没有报错，没有空态，
     Network 里那个请求还是 200。这是最难报障的一种坏法。 */
  const load = () =>
    call<Visit>("getSubjectVisit", { params: { id } })
      .then(v => {
        setVisit(v); setGone(false);
        /* 签字日期默认成**访视当天**，不是今天。
           PI 绝大多数情况下就是在访视现场签的；默认成今天的话，
           一份上周做完的访视会挂上今天的确认日期 ——
           而那种"确认日比访视日晚八天"的记录，核查时是要被问的。
           已经登记过的（补登、改期）保留原值。 */
        setConfirmedOn(c => c || v.piConfirmedAt?.slice(0, 10) || v.actualDate || today());
        /* 工时默认成本中心同一访视最近几次的中位数（服务端给）；没有历史才用 3.5。
           原来一律 3.5 —— 筛选期访视和一次给药按同一个数默认，等于每次都要改。 */
        if (!hoursTouched.current && v.suggestedHours != null) setHours(String(v.suggestedHours));
      })
      .catch(e => {
        if (e instanceof ApiError && e.problem.status === 404) { setVisit(null); setGone(true); return; }
        throw e;
      });
  /* 换一条访视要先把签字日期清掉 —— 不清的话，上一条的日期会跟过来，
     而它看起来完全像是"这一条的默认值"。 */
  useEffect(() => { setConfirmedOn(""); hoursTouched.current = false; void load(); }, [id]);
  useEffect(() => { void loadMe().then(setMe); }, []);

  /* 三种状态要分得开：拿到了 / 还在拿 / 拿不到。
     把后两种合成一个「加载中…」，正是上面那个 bug 能藏这么久的原因。 */
  if (gone) return (
    <div className="stack">
      <Link to="/today" className="muted">← 今天</Link>
      <p className="problem" data-testid="visit-gone">
        找不到这次访视，或者它不在你的范围里。
      </p>
    </div>
  );
  if (!visit) return <p className="muted">加载中…</p>;

  const open = visit.tasks.filter(t => !t.doneAt);
  const outOfWindow = actualDate < visit.windowFrom || actualDate > visit.windowTo;
  const done = visit.status !== "planned";

  /* 勾一项。**这里原来一个 catch 都没有** —— 因为那时服务端对
     "这一项已经被别人勾了" 也回 200（那条 UPDATE 匹配 0 行却不报错）。
     现在它会回 409，而一个没人接的 rejected promise 只会进控制台：
     勾选框弹回去，页面上一个字都不说。两个 CRC 同时勾同一张任务单
     不是罕见情形，那正是这条清单要处理的现场。 */
  async function tick(seq: number) {
    setProblem(null);
    try {
      await call("completeVisitTask", { params: { id, seq }, body: {} });
    } catch (e) {
      if (e instanceof ApiError) setProblem(e.problem); else throw e;
    }
    /* 无论成没成都重读：失败那次多半是别人已经勾了，
       而"最新的清单"正是这时候最该给的东西。 */
    await load();
  }

  /** 全部勾上。**一项一项发**，不是一个批量接口：每一项各带各的幂等键，
   *  断网时各自进发件箱，重放时各自认得出来 —— 与手点十次完全一样，只是不用点十次。
   *  中途有一项失败（多半是别人刚勾了）就停下，把最新的清单读回来。 */
  async function tickAll() {
    setBusy(true); setProblem(null);
    try {
      for (const t of visit?.tasks ?? []) {
        if (t.doneAt || pending("completeVisitTask", { id, seq: t.seq })) continue;
        await call("completeVisitTask", { params: { id, seq: t.seq }, body: {} });
      }
    } catch (e) {
      if (e instanceof ApiError) setProblem(e.problem); else throw e;
    } finally {
      setBusy(false);
      await load();
    }
  }

  /** 标记已录入 EDC。断网时照样能按 —— 与勾任务、完成访视同一条路，
   *  进发件箱，联网后自己发出去。 */
  async function markEdc() {
    setBusy(true); setProblem(null);
    try {
      await call("enterVisitToEdc", { params: { id }, body: {} });
      await load();
    } catch (e) {
      if (e instanceof ApiError) setProblem(e.problem); else throw e;
    } finally { setBusy(false); }
  }

  /** 登记「PI 已于某日签字确认」。与勾任务、完成访视同一条路，断网进发件箱。 */
  async function registerPiConfirm() {
    setBusy(true); setProblem(null);
    try {
      await call("confirmSubjectVisit", { params: { id }, body: { confirmedOn } });
      await load();
    } catch (e) {
      if (e instanceof ApiError) setProblem(e.problem); else throw e;
    } finally { setBusy(false); }
  }

  async function submit() {
    setBusy(true); setProblem(null);
    try {
      const r = await call<CompleteResult>("completeSubjectVisit", {
        params: { id },
        body: {
          actualDate, hours: Number(hours),
          ...(outOfWindow && reason ? { outOfWindowReason: reason } : {})
        }
      });
      setResult(r); await load();
    } catch (e) {
      if (e instanceof ApiError) setProblem(e.problem); else throw e;
    } finally { setBusy(false); }
  }

  return (
    <>
      <div className="page-head">
        <Link to="/today" className="muted">← 今天</Link>
        <h2 style={{ marginTop: 6 }}>{visit.visitLabel}</h2>
        <p>
          <span className="mono">{visit.screeningNo ?? "—"}</span> ·{" "}
          <span className="mono">{visit.siteCode}</span> · 窗口{" "}
          <span className="mono">{visit.windowFrom} ~ {visit.windowTo}</span>
        </p>
      </div>

      <div className="stack" style={{ maxWidth: 720 }}>
        <Steps visit={visit} />
        <section className="card">
          <div className="spread" style={{ marginBottom: 10 }}>
            <h3>访视任务</h3>
            <span className="row" style={{ gap: 10, alignItems: "center" }}>
              {!done && open.length > 1 && (
                <button className="btn" data-testid="tick-all" disabled={busy}
                  onClick={() => void tickAll()}>全部勾选</button>
              )}
              <span className="muted num" data-testid="task-count">
                {visit.tasks.length - open.length}/{visit.tasks.length}
              </span>
            </span>
          </div>
          <ul className="tasks">
            {visit.tasks.map(t => (
              <li key={t.seq} className={t.doneAt ? "done" : ""}>
                <input type="checkbox"
                  checked={!!t.doneAt || !!pending("completeVisitTask", { id, seq: t.seq })}
                  disabled={!!t.doneAt || done || !!pending("completeVisitTask", { id, seq: t.seq })}
                  onChange={() => void tick(t.seq)}
                  aria-label={t.task} style={{ width: "auto" }} />
                <span>{t.task}</span>
                {/* 「待发」不是「已完成」：勾是人的意思，落库还没发生。 */}
                {pending("completeVisitTask", { id, seq: t.seq }) &&
                  <span className="chip flat" data-testid="queued-chip">待发</span>}
              </li>
            ))}
          </ul>
        </section>

        {!done && (
          <section className="card stack">
            <h3>完成访视</h3>
            <div className="row" style={{ gap: 14 }}>
              <label className="field" style={{ flex: "1 1 160px" }}>
                <span>实际完成日</span>
                <input type="date" value={actualDate} data-testid="actual-date"
                  onChange={e => setActualDate(e.target.value)} />
              </label>
              <label className="field" style={{ flex: "1 1 120px" }}>
                <span>本次投入工时</span>
                <input type="number" step="0.5" min="0.25" max="24" value={hours}
                  data-testid="hours"
                  onChange={e => { hoursTouched.current = true; setHours(e.target.value); }} />
              </label>
            </div>

            {outOfWindow && (
              <label className="field">
                <span>
                  超窗原因（必填）—— 它会原样进入方案偏离记录
                </span>
                <textarea rows={2} value={reason} data-testid="oow-reason"
                  onChange={e => setReason(e.target.value)}
                  placeholder="例如：受试者外地务工，返院延迟" />
              </label>
            )}

            {open.length > 0 && (
              <p className="muted" data-testid="blocked-hint">
                还有 {open.length} 项任务未完成：{open.map(t => t.task).join("、")}
              </p>
            )}

            <div className="row">
              <button className="btn primary" data-testid="submit"
                disabled={busy || open.length > 0 || !!pending("completeSubjectVisit", { id })
                  || (outOfWindow && reason.trim().length < 4)}
                onClick={() => void submit()}>
                {pending("completeSubjectVisit", { id }) ? "已排进发件箱"
                  : busy ? "提交中…" : "完成访视"}
              </button>
              {pending("completeSubjectVisit", { id }) &&
                <span className="chip flat" data-testid="queued-chip">待发</span>}
              {outOfWindow && <span className="chip crit">超窗提交</span>}
            </div>
          </section>
        )}

        {/* ── 登记 PI 确认 ────────────────────────────────────────────
            **这一块此前不存在**，而它是全系统最大的一处卡死。

            原来只有外部的 `pi` 角色能确认，服务层还要求
            `study_site.pi_account_id = 当前账号` —— 也就是说，
            只有**绑了本系统账号的 PI 本人**点得动。
            实测 15 个中心只有 1 个绑了：另外 14 个中心的访视
            做完之后永远停在 `done_pending_pi`（189 条），
            而那个状态**不计入「已完成」统计**（I3）——
            入组进度、完成率、成本归集全都系统性偏低，没有任何地方报错。

            I3 的实质保留：**PI 签的字仍然是放行条件。**
            变的是形式 —— 那件事由一线带着日期登记进来，
            与「登记伦理批复」「登记立项材料递交」同一个形状。
            真绑了账号的 PI 照样自己点（研究者工作台那一页），
            那时 `piConfirmedByName` 记的是他本人；
            一线登记的留空 —— 填登记人自己进去是冒充，而谁登记的审计轨迹里有。 */}
        {visit.status === "done_pending_pi" && (
          <section className="card stack" data-testid="pi-confirm-block">
            <div className="card-h">
              <h3>登记 PI 确认</h3>
              <span className="sub">签在纸上的那一下，登记进来</span>
            </div>
            <div className="card-b stack">
              {me && !me.permissions.actions.includes("piConfirm") ? (
                <p className="note" style={{ margin: 0 }} data-testid="pi-confirm-denied">
                  这一步你点不了 —— 需要<b>登记 PI 确认访视</b>的权限。
                  找管理员在「组织与权限」里给，或者交给这个中心的 CRC / CRA。
                </p>
              ) : (
                <>
                  <label className="field" style={{ maxWidth: 220 }}>
                    <span>PI 哪天签的字</span>
                    <input type="date" value={confirmedOn} data-testid="pi-confirm-date"
                      max={today()} min={visit.actualDate ?? undefined}
                      onChange={e => setConfirmedOn(e.target.value)} />
                  </label>
                  {visit.actualDate && confirmedOn && confirmedOn < visit.actualDate && (
                    <span className="t-crit" data-testid="pi-confirm-early"
                      style={{ fontSize: 12 }}>
                      早于访视日（{visit.actualDate}）—— PI 不会在访视发生前确认它。
                    </span>
                  )}
                  {confirmedOn > today() && (
                    <span className="t-crit" data-testid="pi-confirm-future"
                      style={{ fontSize: 12 }}>
                      这个日期在将来 —— 这一栏记的是「哪天签的」，还没签的不用先登记。
                    </span>
                  )}
                  <div className="row">
                    <button className="btn btn-p" data-testid="pi-confirm-go"
                      disabled={busy || !confirmedOn || confirmedOn > today()
                        || (!!visit.actualDate && confirmedOn < visit.actualDate)
                        || !!pending("confirmSubjectVisit", { id })}
                      onClick={() => void registerPiConfirm()}>
                      {pending("confirmSubjectVisit", { id }) ? "已排进发件箱"
                        : busy ? "提交中…" : "登记 PI 已确认"}
                    </button>
                    {pending("confirmSubjectVisit", { id }) &&
                      <span className="chip flat" data-testid="pi-queued">待发</span>}
                    <span className="note">
                      登记后这次访视锁定，<b>开始计入「已完成」统计</b>。
                    </span>
                  </div>
                </>
              )}
              <Why>
                <b>确认人这一栏不填，是有意的。</b>
                PI 多数时候没有本系统的账号 —— 从一个下拉框里挑一个名字填进去，
                填的是编的。<b>谁在系统里登记了这一条</b>进审计轨迹，那是另一件事。
              </Why>
            </div>
          </section>
        )}
        {visit.status === "locked" && visit.piConfirmedAt && (
          <p className="muted" data-testid="pi-confirmed">
            <span className="chip good">PI 已确认</span>{" "}
            <span className="mono">{visit.piConfirmedAt.slice(0, 10)}</span>
            {visit.piConfirmedByName
              ? <> · 由 {visit.piConfirmedByName} 在本系统确认</>
              : <> · <span className="muted">由一线登记（PI 签在纸上）</span></>}
          </p>
        )}

        {/* ── 录入 EDC ────────────────────────────────────────────────
            **完成访视和录进 EDC 是两件事。** 访视做完了，数据还躺在
            原始病历上 —— 而数据管理那边看到的是"这一例还没有数"。
            5 个工作日内录入才算及时；超时不阻断，但进及时率统计。

            此前这一步在界面上标不了：访视能完成、能确认，就是没法说
            "数已经录进去了"，于是那个及时率永远只有分母。 */}
        {done && visit.edcStatus === "pending" && (
          <section className="card stack" data-testid="edc-block">
            <div className="card-h">
              <h3>录入 EDC</h3>
              <span className="sub">完成访视和录进 EDC 是两件事</span>
            </div>
            <div className="card-b stack">
              {visit.edcDaysLate != null && visit.edcDaysLate > 0
                ? <div className="problem" data-testid="edc-late">
                    已超出 5 个工作日 <b className="num">{visit.edcDaysLate}</b> 天 ——
                    <b>不阻断，但进及时率统计</b>。
                  </div>
                : <p className="note" style={{ margin: 0 }}>
                    访视完成后 5 个工作日内录入才算及时。
                  </p>}
              <div className="row">
                <button className="btn btn-p" data-testid="edc-entered"
                  disabled={busy || !!pending("enterVisitToEdc", { id })}
                  onClick={() => void markEdc()}>
                  {pending("enterVisitToEdc", { id }) ? "已排进发件箱" : "标记已录入 EDC"}
                </button>
                {pending("enterVisitToEdc", { id }) &&
                  <span className="chip flat" data-testid="edc-queued">待发</span>}
              </div>
            </div>
          </section>
        )}
        {done && visit.edcStatus === "entered" && (
          <p className="muted" data-testid="edc-done">
            <span className="chip good">已录入 EDC</span>
          </p>
        )}

        {problem && (
          <div className="problem" data-testid="problem">
            <strong>{problem.title}</strong>
            <div>{problem.detail}</div>
            {problem.unmet && (
              <UnmetList items={problem.unmet} testid="visit-unmet" />
            )}
          </div>
        )}

        {result && (
          <section className="card stack" data-testid="effects">
            <h3>这一次提交，系统还做了这些</h3>
            <ul className="effects">
              {result.sideEffects.map((e, i) => (
                <EffectItem key={i} type={e.type} summary={e.summary} />
              ))}
              {/* 「尚未接上」那一块。现在七个订阅者全接上了，后端下发的
                  pending 是空数组，于是这里一条都不画。
                  **字段和这段渲染都留着** —— 下一个暂时接不上的订阅者
                  出现时，它要能立刻在界面上说出来，而不是先经历一轮
                  "为什么没人知道还差一件事"。 */}
              {result.pending?.map(p => (
                <li key={p.name} className="pending" data-testid="pending-subscribers">
                  <div className="t">尚未接上</div>
                  <div>{p.name}：{p.what}（{p.phase}）</div>
                </li>
              ))}
            </ul>
          </section>
        )}

        <NextUp here={id} status={visit.status} edc={visit.edcStatus ?? "pending"} />
      </div>
    </>
  );
}

/* ── 三步：完成访视 → 登记 PI 签字 → 录入 EDC ─────────────────────────
   一次访视在系统里要走三步，原来它们是三块各自出现又各自消失的卡片，
   人不知道自己走到了哪、还差几步。后两步不分先后（都在访视完成之后）。 */
function Steps({ visit }: { visit: Visit }) {
  const completed = visit.status !== "planned";
  const steps = [
    { label: "完成访视", done: completed, now: !completed },
    { label: "登记 PI 签字", done: visit.status === "locked", now: visit.status === "done_pending_pi" },
    { label: "录入 EDC", done: visit.edcStatus === "entered",
      now: completed && visit.edcStatus !== "entered" }
  ];
  return (
    /* 与中心详情页的阶段条是同一个样子（.flow）—— 同一种"走到哪了"，一种画法。 */
    <ol className="flow" data-testid="visit-steps">
      {steps.map(x => (
        <li key={x.label} className={x.done ? "past" : x.now ? "now" : ""}>
          <span aria-hidden="true">{x.done ? "✓" : "·"}</span> {x.label}
        </li>
      ))}
    </ol>
  );
}

/* ── 下一件 ────────────────────────────────────────────────────────────
   办完一件，下一件是什么 —— 不用回首页再找一遍。取的是同一份待办
   （/v1/me/inbox），排除眼前这一条。访视状态一变就重取：刚完成的那次
   访视会从「访视」变成「PI 签字 / EDC」两条，下一件可能就是它自己的下一步。 */
function NextUp({ here, status, edc }: { here: string; status: string; edc: string }) {
  const [next, setNext] = useState<InboxItem | null | undefined>(undefined);
  useEffect(() => {
    call<Inbox>("getMyInbox")
      .then(b => setNext(b.items.find(i => i.ref.id !== here) ?? null))
      .catch(() => setNext(undefined));   // 离线：不给这一块，不报错
  }, [here, status, edc]);
  if (next === undefined) return null;
  return (
    <div className="spread" data-testid="next-up" style={{ marginTop: 6, gap: 10, flexWrap: "wrap" }}>
      <Link to="/today" className="btn" style={{ textDecoration: "none" }}>回到今天</Link>
      {next
        ? <Link to={KIND[next.kind].href(next)} className="btn primary" data-testid="next-go"
            style={{ textDecoration: "none" }}>
            {/* 标题里已经带着类别名的（「SAE 未上报 · …」）不再重复一遍 */}
            下一件：{next.title.startsWith(KIND[next.kind].label) ? next.title
              : `${KIND[next.kind].label} · ${next.title}`} →
          </Link>
        : <span className="muted">待办都清了。</span>}
    </div>
  );
}
