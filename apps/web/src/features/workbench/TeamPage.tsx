import { useEffect, useState } from "react";
import { call } from "../../api/client.js";
import { loadMe, type Me } from "../login/me.js";
import { listTeams, listAccounts, type Team, type Account } from "../org/api.js";

/* ════════════════════════════════════════════════════════════════════
   我的团队。

   ── 分组不是通讯录，是权限的行维度 ────────────────────────────────
   PM 的行范围规则是 `team`：他看得到的中心 = **本组承接项目下的全部中心**。
   把一个项目从 A 组划到 B 组，A 组组长立刻看不到它。

   所以这一页的第一件事不是列人，是把这条说清楚 ——
   否则「为什么我看不到那个中心」会变成一个反复被问、
   而且每次都要重新解释一遍的问题。

   ── 未分组的人要单独说 ────────────────────────────────────────────
   一个没有分组的内部员工，**不在任何 PM 的行范围里**：
   他的工时、他的负载，PM 都看不到。这不是"少填了一栏"，
   是这个人在管理视角里不存在。
   ════════════════════════════════════════════════════════════════════ */

interface Staff {
  accountId: string; displayName: string; roleKind: string;
  level: string; city: string; siteCount: number;
  successionGap: boolean; active: boolean;
  gcpDaysLeft: number | null;
}

export function TeamPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);

  useEffect(() => {
    void (async () => {
      const [m, t, a, s] = await Promise.all([
        loadMe(), listTeams(), listAccounts(),
        call<{ items: Staff[] }>("listStaff", { query: { limit: 200, activeOnly: true } })
      ]);
      setMe(m); setTeams(t.items); setAccounts(a.items); setStaff(s.items);
    })();
  }, []);

  if (!me) return <p className="muted">加载中…</p>;

  const myTeam = me.account.team;
  const internal = accounts.filter(a => a.status === "active" && !a.isExternal);
  const unassigned = internal.filter(a => !a.team);
  const byAccount = new Map(staff.map(s => [s.accountId, s]));

  /* 自己那一组排最前 —— 这一页叫「我的团队」，
     而不是「全部分组」（那是组织与权限里的事）。 */
  const ordered = [...teams].sort((a, b) =>
    Number(b.id === myTeam?.id) - Number(a.id === myTeam?.id) || a.code.localeCompare(b.code));

  return (
    <>
      <div className="page-head">
        <h2>我的团队</h2>
        <p>
          {myTeam
            ? <>你在 <b>{myTeam.name}</b>。</>
            : <>你没有分组 —— 你的角色不靠分组切行（<span className="mono">{me.permissions.rowRule}</span>）。</>}
          {" "}分组不是通讯录，是<b>权限的行维度</b>。
        </p>
      </div>

      <div className="derive" style={{ marginBottom: 14 }}>
        PM 的行范围规则是 <code>team</code>：他看得到的中心 =
        <b>本组承接项目下的全部中心</b>。把一个项目从 A 组划到 B 组，
        A 组组长<b>立刻</b>看不到它 —— 这是权限，不是显示偏好。
      </div>

      {unassigned.length > 0 && (
        <div className="problem" data-testid="unassigned" style={{ marginBottom: 14 }} role="status">
          <strong>{unassigned.length} 个内部员工没有分组：
            {unassigned.map(a => a.displayName).join("、")}</strong>
          <div className="muted">
            他们<b>不在任何 PM 的行范围里</b> —— 工时、负载、派工，PM 都看不到。
            这不是少填了一栏，是这个人在管理视角里不存在。
            去「组织与权限 → 分组」里把他们放进去。
          </div>
        </div>
      )}

      <div className="stack">
        {ordered.map(t => {
          const members = internal.filter(a => a.team?.id === t.id);
          const isMine = t.id === myTeam?.id;
          const sites = members.reduce(
            (n, a) => n + (byAccount.get(a.id)?.siteCount ?? 0), 0);
          return (
            <div className="card stack" key={t.id} data-testid="team-block"
              style={isMine ? { borderColor: "var(--accent, #3b6ea5)" } : undefined}>
              <div className="spread">
                <h3>
                  {t.name} <span className="mono muted" style={{ fontSize: 12 }}>{t.code}</span>
                  {isMine && <span className="chip good" style={{ marginLeft: 8 }}>我在这一组</span>}
                </h3>
                <span className="muted">
                  组长 {t.lead?.displayName ?? "未指定"} · {members.length} 人 ·
                  承接 {t.studyCount} 个项目 · 名下 {sites} 个中心
                </span>
              </div>

              {t.studyCount === 0 && (
                <p className="muted" style={{ margin: 0 }} data-testid="no-study">
                  这一组不承接项目 —— 组里的 PM <b>一个中心都看不到</b>。
                  职能组（如财务、质量）本来就是这样；如果它不该是，
                  那要去项目那边把承接关系挂上。
                </p>
              )}

              {members.length === 0
                ? <p className="muted" style={{ margin: 0 }}>暂无成员。</p>
                : <div className="table-wrap">
                    <table>
                      <thead>
                        <tr><th>姓名</th><th>角色</th><th>工种</th>
                          <th>城市</th><th className="num">带中心</th><th>提示</th></tr>
                      </thead>
                      <tbody>
                        {members.map(a => {
                          const s = byAccount.get(a.id);
                          return (
                            <tr key={a.id} data-testid="team-member">
                              <td>{a.displayName}</td>
                              <td><span className="chip flat">{a.role.name}</span></td>
                              <td className="muted">{s?.roleKind ?? "—"}{s?.level && ` · ${s.level}`}</td>
                              <td className="muted">{s?.city ?? "—"}</td>
                              <td className="num">{s?.siteCount ?? 0}</td>
                              <td>
                                {/* 这一页不重算风险 —— 那是「人才梯队」的事。
                                    这里只把两件当场影响排班的事标出来。 */}
                                <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
                                  {s?.gcpDaysLeft !== undefined && s.gcpDaysLeft !== null
                                    && s.gcpDaysLeft < 0 &&
                                    <span className="chip crit">GCP 已过期</span>}
                                  {s?.successionGap && <span className="chip warn">无人可接</span>}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>}
            </div>
          );
        })}
      </div>

      <div className="derive" style={{ marginTop: 14 }}>
        「本组承接哪些项目」还不能在这里改 —— 那要一个项目侧的入口，
        目前只有直接改库（和「组织与权限」页说的是同一件事）。
        <br />
        这一页不算风险分，也不重算负载：那是「人才梯队」和「派工与产能」的事。
        <b>同一个数在两页各算一遍，迟早有一页说有、另一页说没有。</b>
      </div>
    </>
  );
}
