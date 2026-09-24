import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { call } from "../../api/client.js";
import { today } from "../../shell/dates.js";
import { Why } from "../../shell/Why.js";
import { loadMe } from "../login/me.js";
import { PlanVisitForm, type SiteOption } from "../oversight/PlanVisitForm.js";

/* ════════════════════════════════════════════════════════════════════
   我的日程。

   ── 它和「今天」的区别是**时间跨度** ──────────────────────────────
   「今天」回答"现在做什么"，一行一次访视，按窗口关闭日排。
   这一页回答"接下来两周会不会撞车" —— 按天铺开，一天一格。

   ── 撞车是这一页存在的理由 ────────────────────────────────────────
   一个 CRC 一天做三次访视，每次两小时，中间还要跨医院 —— 那是排不出来的。
   而按列表排的表看不出这件事：三行分别在第 4、11、17 行，
   中间隔着别人的访视。**只有按天分组才看得出"这一天太满了"。**

   所以这一页不做筛选、不做排序选项。两种铺法回答同一个问题：
   「列表」按天往下排（手机上好看），「月」一格一天（看一个月的疏密）。

   ── 监查员的日程是监查访视 ───────────────────────────────────────
   CRA 的一周排的是「周二去 SS-07、周四去 SS-01」—— 原来这一页只有受试者访视，
   他的行程要去「监查访视」那一页看，而那一页是按中心排的，看不出两趟撞了没有。
   现在监查员本人的监查访视也铺在日程上（一趟占它的整个天数），
   两趟落在同一天标红；在月历上点一天，可以直接排一趟。
   ════════════════════════════════════════════════════════════════════ */

interface Visit {
  id: string; screeningNo?: string; siteCode: string;
  visitLabel: string; targetDate: string; windowFrom: string; windowTo: string;
  daysLeft: number | null; outOfWindow: boolean; status: string;
  tasks: { seq: number; task: string; doneAt: string | null }[];
}
/** 监查访视（本人的）。一趟占 plannedOn 起的 days 天。 */
interface Trip {
  id: string; code: string; siteCode: string; hospital: string;
  plannedOn: string; days: number; state: string;
}

const CROWDED = 3;

