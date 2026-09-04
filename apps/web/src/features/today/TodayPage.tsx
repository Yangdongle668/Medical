import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { call } from "../../api/client.js";

/* CRC 每天第一件事是看「今天谁到期」—— 所以这是首页，
   而且默认按窗口关闭日升序，超窗的排在最上面。 */

export interface Visit {
  id: string; screeningNo?: string; siteCode: string;
  visitLabel: string; targetDate: string; windowFrom: string; windowTo: string;
  daysLeft: number | null; outOfWindow: boolean; status: string;
  /** 录入 EDC 的状态。**完成访视和录进 EDC 是两件事** ——
   *  访视完成后 5 个工作日内录入才算及时，超时不阻断，但进及时率统计。 */
  edcStatus?: "pending" | "entered" | "queried";
  edcDaysLate?: number | null;
  tasks: { seq: number; task: string; doneAt: string | null }[];
}

function windowChip(v: Visit) {
  if (v.status !== "planned") return <span className="chip flat">待 PI 确认</span>;
  const d = v.daysLeft ?? 0;
  if (d < 0) return <span className="chip crit">已超窗 {-d} 天</span>;
  if (d === 0) return <span className="chip crit">今天到期</span>;
  if (d <= 2) return <span className="chip warn">还剩 {d} 天</span>;
  return <span className="chip good">窗口内</span>;
}

export function TodayPage() {
  const [visits, setVisits] = useState<Visit[] | null>(null);

  useEffect(() => {
    /* **在服务端筛，不在这里筛。**
       原来是拉 50 条回来再 `filter(status === "planned")` ——
       种子里只有 10 条访视且恰好都没做完时，两种写法看不出区别。
       数据一多就不是了：列表按窗口升序，最早的那 50 条全是历史上
       已经做完的，于是"今天要做什么"这一页**空着**，
       而它看起来完全正常（没有报错、没有加载中）。

       一个先截断再过滤的列表，过滤条件越常见，它越安全；
       而这一条恰恰是最不常见的那种 —— 未完成的访视永远是少数。 */
    call<{ items: Visit[] }>("listSubjectVisits",
      { query: { limit: 50, status: "planned" } })
      .then(r => setVisits(r.items));
  }, []);

  /* 服务端已经只给 planned 了。这里不再二次过滤 ——
     留着的话，摘要数的和表格画的又会是两批东西
     （原来正是如此：摘要用过滤后的，表格 map 的是全部）。 */
  const open = visits ?? [];
  const late = open.filter(v => v.outOfWindow).length;

  return (
    <>
      <div className="page-head">
        <h2>今天</h2>
        <p data-testid="today-summary">
          {visits === null ? "加载中…"
            : `${open.length} 次访视待完成` + (late ? `，其中 ${late} 次已超窗` : "")}
        </p>
      </div>

      {late > 0 && (
        <div className="problem" style={{ marginBottom: 14 }} role="status">
          有 {late} 次访视已超窗。超窗完成会自动生成方案偏离，
          提交时需要填写原因 —— 它会原样进入质量台账。
        </div>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>受试者</th><th>中心</th><th>访视</th>
              <th>窗口</th><th>状态</th><th>任务</th><th />
            </tr>
          </thead>
          <tbody>
            {open.map(v => {
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
    </>
  );
}
