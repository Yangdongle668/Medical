import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { call } from "../../api/client.js";
import { daysFromToday } from "../../shell/dates.js";

/* CRC 每天第一件事是看「今天谁到期」—— 所以这是首页，
   而且默认按窗口关闭日升序，超窗的排在最上面。 */

export interface Visit {
  id: string; screeningNo?: string; siteCode: string;
  visitLabel: string; targetDate: string; windowFrom: string; windowTo: string;
  actualDate?: string | null;
  daysLeft: number | null; outOfWindow: boolean; status: string;
  /** 录入 EDC 的状态。**完成访视和录进 EDC 是两件事** ——
   *  访视完成后 5 个工作日内录入才算及时，超时不阻断，但进及时率统计。 */
  edcStatus?: "pending" | "entered" | "queried";
  edcDaysLate?: number | null;
  /** PI 签字确认的日期。**为空就是还没登记** —— 它是 locked 的充要条件。 */
  piConfirmedAt?: string | null;
  /** 在本系统里点下确认的那个人。**为空是常态**：PI 多数时候没有账号，
   *  确认由一线登记，那时这一栏空着而审计轨迹里有登记人。见迁移 0050。 */
  piConfirmedByName?: string | null;
  tasks: { seq: number; task: string; doneAt: string | null }[];
}

function windowChip(v: Visit) {
  /* 「待**登记** PI 确认」—— 一个字之差，但它决定人会不会去等。
     原来写的是「待 PI 确认」，读起来像是"球在 PI 那边"，
     于是没有人会去点它；而 PI 多数时候根本没有本系统的账号，
     那一等就是永远（实测 189 条卡在这个状态上）。见迁移 0050。 */
  if (v.status !== "planned") return <span className="chip flat">待登记 PI 确认</span>;
  const d = v.daysLeft ?? 0;
  if (d < 0) return <span className="chip crit">已超窗 {-d} 天</span>;
  if (d === 0) return <span className="chip crit">今天到期</span>;
  if (d <= 2) return <span className="chip warn">还剩 {d} 天</span>;
  return <span className="chip good">窗口内</span>;
}

/** 往后看几天。一周是 CRC 排班的自然单位，也是访视窗口最常见的宽度。 */
const AHEAD = 7;
/** 一次取多少。按窗口关闭日排序，所以截断的永远是最不急的那一头 ——
 *  但截断了要**说出来**，见下面的 `more`。 */
const LIMIT = 200;

export function TodayPage() {
  const [visits, setVisits] = useState<Visit[] | null>(null);
  const [more, setMore] = useState(false);

  useEffect(() => {
    /* **在服务端筛，不在这里筛。**
       原来是拉 50 条回来再 `filter(status === "planned")` ——
       种子里只有 10 条访视且恰好都没做完时，两种写法看不出区别。
       数据一多就不是了：列表按窗口升序，最早的那 50 条全是历史上
       已经做完的，于是"今天要做什么"这一页**空着**，
       而它看起来完全正常（没有报错、没有加载中）。

       后来改成只取 planned，还是只取前 50 条、而且**与日期无关** ——
       一个在管 30 个受试者的 CRC，未完成的访视里大半是一两个月后的；
       第 51 条起静默消失，页面上一个字都不说。
       现在只取**窗口在 7 天内已经打开**的（超窗的、今天到期的、本周能做的），
       远期的去「我的日程」看；真的多到截断时，页面上说出来。 */
    call<{ items: Visit[]; nextCursor: string | null }>("listSubjectVisits", {
      query: { limit: LIMIT, status: "planned", windowOpensBy: daysFromToday(AHEAD) }
    }).then(r => { setVisits(r.items); setMore(!!r.nextCursor); });
  }, []);

  const open = visits ?? [];
  const late = open.filter(v => v.outOfWindow).length;
  /* 先办的：已超窗，或者今天是窗口最后一天。 */
  const urgent = open.filter(v => v.outOfWindow || (v.daysLeft ?? 1) <= 0);
  const week = open.filter(v => !urgent.includes(v));

  return (
    <>
      <div className="page-head">
        <h2>今天</h2>
        <p data-testid="today-summary">
          {visits === null ? "加载中…"
            : open.length === 0 ? `未来 ${AHEAD} 天没有要做的访视。`
            : `未来 ${AHEAD} 天有 ${open.length} 次访视待完成` + (late ? `，其中 ${late} 次已超窗` : "")}
        </p>
      </div>

      {late > 0 && (
        <div className="problem" style={{ marginBottom: 14 }} role="status">
          有 {late} 次访视已超窗，已排在最前。完成时需要填写超窗原因，
          系统会据此记一条方案偏离。
        </div>
      )}

      {urgent.length > 0 && (
        <VisitTable title="先办这些" sub="已超窗或今天到期" rows={urgent} testid="today-urgent" />
      )}
      {week.length > 0 && (
        <VisitTable title={`${AHEAD} 天内`} sub="窗口已经打开或即将打开" rows={week} testid="today-week" />
      )}

      {more && (
        <p className="problem" data-testid="today-more" style={{ marginTop: 14 }}>
          这里只列出了窗口最早的 {LIMIT} 次。全部受试者在
          <Link to="/subjects">「受试者访视窗口」</Link>里看。
        </p>
      )}
      {visits !== null && (
        <p className="muted" style={{ marginTop: 14 }} data-testid="today-later">
          {AHEAD} 天以后的访视在 <Link to="/sched">「我的日程」</Link> 里。
        </p>
      )}
    </>
  );
}

function VisitTable({ title, sub, rows, testid }: {
  title: string; sub: string; rows: Visit[]; testid: string;
}) {
  return (
    <section className="stack" data-testid={testid} style={{ marginBottom: 18 }}>
      <div className="spread">
        <h3>{title} <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>{sub}</span></h3>
        <span className="muted num">{rows.length}</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>受试者</th><th>中心</th><th>访视</th>
              <th>窗口</th><th>状态</th><th>任务</th><th />
            </tr>
          </thead>
          <tbody>
            {rows.map(v => {
              const done = v.tasks.filter(t => t.doneAt).length;
              return (
                <tr key={v.id} data-testid="visit-row">
                  <td className="mono">{v.screeningNo ?? "—"}</td>
                  <td className="mono">{v.siteCode}</td>
                  <td>{v.visitLabel}</td>
                  <td className="mono muted">{v.windowFrom} ~ {v.windowTo}</td>
                  <td>{windowChip(v)}</td>
                  <td className="num">{done}/{v.tasks.length}</td>
                  <td>
                    <Link to={`/visits/${v.id}`} className="btn"
                      style={{ textDecoration: "none", display: "inline-block" }}>
                      打开
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