const addDays = (iso: string, n: number) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];
const weekday = (iso: string) => WEEKDAY[new Date(iso + "T00:00:00Z").getUTCDay()]!;
/** 某月的第一天（offset = 0 是本月）。 */
const monthStart = (base: string, offset: number) => {
  const d = new Date(base.slice(0, 7) + "-01T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + offset);
  return d.toISOString().slice(0, 10);
};
const monthEnd = (first: string) => addDays(monthStart(first, 1), -1);
const TRIP_STATE: Record<string, string> = {
  proposed: "待确认", scheduled: "已排期", done: "已到现场", reported: "报告已交"
};

export function SchedulePage() {
  const [visits, setVisits] = useState<Visit[] | null>(null);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [view, setView] = useState<"list" | "month">("list");
  const [span, setSpan] = useState(14);
  const [month, setMonth] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [planSites, setPlanSites] = useState<SiteOption[] | null>(null);

  const from = today();
  const first = monthStart(from, month);
  /* 取到这一屏最后一天为止窗口已经打开的 —— 与「今天」同一个参数。
     原来是未完成访视的前 200 条、与日期无关，远期的会把近期的挤出去。 */
  const until = view === "list" ? addDays(from, span - 1) : monthEnd(first);

  const load = () => {
    void call<{ items: Visit[] }>("listSubjectVisits",
      { query: { limit: 200, status: "planned", windowOpensBy: until } })
      .then(r => setVisits(r.items));
    void call<{ items: Trip[] }>("listMonitorVisits",
      { query: { limit: 200, mine: true, openOnly: true } })
      .then(r => setTrips(r.items)).catch(() => setTrips([]));
  };
  useEffect(load, [until]);

  /* 有 monitor 动作的人，月历上点一天可以直接排一趟监查 */
  useEffect(() => {
    void loadMe().then(m => {
      if (!m.permissions.actions.includes("monitor")) return;
      return call<{ sites: SiteOption[] }>("getMonitorBoard", {}).then(b => setPlanSites(b.sites));
    }).catch(() => setPlanSites(null));
  }, []);

  if (!visits) return <p className="muted">加载中…</p>;

  const to = addDays(from, span - 1);
  /* 一次访视落在它**整个窗口**里，而不是钉在目标日上（见下面「为什么？」） */
  const onDay = (d: string) => visits.filter(v => v.windowFrom <= d && d <= v.windowTo);
  const tripsOn = (d: string) => trips.filter(t => t.plannedOn <= d && d <= addDays(t.plannedOn, t.days - 1));

  const late = visits.filter(v => v.windowTo < from);
  const days = Array.from({ length: span }, (_, i) => addDays(from, i));
  const beyond = visits.filter(v => v.windowFrom > to);
  /* 摘要说的是**眼下铺开的这一段**：列表是未来 N 天，月是这个月里还没过去的日子 */
  const monthDays = Array.from({ length: Number(monthEnd(first).slice(8)) }, (_, i) => addDays(first, i))
    .filter(d => d >= from);
  const shown = view === "list" ? days : monthDays;
  const crowded = shown.filter(d => onDay(d).length >= CROWDED);
  const clash = shown.filter(d => tripsOn(d).length > 1);

  return (
    <>
      <div className="page-head">
        <h2>我的日程</h2>
        <p data-testid="sched-summary">
          {view === "list" ? `未来 ${span} 天。`
            : `${Number(first.slice(5, 7))} 月${monthDays.length ? `还剩 ${monthDays.length} 天` : "已经过去"}。`}
          {crowded.length > 0
            ? <> <b>{crowded.length} 天排得过满</b>（一天 {CROWDED} 次以上）。</>
            : " 没有一天排得过满。"}
          {clash.length > 0 && <> <b>{clash.length} 天两趟监查撞在一起</b>。</>}
          {trips.length > 0 && <> 你的监查访视 {trips.length} 趟。</>}
          {beyond.length > 0 && view === "list" &&
            <span className="muted"> 另有 {beyond.length} 次在这之后。</span>}
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

      <div className="row" style={{ gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
        <div className="seg" role="group" aria-label="怎么铺">
          <button aria-pressed={view === "list"} data-testid="view-list"
            onClick={() => setView("list")}>列表</button>
          <button aria-pressed={view === "month"} data-testid="view-month"
            onClick={() => setView("month")}>月</button>
        </div>
        {view === "list" ? (
          <div className="row" style={{ gap: 6 }}>
            {[7, 14, 28].map(n => (
              <button key={n} className={`btn ${span === n ? "primary" : ""}`}
                data-testid={`span-${n}`} onClick={() => setSpan(n)}>{n} 天</button>
            ))}
          </div>
        ) : (
          <div className="row" style={{ gap: 6, alignItems: "center" }}>
            <button className="btn" data-testid="month-prev" onClick={() => setMonth(m => m - 1)}>‹</button>
            <b data-testid="month-label" style={{ minWidth: 90, textAlign: "center" }}>
              {first.slice(0, 4)} 年 {Number(first.slice(5, 7))} 月</b>
            <button className="btn" data-testid="month-next" onClick={() => setMonth(m => m + 1)}>›</button>
          </div>
        )}
      </div>

      {view === "list" ? (
        <div className="stack" data-testid="sched-days">
          {days.map(d => <DayCard key={d} d={d} isToday={d === from}
            list={onDay(d)} trips={tripsOn(d)} />)}
        </div>
      ) : (
        <>
          <MonthGrid first={first} todayIso={from} picked={picked} onPick={setPicked}
            count={d => onDay(d).length} tripsOn={tripsOn} />
          {picked && (
            <div className="stack" style={{ marginTop: 14 }} data-testid="month-picked">
              <DayCard d={picked} isToday={picked === from}
                list={onDay(picked)} trips={tripsOn(picked)} always />
              {planSites && planSites.length > 0 && picked >= from && (
                <PlanVisitForm key={picked} sites={planSites} defaultDate={picked} onCreated={load} />
              )}
            </div>
          )}
        </>
      )}

      <Why style={{ marginTop: 14 }}>
        一次访视<b>落在它的整个窗口里</b>，不是钉在目标日那一天 ——
        把它钉死会让"这周哪天有空"变成假的，而窗口正是排期时唯一的余地。
        所以同一次访视会出现在连续的好几天里：那不是重复，
        是"这几天都做得了"。
        <br />
        一天 {CROWDED} 次以上标红。这个数不是拍的：一次肿瘤访视含采血、
        给药、评估，加上路上，两次是常态，三次就要看是不是同一家医院。
        <br />
        监查访视只列<b>你本人</b>的，一趟占它的整个天数；两趟落在同一天标红 ——
        人只有一个，两家医院不可能同一天都去。
      </Why>
    </>
  );
}

/* ── 一天 ───────────────────────────────────────────────────────── */
function DayCard({ d, isToday, list, trips, always = false }: {
  d: string; isToday: boolean; list: Visit[]; trips: Trip[]; always?: boolean;
}) {
  if (!list.length && !trips.length && !always) return (
    <div className="row" data-testid="sched-day" style={{ gap: 10, alignItems: "baseline", opacity: .45 }}>
      <span className="mono" style={{ width: 96 }}>
        {d.slice(5)} 周{weekday(d)}{isToday && " · 今天"}
      </span>
      <span className="muted">—</span>
    </div>
  );
  const bad = list.length >= CROWDED || trips.length > 1;
  return (
    <div className="card stack" data-testid="sched-day"
      style={bad ? { borderColor: "var(--crit, #c0392b)" } : undefined}>
      <div className="spread">
        <h3 style={{ fontSize: 14 }}>
          <span className="mono">{d.slice(5)}</span> 周{weekday(d)}
          {isToday && <span className="chip warn" style={{ marginLeft: 8 }}>今天</span>}
        </h3>
        <span className={`chip ${list.length >= CROWDED ? "crit" : "flat"}`}>{list.length} 次可做</span>
      </div>

      {trips.map(t => (
        <div key={t.id} className="row" data-testid="sched-trip" style={{ gap: 8, alignItems: "center" }}>
          <span className={`chip ${trips.length > 1 ? "crit" : "warn"}`}>监查</span>
          <b className="mono">{t.siteCode}</b> <span>{t.hospital}</span>
          <span className="muted">· {TRIP_STATE[t.state] ?? t.state} · {t.days} 天</span>
          <Link to={`/monitoring`} className="muted" style={{ marginLeft: "auto" }}>{t.code}</Link>
        </div>
      ))}
      {trips.length > 1 && (
        <p className="muted" style={{ margin: 0 }} data-testid="trip-clash">
          <b>这一天排了 {trips.length} 趟监查</b> —— 人只有一个，得挪一趟。
        </p>
      )}

      {list.length >= CROWDED && (
        <p className="muted" style={{ margin: 0 }} data-testid="crowded">
          这一天窗口里落了 {list.length} 次访视，涉及{" "}
          {new Set(list.map(v => v.siteCode)).size} 个中心。
          <b>访视有窗口，可以往前后挪</b> —— 现在挪比当天挪容易。
        </p>
      )}

      {list.length > 0 && (
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
                  <td className="num">{v.tasks.filter(t => t.doneAt).length}/{v.tasks.length}</td>
                  <td>
                    <Link to={`/visits/${v.id}`} className="btn"
                      style={{ textDecoration: "none", display: "inline-block" }}>打开</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ── 一个月 ─────────────────────────────────────────────────────── */
function MonthGrid({ first, todayIso, picked, onPick, count, tripsOn }: {
  first: string; todayIso: string; picked: string | null; onPick: (d: string) => void;
  count: (d: string) => number; tripsOn: (d: string) => Trip[];
}) {
  /* 周一开头：一线排班按工作周想事情 */
  const lead = (new Date(first + "T00:00:00Z").getUTCDay() + 6) % 7;
  const last = monthEnd(first);
  const n = Number(last.slice(8, 10));
  const cells: (string | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: n }, (_, i) => addDays(first, i))
  ];
  while (cells.length % 7) cells.push(null);
  return (
    <div className="month" data-testid="month-grid">
      {["一", "二", "三", "四", "五", "六", "日"].map(w => <div key={w} className="month-h">{w}</div>)}
      {cells.map((d, i) => {
        if (!d) return <div key={i} className="month-cell blank" />;
        const c = count(d), t = tripsOn(d);
        const cls = ["month-cell",
          d === todayIso ? "is-today" : "", d === picked ? "is-picked" : "",
          d < todayIso ? "is-past" : ""].filter(Boolean).join(" ");
        return (
          <button key={d} type="button" className={cls} data-testid="month-day" data-date={d}
            onClick={() => onPick(d)}>
            <span className="month-n">{Number(d.slice(8))}</span>
            {c > 0 && <span className={`chip ${c >= CROWDED ? "crit" : "flat"}`}>{c} 次</span>}
            {t.map(x => (
              <span key={x.id} className={`chip ${t.length > 1 ? "crit" : "warn"} month-trip`}>{x.siteCode}</span>
            ))}
          </button>
        );
      })}
    </div>
  );
}
