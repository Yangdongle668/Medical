import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { call } from "../../api/client.js";
import { today } from "../../shell/dates.js";

/* ════════════════════════════════════════════════════════════════════
   我的日程。

   ── 它和「今天」的区别是**时间跨度** ──────────────────────────────
   「今天」回答"现在做什么"，一行一次访视，按窗口关闭日排。
   这一页回答"接下来两周会不会撞车" —— 按天铺开，一天一格。

   ── 撞车是这一页存在的理由 ────────────────────────────────────────
   一个 CRC 一天做三次访视，每次两小时，中间还要跨医院 —— 那是排不出来的。
   而按列表排的表看不出这件事：三行分别在第 4、11、17 行，
   中间隔着别人的访视。**只有按天分组才看得出"这一天太满了"。**

   所以这一页不做筛选、不做排序选项：它只有一种看法，
   而那种看法回答一个问题。
   ════════════════════════════════════════════════════════════════════ */

interface Visit {
  id: string; screeningNo?: string; siteCode: string;
  visitLabel: string; targetDate: string; windowFrom: string; windowTo: string;
  daysLeft: number | null; outOfWindow: boolean; status: string;
  tasks: { seq: number; task: string; doneAt: string | null }[];
}

/** 一天排几次算满。**不是拍的**：一次肿瘤访视含采血、给药、评估，
 *  加上路上，两次是常态，三次就要看是不是同一家医院。 */
const CROWDED = 3;

const addDays = (iso: string, n: number) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];
const weekday = (iso: string) => WEEKDAY[new Date(iso + "T00:00:00Z").getUTCDay()]!;

export function SchedulePage() {
  const [visits, setVisits] = useState<Visit[] | null>(null);
  const [span, setSpan] = useState(14);

  useEffect(() => {
    /* 只取还没做的 —— 已完成的访视不占未来的时间。
       和「今天」那一页同一条：**在服务端筛，不在这里筛**。 */
    void call<{ items: Visit[] }>("listSubjectVisits",
      { query: { limit: 200, status: "planned" } })
      .then(r => setVisits(r.items));
  }, []);

  if (!visits) return <p className="muted">加载中…</p>;

  const from = today();
  const to = addDays(from, span - 1);
  /* 窗口跨过某一天就算那一天可做。**不用 targetDate 一个点**：
     访视有窗口，把它钉在目标日上会让"这周哪天有空"变成假的 ——
     实际上它可以往前后挪几天，而那正是排期时唯一的余地。 */
  const days = Array.from({ length: span }, (_, i) => addDays(from, i));
  const onDay = (d: string) => visits.filter(v => v.windowFrom <= d && d <= v.windowTo);

  /* 已经超窗的不属于任何一天 —— 它们的窗口在过去。单独顶出来。 */
  const late = visits.filter(v => v.windowTo < from);
  const beyond = visits.filter(v => v.windowFrom > to);
  const crowded = days.filter(d => onDay(d).length >= CROWDED);

  return (
    <>
      <div className="page-head">
        <h2>我的日程</h2>
        <p data-testid="sched-summary">
          未来 {span} 天。
          {crowded.length > 0
            ? <> <b>{crowded.length} 天排得过满</b>（一天 {CROWDED} 次以上）。</>
            : " 没有一天排得过满。"}
          {beyond.length > 0 && <span className="muted"> 另有 {beyond.length} 次在这之后。</span>}
        </p>
      </div>

      {late.length > 0 && (
        <div className="problem" role="alert" data-testid="sched-late" style={{ marginBottom: 14 }}>
          <strong>{late.length} 次访视的窗口已经关了。</strong>
          <div className="muted">
            它们不在下面这张日程里 —— <b>过去没有可排的日子</b>。
            超窗完成会自动生成方案偏离，提交时要填原因。先去「今天」处理它们。
          </div>
        </div>
      )}

      <div className="row" style={{ gap: 6, marginBottom: 14 }}>
        {[7, 14, 28].map(n => (
          <button key={n} className={`btn ${span === n ? "primary" : ""}`}
            data-testid={`span-${n}`} onClick={() => setSpan(n)}>{n} 天</button>
        ))}
      </div>

      <div className="stack" data-testid="sched-days">
        {days.map(d => {
          const list = onDay(d);
          const isToday = d === from;
          if (!list.length) return (
            <div key={d} className="row" data-testid="sched-day"
              style={{ gap: 10, alignItems: "baseline", opacity: .45 }}>
              <span className="mono" style={{ width: 96 }}>
                {d.slice(5)} 周{weekday(d)}{isToday && " · 今天"}
              </span>
              <span className="muted">—</span>
            </div>
          );
          return (
            <div className="card stack" key={d} data-testid="sched-day"
              style={list.length >= CROWDED
                ? { borderColor: "var(--crit, #c0392b)" } : undefined}>
              <div className="spread">
                <h3 style={{ fontSize: 14 }}>
                  <span className="mono">{d.slice(5)}</span> 周{weekday(d)}
                  {isToday && <span className="chip warn" style={{ marginLeft: 8 }}>今天</span>}
                </h3>
                <span className={`chip ${list.length >= CROWDED ? "crit" : "flat"}`}>
                  {list.length} 次可做
                </span>
              </div>

              {list.length >= CROWDED && (
                <p className="muted" style={{ margin: 0 }} data-testid="crowded">
                  这一天窗口里落了 {list.length} 次访视，涉及{" "}
                  {new Set(list.map(v => v.siteCode)).size} 个中心。
                  <b>访视有窗口，可以往前后挪</b> —— 现在挪比当天挪容易。
                </p>
              )}

              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>受试者</th><th>中心</th><th>访视</th>
                      <th>窗口</th><th className="num">任务</th><th /></tr>
                  </thead>
                  <tbody>
                    {list.map(v => (
                      <tr key={v.id} data-testid="sched-visit">
                        <td className="mono">{v.screeningNo ?? "—"}</td>
                        <td className="mono">{v.siteCode}</td>
                        <td>{v.visitLabel}</td>
                        <td className="mono muted">{v.windowFrom} ~ {v.windowTo}</td>
                        <td className="num">
                          {v.tasks.filter(t => t.doneAt).length}/{v.tasks.length}
                        </td>
                        <td>
                          <Link to={`/visits/${v.id}`} className="btn"
                            style={{ textDecoration: "none", display: "inline-block" }}>打开</Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}
      </div>

      <div className="derive" style={{ marginTop: 14 }}>
        一次访视<b>落在它的整个窗口里</b>，不是钉在目标日那一天 ——
        把它钉死会让"这周哪天有空"变成假的，而窗口正是排期时唯一的余地。
        所以同一次访视会出现在连续的好几天里：那不是重复，
        是"这几天都做得了"。
        <br />
        一天 {CROWDED} 次以上标红。这个数不是拍的：一次肿瘤访视含采血、
        给药、评估，加上路上，两次是常态，三次就要看是不是同一家医院。
        <br />
        <b>监查访视还没进来</b> —— 那要「监查访视」那个模块的后端，
        现在这一页只有受试者访视。
      </div>
    </>
  );
}
