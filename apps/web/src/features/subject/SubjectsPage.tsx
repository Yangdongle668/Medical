import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useToast } from "@sitedesk/ui/react";
import { WITHDRAW_REASONS } from "@sitedesk/contracts";
import { call, ApiError, type ProblemDetails } from "../../api/client.js";
import { loadMe } from "../login/me.js";
import {
  listSubjects, STATE_LABEL, OPEN_STATES, anonymous, type Subject
} from "./api.js";
/* 脱落原因的中文名与筛选漏斗那一页共用一份 —— 各写一份的话，
   同一个 `adverse_event` 会在两页上叫两个名字。 */
import { WITHDRAW_LABEL } from "../enrollment/api.js";

/* ════════════════════════════════════════════════════════════════════
   受试者访视窗口。

   ── 它和「今天」那一页不是一回事 ──────────────────────────────────
   「今天」一行一次**访视**：今天要做的那几件事。
   这一页一行一个**人**：他现在到哪一步了、下一次什么时候、还差几次。

   同一批数据，两种切法，回答的是两个问题：
   前者是"今天干什么"，后者是"这个人怎么样了"。
   一线每天用前者，被问到"某某某现在什么情况"时用后者。

   ── 超窗排最前 ────────────────────────────────────────────────────
   窗口关了还没做的访视，每多一天都在往方案偏离上走。
   按筛选号排的表看不出这件事，而它是这一页唯一的紧急信号。
   ════════════════════════════════════════════════════════════════════ */

