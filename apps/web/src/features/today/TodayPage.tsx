import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { call } from "../../api/client.js";

/* CRC 每天第一件事是看「今天谁到期」—— 所以这是首页，
   而且默认按窗口关闭日升序，超窗的排在最上面。 */

export interface Visit {
  id: string; screeningNo?: string; siteCode: string;
  visitLabel: string; targetDate: string; windowFrom: string; windowTo: string;
  daysLeft: number | null; outOfWindow: boolean; status: string;
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
    call<{ items: Visit[] }>("listSubjectVisits", { query: { limit: 50 } })
      .then(r => setVisits(r.items));
  }, []);

  const open = visits?.filter(v => v.status === "planned") ?? [];
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
            {visits?.map(v => {
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
