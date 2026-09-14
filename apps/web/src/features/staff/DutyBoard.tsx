import { useEffect, useState } from "react";
import { call } from "../../api/client.js";
import { DUTY_KINDS, DUTY_LABEL, DUTY_STALE_DAYS, dutyUrgent } from "@sitedesk/calc";

/* ════════════════════════════════════════════════════════════════════
   该登记的，登记了没有 —— **按人排**。

   ── 这一块补的是哪个洞 ────────────────────────────────────────────
   迁移 0048 与 0050 把立项受理与 PI 确认从「等院外的人在本系统里点一下」
   改成了「由院内的人带着日期登记进来」。那一步是对的，但它把风险
   换了个地方：

     原来卡住的是**别人不点** —— 看得见，因为它明晃晃地卡在那里；
     现在卡住的是**自己人没登记** —— 看不见，因为它只是没有发生。

   一件没发生的事不会出现在任何列表上，除非有人专门去数。
   而这套系统是给管理员与经营层管底下 CRC / CRA / PM 的，
   「这个人这周该登记的几件事登记了没有」正是它存在的理由 ——
   在此之前**没有一页回答得了**：团队工作台按中心排（"SS-07 怎么样了"），
   经营驾驶舱按问题类型排，两者都不按人排，于是"谁欠着"只能人工对。

   ── 为什么在这一页，而不是新开一页 ────────────────────────────────
   「派工与产能」已经是**一行一个人**的那张表，而且管理员、经营层、PM
   本来就都有这个模块。新开一页要新加一个模块键、一条路由、一行侧栏，
   换来的是同一批人在两页之间来回看同一批名字。

   但它**不是产能表的几列**：产能问的是"这个人在我方是什么情况"
   （职级、证书、继任），半年才变一次；这里问的是**这周**的事。
   两个问题各自一块，各自一个表头 —— 契约那边同理，
   `RegistrationDuty` 不是 `Staff` 的子集。

   ── 排序用最久的那一件，不用件数 ──────────────────────────────────
   按件数排，带三个大中心、每样欠一点的人会永远排在第一，
   而真正该先处理的是那条挂了四十天的 —— 它已经不是"来不及"，是"忘了"，
   而忘了的那一条不会自己浮上来。
   ════════════════════════════════════════════════════════════════════ */

interface Duty {
  accountId: string; login: string; displayName: string; roleKind: string;
  pendingPiConfirm: number; edcOverdue: number; outOfWindow: number;
  acceptanceNoLetter: number; total: number; oldestDays: number | null;
}

export function DutyBoard() {
  const [rows, setRows] = useState<Duty[] | null>(null);
  /** **读不到**。和"没有欠着的"是两件事，画法也必须是两种 ——
   *  读失败时画成一张空表，说的是「都登记完了」，那是一句假话，
   *  而它恰好出现在最不该让人放心的时候。 */
  const [failed, setFailed] = useState(false);
  /** 默认**不筛**。只列欠债的那张表说不出分母，而「十个人里两个欠着」
   *  和「两个人里两个欠着」是两件完全不同的事。 */
  const [owingOnly, setOwingOnly] = useState(false);

  useEffect(() => {
    void call<{ items: Duty[] }>("listRegistrationDuties", { query: { limit: 200 } })
      .then(r => { setRows(r.items); setFailed(false); })
      .catch(() => { setRows([]); setFailed(true); });
  }, []);

  if (failed) return (
    <section className="card stack" data-testid="duty-board" style={{ marginBottom: 14 }}>
      <div className="problem" data-testid="duty-unavailable">
        <strong>这一块读不到。</strong>
        <div className="muted">
          读不到<b>不等于没有人欠着</b> —— 刷新一次；还是这样就找管理员看接口。
        </div>
      </div>
    </section>
  );
  if (!rows) return <p className="muted">加载中…</p>;

  const owing = rows.filter(r => r.total > 0);
  const urgent = owing.filter(r => dutyUrgent(r.oldestDays));
  const shown = (owingOnly ? owing : rows)
    /* 最久的顶在最前；一样久的按件数。**不欠的沉到最后** ——
       null 参与比较会把清白的人排到中间。 */
    .slice().sort((a, b) =>
      (b.oldestDays ?? -1) - (a.oldestDays ?? -1) || b.total - a.total
      || a.displayName.localeCompare(b.displayName));

  return (
    <section className="card stack" data-testid="duty-board" style={{ marginBottom: 14 }}>
      <div className="card-h">
        <h3>该登记的，登记了没有</h3>
        <span className="sub">按人排 —— 中心视角在团队工作台，这里是人的视角</span>
      </div>

      <div className="card-b stack">
        {owing.length === 0 ? (
          <p className="note" style={{ margin: 0 }} data-testid="duty-clear">
            <b>都登记完了。</b>这一块空着是好事 —— 它只列**现在就办得掉**的事。
          </p>
        ) : (
          <p className={urgent.length ? "problem" : "note"} style={{ margin: 0 }}
            data-testid="duty-summary">
            <b className="num">{owing.length}</b> 人共欠着{" "}
            <b className="num">{owing.reduce((n, r) => n + r.total, 0)}</b> 件
            {urgent.length > 0 && <>，其中 <b className="num">{urgent.length}</b> 人
              最久的一件已经挂了 <b>{DUTY_STALE_DAYS} 天以上</b> ——
              那已经不是"来不及"，是"忘了"</>}。
          </p>
        )}

        <label className="row" style={{ gap: 6, alignItems: "center" }}>
          <input type="checkbox" style={{ width: "auto" }} checked={owingOnly}
            data-testid="duty-owing-only" onChange={e => setOwingOnly(e.target.checked)} />
          <span>只看欠着的（共 {rows.length} 人）</span>
        </label>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>姓名</th><th>工种</th>
                {DUTY_KINDS.map(k => (
                  <th key={k} className="num">{DUTY_LABEL[k]}</th>
                ))}
                <th className="num">合计</th><th className="num">最久</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(r => (
                <tr key={r.accountId} data-testid="duty-row">
                  <td>{r.displayName}<div className="muted mono">{r.login}</div></td>
                  <td><span className="chip flat">{r.roleKind}</span></td>
                  {DUTY_KINDS.map(k => (
                    /* **0 画成「—」，不画成 0。** 一屏的 0 会把真正的那几个数淹掉，
                       而这张表的全部作用就是让那几个数跳出来。 */
                    <td key={k} className="num">
                      {r[k] === 0 ? <span className="t-mut">—</span> : <b>{r[k]}</b>}
                    </td>
                  ))}
                  <td className="num">
                    {r.total === 0 ? <span className="t-mut">—</span> : <b>{r.total}</b>}
                  </td>
                  <td className="num">
                    {r.oldestDays === null ? <span className="t-mut">—</span>
                      : dutyUrgent(r.oldestDays)
                        ? <span className="chip crit" data-testid="duty-stale">
                            {r.oldestDays} 天</span>
                        : <span className="muted">{r.oldestDays} 天</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="derive">
          <b>这四类都是这个人现在就办得掉的事。</b>
          等中心回复的数据质疑、等排期的监查、要别人审批的工时<b>一律不收</b> ——
          把「在等别人」混进「你欠着」，这张表会立刻失去说服力，
          而一张会冤枉人的清单，人只会学会忽略它。<br />
          数是<b>在你自己的行范围内数的</b>：项目总监看到的是本组中心上的，
          经营层看到的是全部。同一个人在两个人眼里可以是两个数，那不是数错了。
        </div>
      </div>
    </section>
  );
}
