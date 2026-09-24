import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useToast } from "@sitedesk/ui/react";
import { call, ApiError, type ProblemDetails } from "../../api/client.js";
import { loadMe } from "../login/me.js";
import {
  listSubjects, scheduleVisit, STATE_LABEL, OPEN_STATES, anonymous, type Subject
} from "./api.js";
import { UnmetList, type UnmetItem } from "../../shell/Unmet.js";
import { WithdrawForm } from "./WithdrawForm.js";
import { Why } from "../../shell/Why.js";
import { ExportButton } from "../../shell/ExportButton.js";
import type { CsvColumn } from "../../shell/csv.js";

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

/** 导出的列。筛选号受列权限管：没权限的人拿到的行里没有这个字段，这一列就是空的。 */
const EXPORT_COLS: CsvColumn<Subject>[] = [
  { label: "筛选号", value: s => s.screeningNo },
  { label: "中心", value: s => s.siteCode },
  { label: "状态", value: s => STATE_LABEL[s.state] ?? s.state },
  { label: "随机号", value: s => s.randomizationNo },
  { label: "知情签署日", value: s => s.icfSignedOn },
  { label: "入组日", value: s => s.enrolledOn },
  { label: "出组日", value: s => s.exitedOn },
  { label: "已完成访视", value: s => s.visitsDone },
  { label: "计划访视", value: s => s.visitsPlanned },
  { label: "下一次访视", value: s => s.nextVisit?.visitLabel },
  { label: "窗口开始", value: s => s.nextVisit?.windowFrom },
  { label: "窗口结束", value: s => s.nextVisit?.windowTo },
  { label: "剩余天数", value: s => s.nextVisit?.daysLeft },
  { label: "已超窗", value: s => s.nextVisit ? s.nextVisit.outOfWindow : null },
  { label: "CRC", value: s => s.crcName }
];