export function SubjectsPage() {
  const [subs, setSubs] = useState<Subject[] | null>(null);
  const [openOnly, setOpenOnly] = useState(true);
  const [canWrite, setCanWrite] = useState(false);
  /** 正在给谁登记脱落。**行内，不弹层** —— 填的时候要看得见
   *  他做到第几次访视了，那正是这一步的收入口径。 */
  const [wdOn, setWdOn] = useState<Subject | null>(null);
  const [wdReason, setWdReason] = useState("");
  const [wdOn2, setWdOn2] = useState("");
  const [wdNote, setWdNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const say = useToast();

  const load = useCallback(() => {
    void listSubjects(openOnly ? { state: OPEN_STATES } : {}).then(r => setSubs(r.items));
  }, [openOnly]);
  useEffect(load, [load]);

  useEffect(() => {
    void loadMe()
      .then(m => setCanWrite(m.permissions.actions.includes("subjWrite")))
      .catch(() => setCanWrite(false));
  }, []);

  /** 登记脱落。**两件事同时发生，都要在按下去之前说清楚**：
   *  收入按已完成访视比例计（不按整例），剩余未完成的访视一并作废 ——
   *  不作废的话这一例会永远刷红超窗。 */
  const withdraw = async () => {
    if (!wdOn) return;
    setBusy(true); setProblem(null);
    try {
      const r = await call<{ sideEffects: { summary: string }[] }>("withdrawSubject", {
        params: { id: wdOn.id },
        body: { reason: wdReason, withdrawnOn: wdOn2, note: wdNote.trim() }
      });
      load();
      setWdOn(null); setWdReason(""); setWdOn2(""); setWdNote("");
      say(r.sideEffects[0]?.summary ?? "已登记脱落");
    } catch (e) {
      if (e instanceof ApiError) setProblem(e.problem); else throw e;
    } finally { setBusy(false); }
  };

  if (!subs) return <p className="muted">加载中…</p>;

  const masked = subs.length > 0 && subs.every(anonymous);
  const late = subs.filter(s => s.nextVisit?.outOfWindow);
  const dueSoon = subs.filter(s =>
    s.nextVisit && !s.nextVisit.outOfWindow && s.nextVisit.daysLeft <= 3);

  return (
    <>
      <div className="page-head">
        <h2>受试者访视窗口</h2>
        <p data-testid="subj-summary">
          {subs.length} 人。
          {late.length > 0 && <> <b>{late.length} 人的下一次访视已超窗</b>。</>}
          {dueSoon.length > 0 && <> {dueSoon.length} 人三天内到期。</>}
        </p>
      </div>

      {masked && (
        <div className="problem" data-testid="subj-masked" style={{ marginBottom: 14 }}>
          你的角色看得到「这个中心有几例在组」，看不到<b>是哪几例</b>。
          下面这张表里没有筛选号那一列 —— 不是没查到，是后端把它删掉了（I10）。
        </div>
      )}

      {late.length > 0 && (
        <div className="problem" style={{ marginBottom: 14 }} role="status">
          超窗的访视每多一天都在往方案偏离上走。超窗完成时要填原因，
          它会原样进入质量台账 —— 所以<b>先做，别先补记录</b>。
        </div>
      )}

      <label className="row" style={{ gap: 6, marginBottom: 12, alignItems: "center" }}>
        <input type="checkbox" style={{ width: "auto" }} checked={openOnly}
          data-testid="open-only" onChange={e => setOpenOnly(e.target.checked)} />
        <span>只看还在流程里的（预筛 / 筛选中 / 已入组）</span>
      </label>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {!masked && <th>筛选号</th>}
              <th>中心</th><th>状态</th><th>进度</th>
              <th>下一次访视</th><th>窗口</th><th>CRC</th><th />
            </tr>
          </thead>
          <tbody>
            {[...subs]
              /* 超窗的最前，然后按剩余天数升序；没有下一次访视的排最后 ——
                 他们已经出组或筛败了，不需要盯。 */
              .sort((a, b) => rank(a) - rank(b))
              .map(s => (
                <tr key={s.id} data-testid="subject-row">
                  {!masked && <td className="mono">{s.screeningNo ?? "—"}</td>}
                  <td className="mono">{s.siteCode}</td>
                  <td>
                    <span className={`chip ${s.state === "enrolled" ? "good"
                      : ["screen_failed", "withdrawn"].includes(s.state) ? "flat" : "warn"}`}>
                      {STATE_LABEL[s.state] ?? s.state}
                    </span>
                    {s.randomized && <span className="muted" style={{ marginLeft: 6 }}>
                      {s.randomizationNo ?? "已随机"}
                    </span>}
                  </td>
                  <td className="num">
                    {s.visitsDone}/{s.visitsPlanned}
                  </td>
                  <td>{s.nextVisit?.visitLabel ?? <span className="muted">—</span>}</td>
                  <td>{windowChip(s)}</td>
                  <td className="muted">{s.crcName ?? "—"}</td>
                  <td>
                    <span className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                      {s.nextVisit && (
                        <Link to={`/visits/${s.nextVisit.id}`} className="btn go"
                          style={{ marginLeft: 0 }}>打开</Link>
                      )}
                      {/* 登记脱落。只给还在流程里的那几个 ——
                          已经筛败或已脱落的人没有"脱落"这一步。 */}
                      {canWrite && OPEN_STATES.includes(s.state) && (
                        <button className="btn link" data-testid={`wd-${s.id}`}
                          onClick={() => {
                            setWdOn(s); setWdReason(""); setWdNote("");
                            setWdOn2(""); setProblem(null);
                          }}>登记脱落</button>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {/* ── 登记脱落 ─────────────────────────────────────────────────
          这一步有两个不显形的后果，都要在按下去之前说出来：
          ① 收入按**已完成访视比例**计，不按整例（I8'）；
          ② 剩余未完成的访视**一并作废** —— 不作废的话，
             这一例会永远刷红超窗，而超窗每天都在往方案偏离上走。 */}
      {wdOn && (
        <section className="card" data-testid="wd-form" style={{ marginTop: 18 }}>
          <div className="card-h">
            <h3>登记脱落</h3>
            <span className="sub">
              {wdOn.screeningNo ?? "受试者"} · {wdOn.siteCode} ·
              已完成 {wdOn.visitsDone}/{wdOn.visitsPlanned} 次访视
            </span>
            <span className="sp" />
            <button className="btn link" onClick={() => setWdOn(null)}>取消</button>
          </div>
          <div className="card-b stack">
            {problem && (
              <div className="problem" data-testid="wd-problem">
                <strong>{problem.title}</strong>
                {problem.detail && <div>{problem.detail}</div>}
              </div>
            )}
            <div className="grid-form">
              <label className="field">
                <span>脱落原因</span>
                <select value={wdReason} data-testid="wd-reason"
                  onChange={e => setWdReason(e.target.value)}>
                  <option value="">— 选一个 —</option>
                  {WITHDRAW_REASONS.map(r => (
                    <option key={r} value={r}>{WITHDRAW_LABEL[r] ?? r}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>脱落日期</span>
                <input type="date" value={wdOn2} data-testid="wd-date"
                  onChange={e => setWdOn2(e.target.value)} />
              </label>
            </div>
            <label className="field">
              <span>说明 <span className="t-mut">· 至少 4 字</span></span>
              <textarea rows={2} value={wdNote} data-testid="wd-note"
                placeholder="例：受试者第 3 周期出现 III 度肝损伤，研究者判断需终止治疗，已完成末次安全性随访。"
                onChange={e => setWdNote(e.target.value)} />
            </label>
            <div className="derive" data-testid="wd-consequence">
              <b>这一下有两个后果，都不显形：</b>
              <br />
              ① 这一例的收入按<b>已完成访视比例</b>计 ——
              {wdOn.visitsPlanned > 0 && <>
                {" "}也就是 {wdOn.visitsDone}/{wdOn.visitsPlanned}，
                不是整例。
              </>}
              <br />
              ② 剩余 <b>{Math.max(0, wdOn.visitsPlanned - wdOn.visitsDone)}</b> 次
              未完成的访视<b>一并作废</b> —— 不作废的话，
              这一例会永远刷红超窗，而超窗每天都在往方案偏离上走。
            </div>
            <div className="row">
              <button className="btn btn-p" data-testid="wd-submit"
                disabled={busy || !wdReason || !wdOn2 || wdNote.trim().length < 4}
                onClick={() => void withdraw()}>
                {busy ? "登记中…" : "登记脱落"}
              </button>
            </div>
          </div>
        </section>
      )}

      <div className="derive" style={{ marginTop: 14 }}>
        这一页一行<b>一个人</b>；「今天」那一页一行<b>一次访视</b>。
        同一批数据两种切法，回答的是两个问题 ——
        每天干活看那一页，被问到「某某某现在什么情况」看这一页。
        <br />
        没有下一次访视的排在最后：他们已经出组或筛败了，不需要盯。
        <b>把他们混在中间</b>，会让"还剩几个人要跟"这个数用眼睛数不出来。
      </div>
    </>
  );
}

/** 排序权重：超窗 → 快到期 → 还早 → 没有下一次。 */
function rank(s: Subject): number {
  if (!s.nextVisit) return 1e6;
  return s.nextVisit.daysLeft;
}

function windowChip(s: Subject) {
  const v = s.nextVisit;
  if (!v) return <span className="muted">—</span>;
  if (v.outOfWindow) return <span className="chip crit">已超窗 {-v.daysLeft} 天</span>;
  if (v.daysLeft === 0) return <span className="chip crit">今天到期</span>;
  if (v.daysLeft <= 3) return <span className="chip warn">还剩 {v.daysLeft} 天</span>;
  return <span className="mono muted">{v.windowFrom} ~ {v.windowTo}</span>;
}