/** 嵌在中心工作台的页签里时给 —— 只看这一个中心。独立页面（侧栏进来的）不给，看全部。 */
export function SubjectsPage({ studySiteId }: { studySiteId?: string } = {}) {
  const [subs, setSubs] = useState<Subject[] | null>(null);
  const [openOnly, setOpenOnly] = useState(true);
  const [canWrite, setCanWrite] = useState(false);
  /** 正在给谁登记脱落。**行内，不弹层** —— 填的时候要看得见
   *  他做到第几次访视了，那正是这一步的收入口径。 */
  const [wdOn, setWdOn] = useState<Subject | null>(null);
  const [busy, setBusy] = useState(false);
  /** 补排访视失败时说的话。**和脱落那个分开** —— 脱落的错误画在
   *  脱落表单（WithdrawForm）里面，表单没开的时候写进去等于没写：
   *  按钮点下去、什么也不发生、控制台一条错误都没有。
   *  一个按得动而必定失败的控件，比没有这个控件更糟。 */
  const [schedProblem, setSchedProblem] = useState<ProblemDetails | null>(null);
  const say = useToast();

  /** 列表与导出用同一组条件 —— 导出的就是这一页在看的那批人 */
  const query = {
    ...(openOnly ? { state: OPEN_STATES } : {}),
    ...(studySiteId ? { studySiteId } : {})
  };
  const load = useCallback(() => {
    void listSubjects({
      ...(openOnly ? { state: OPEN_STATES } : {}),
      ...(studySiteId ? { studySiteId } : {})
    }).then(r => setSubs(r.items));
  }, [openOnly, studySiteId]);
  useEffect(load, [load]);

  useEffect(() => {
    void loadMe()
      .then(m => setCanWrite(m.permissions.actions.includes("subjWrite")))
      .catch(() => setCanWrite(false));
  }, []);

  /** 补排访视。**这一格此前只有一句话，没有按钮。**
   *
   *  现场报来的原话：「显示访视没有排出来，但是我没有看到排访视的功能」——
   *  说得对：在此之前访视只有两个出生口（签知情排第 0 次、完成一次排下一次），
   *  两个都堵上时，界面上没有任何办法给这一例排出访视来。
   *  而入组要求第 0 次已登记 PI 确认，于是这一例除了筛败 / 脱落没有出路。
   *
   *  **排哪一次不由这里算** —— 服务端按 SOA 找出该排的下一次。
   *  界面自己算的话，界面就得有一份 SOA 的规则，而那正是两份各走各的开始。 */
  const schedule = async (s: Subject) => {
    setBusy(true); setSchedProblem(null);
    try {
      const r = await scheduleVisit(s.id);
      load();
      say(r.sideEffects[0]?.summary ?? `已补排 ${r.data.visitLabel}`);
    } catch (e) {
      if (e instanceof ApiError) setSchedProblem(e.problem); else throw e;
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
        <div className="spread">
          <h2>受试者访视窗口</h2>
          <ExportButton op="listSubjects" query={query} columns={EXPORT_COLS}
            list="subjects" name="受试者" studySiteId={studySiteId ?? null} />
        </div>
        <p data-testid="subj-summary">
          {subs.length} 人。
          {late.length > 0 && <> <b>{late.length} 人的下一次访视已超窗</b>。</>}
          {dueSoon.length > 0 && <> {dueSoon.length} 人三天内到期。</>}
        </p>
      </div>

      {masked && (
        <div className="problem" data-testid="subj-masked" style={{ marginBottom: 14 }}>
          你的角色只看得到例数，看不到具体是哪几例，所以表里没有筛选号一列。
        </div>
      )}

      {late.length > 0 && (
        <div className="problem" style={{ marginBottom: 14 }} role="status">
          超窗的已排在最前。<b>先把访视做了</b>，完成时再填超窗原因。
        </div>
      )}

      {/* 补排访视被拦下来的时候说得出为什么，**并且给得出去处** ——
          最常见的一条是"这个项目还没配 SOA"，而 SOA 在「立项与建档」那一页。
          链接由 UnmetList 按服务端给的 module 自动出（见 shell/Unmet.tsx）。 */}
      {schedProblem && (
        <div className="problem stack" data-testid="sched-problem"
          style={{ marginBottom: 14 }}>
          <strong>{schedProblem.title}</strong>
          {schedProblem.detail && <div>{schedProblem.detail}</div>}
          {Array.isArray(schedProblem.unmet) && (
            <UnmetList items={schedProblem.unmet as UnmetItem[]} testid="sched-unmet" />
          )}
        </div>
      )}

      <label className="row" style={{ gap: 6, marginBottom: 12, alignItems: "center" }}>
        <input type="checkbox" style={{ width: "auto" }} checked={openOnly}
          data-testid="open-only" onChange={e => setOpenOnly(e.target.checked)} />
        <span>只看还在流程里的（预筛 / 筛选中 / 已入组）</span>
      </label>

      {/* 手机上一行变一张卡片（.cards-sm，见 styles.css）—— 八列的表在 390px 上要横着滚，
          而这一页是「被问到某某某怎么样了」时拿出手机看的 */}
      <div className="table-wrap cards-sm">
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
                  {/* 点筛选号进这个人的详情 —— 「某某某现在什么情况」在那一页答 */}
                  {!masked && <td className="mono card-title" data-label="筛选号">
                    <Link to={`/subjects/${s.id}`} data-testid={`subject-open-${s.id}`}>
                      {s.screeningNo ?? "—"}</Link>
                  </td>}
                  <td className="mono" data-label="中心">{s.siteCode}</td>
                  <td data-label="状态">
                    <span className={`chip ${s.state === "enrolled" ? "good"
                      : ["screen_failed", "withdrawn"].includes(s.state) ? "flat" : "warn"}`}>
                      {STATE_LABEL[s.state] ?? s.state}
                    </span>
                    {s.randomized && <span className="muted" style={{ marginLeft: 6 }}>
                      {s.randomizationNo ?? "已随机"}
                    </span>}
                  </td>
                  <td className="num" data-label="进度">
                    {s.visitsDone}/{s.visitsPlanned}
                  </td>
                  {/* 下一次访视。**排不出来的时候要说话，而且要给得动手** ——
                      现场报来的两句原话，一句接一句：
                        「页面没有可以操作的按钮，只有一个脱落」
                        「显示访视没有排出来，但是我没有看到排访视的功能」
                      第一句补出了这个角标，而第二句说的是：一个只报告问题、
                      不给办法的角标，只是把"无事可做"换了个说法。
                      按钮在最后那一格（`sched-*`）。

                      **只对「筛选中」说这句。** 预筛还没签知情，本来就没有访视；
                      已入组而没有下一次，多半是 SOA 走到头了 —— 那是正常收尾，
                      对它喊"没排出来"是一句假警报，而假警报会让真的那句也没人看。
                      筛选中不一样：签知情那一下一定会排出筛选期访视，
                      没有就是出了事。 */}
                  <td data-label="下一次访视">{s.nextVisit?.visitLabel ?? (
                    s.state === "screening"
                      ? <span className="chip warn" data-testid={`no-visit-${s.id}`}
                          title={"签署知情同意时会连筛选期访视一起排出来。这一例没有，" +
                            "多半是当时这个项目还没配访视计划（SOA）。" +
                            "右边「补排访视」按 SOA 把它排出来；" +
                            "如果连 SOA 都没有，先去「立项与建档」配上那一行"}>
                          访视没排出来
                        </span>
                      : <span className="muted">—</span>
                  )}</td>
                  <td data-label="窗口">{windowChip(s)}</td>
                  <td className="muted" data-label="CRC">{s.crcName ?? "—"}</td>
                  <td className="card-actions">
                    <span className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                      {s.nextVisit && (
                        <Link to={`/visits/${s.nextVisit.id}`} className="btn go"
                          style={{ marginLeft: 0 }}>打开</Link>
                      )}
                      {/* 补排访视 —— **没有下一次访视的那几行，这是他们的出路**。
                          给筛选中与已入组两种：前者是"筛选期访视没排出来"，
                          后者是"方案修订把 SOA 加长了，而下一次是在完成上一次
                          那一刻排的，那时新的 seq 还不存在"——
                          后一种在临床里很常见，而它此前同样没有任何入口。
                          排哪一次由服务端按 SOA 定，这里只发"给他补排"。 */}
                      {canWrite && !s.nextVisit
                        && ["screening", "enrolled"].includes(s.state) && (
                        <button className="btn primary" data-testid={`sched-${s.id}`}
                          disabled={busy} onClick={() => void schedule(s)}>补排访视</button>
                      )}
                      {/* 登记脱落。只给还在流程里的那几个 ——
                          已经筛败或已脱落的人没有"脱落"这一步。 */}
                      {canWrite && OPEN_STATES.includes(s.state) && (
                        <button className="btn link" data-testid={`wd-${s.id}`}
                          onClick={() => setWdOn(s)}>登记脱落</button>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {wdOn && (
        <WithdrawForm key={wdOn.id} subject={wdOn} onCancel={() => setWdOn(null)}
          onDone={summary => { load(); setWdOn(null); say(summary); }} />
      )}

      <Why style={{ marginTop: 14 }}>
        这一页一行<b>一个人</b>；「今天」那一页一行<b>一次访视</b>。
        同一批数据两种切法，回答的是两个问题 ——
        每天干活看那一页，被问到「某某某现在什么情况」看这一页。
        <br />
        已经出组或筛败的排在最后：他们没有下一步，不需要盯。
        <b>把他们混在中间</b>，会让「还剩几个人要跟」这个数用眼睛数不出来。
        <br />
        <b>筛选中而没有访视的排在最前</b> —— 那不是走完了，是卡住了：
        签了知情、访视没排出来、入不了组，而筛选期每天都在过去。
        右边「补排访视」按访视计划表把它排出来。
      </Why>
    </>
  );
}

/** 排序权重：**卡住的 → 超窗 → 快到期 → 还早 → 出组的**。
 *
 *  ── 「没有下一次访视」原来是一个档，其实是两个 ──────────────────────
 *  原来这里一句 `if (!s.nextVisit) return 1e6`，把所有没有下一次访视的人
 *  一律沉到最底下，理由写着"他们已经出组或筛败了，不需要盯"。
 *
 *  那句话对**筛败 / 脱落 / 出组**是对的，对**筛选中而没有访视**是错的：
 *  后者不是走完了，是**卡住了** —— 签了知情、访视没排出来、入不了组，
 *  而他每多待一天，筛选期就多过去一天。他是这张表上最该先办的一行，
 *  却被排到了已经结束的人后面。
 *
 *  这条是 e2e 撞出来的：新加了一行这种状态之后，「最后一行应该是筛败那位」
 *  当场变红 —— 红得对，它指的不是断言过时，是这个档分错了。 */
function rank(s: Subject): number {
  /* 卡住的排最前，比超窗还靠前 —— 超窗的至少还有一次访视可以去做，
     这一位连能做的事都没有，得先把访视补出来。 */
  if (!s.nextVisit) return s.state === "screening" ? -1e6 : 1e6;
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
