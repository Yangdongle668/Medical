import { useCallback, useEffect, useState } from "react";
import { ApiError, type ProblemDetails } from "../../api/client.js";
import { loadMe, type Me } from "../login/me.js";
import { MODULES, GROUP_ORDER } from "../../shell/modules.js";
import {
  listAccounts, listRoles, listTeams, createAccount, updateAccount,
  disableAccount, enableAccount, setAccountPassword, createTeam, updateRole,
  ROW_RULE, NEEDS_ORG_REF, FIELD_LABEL, ACTION_LABEL,
  type Account, type Role, type Team
} from "./api.js";

/* ════════════════════════════════════════════════════════════════════
   组织与权限 —— 管理员的主界面（原型 26-org.html）。

   三个视角，同一页：
     · 人员账号 —— 建号、改角色与分组、停用启用、给初始口令
     · 分组     —— PM 的行范围就是从这里推导的
     · 角色权限 —— 行 × 列 × 动作 × 模块，改完立即生效

   ── 一件要说在前面的事 ────────────────────────────────────────────
   这一页改的每一样东西**当场生效**，不需要谁重新登录：
   权限在每个请求里由服务端现算（`app.current_row_rule()` 之类），
   前端只是照着 `/v1/me` 收敛显示。所以「改完要不要重启」这个问题
   在这套系统里不存在 —— 而正因为不存在，每一次改都得有理由，
   每一次改都进审计轨迹。表单上那个「原因」不是走过场。
   ════════════════════════════════════════════════════════════════════ */

type Tab = "user" | "group" | "perm";

export function OrgPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [tab, setTab] = useState<Tab>("user");
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [a, r, t] = await Promise.all([listAccounts(), listRoles(), listTeams()]);
    setAccounts(a.items); setRoles(r.items); setTeams(t.items);
  }, []);

  useEffect(() => { void loadMe().then(setMe); void reload(); }, [reload]);

  /** 每一个写操作都走这里：**出错要说话，成功要说清改了什么**。
   *  散在各处各写一遍 try/catch 的话，总有一两处忘了刷新，
   *  于是界面上那一行还是旧的，而人以为自己没点中。 */
  const run = async (what: string, fn: () => Promise<unknown>) => {
    setProblem(null); setSaid(null);
    try { await fn(); await reload(); setSaid(what); }
    catch (e) {
      if (e instanceof ApiError) setProblem(e.problem);
      else throw e;
    }
  };

  if (!me) return <p className="muted">加载中…</p>;

  /* 这一页是安全边界之内的东西 —— 但边界在服务端。
     没有 manage 的人手敲进来，页面会打开，接口一个都不会答应他。
     与其让他对着一串 403 猜，不如直接说。 */
  if (!me.permissions.actions.includes("manage")) return (
    <>
      <div className="page-head"><h2>组织与权限</h2></div>
      <div className="problem" data-testid="org-forbidden">
        你的角色（{me.account.role.name}）没有「管理人员与权限」这个动作。
        这一页的每个接口都会拒绝你 —— 不是界面藏起来了，是服务端不答应。
      </div>
    </>
  );

  const active = accounts?.filter(a => a.status === "active") ?? [];
  const off = accounts?.filter(a => a.status === "disabled") ?? [];
  const external = active.filter(a => a.isExternal);
  const unassigned = active.filter(a => !a.isExternal && !a.team);

  return (
    <>
      <div className="page-head">
        <h2>组织与权限</h2>
        <p>建号、分组、三维权限。<b>改完立即生效</b>，且每一次都进审计轨迹。</p>
      </div>

      <div className="stats" style={{ marginBottom: 14 }}>
        <Stat label="在职账号" value={active.length} unit="个"
          note={`其中外部 ${external.length} 个`} />
        <Stat label="分组" value={teams.length} unit="个"
          note={unassigned.length ? `未分组 ${unassigned.length} 人` : "内部人员均已分组"} />
        <Stat label="角色" value={roles.length} unit="种"
          note={`外部角色 ${roles.filter(r => r.isExternal).length} 种`} />
        <Stat label="已停用" value={off.length} unit="个" note="保留账号但不可登录" />
      </div>

      <div className="seg" style={{ marginBottom: 14 }}>
        {([["user", `人员账号 ${accounts?.length ?? 0}`],
           ["group", `分组 ${teams.length}`],
           ["perm", `角色权限 ${roles.length}`]] as [Tab, string][]).map(([k, label]) => (
          <button key={k} aria-pressed={tab === k} data-testid={`tab-${k}`}
            onClick={() => { setTab(k); setProblem(null); setSaid(null); }}>{label}</button>
        ))}
      </div>

      {problem && (
        <div className="problem stack" data-testid="org-problem" style={{ marginBottom: 12 }}>
          <strong>{problem.title}</strong>
          {problem.detail && <div>{problem.detail}</div>}
          {/* 闸门不满足时后端会逐条列出还差什么 —— 原样铺开，
              把它压成一句"操作失败"，人就得自己去猜差哪一项。 */}
          {Array.isArray(problem.unmet) && (
            <ul className="unmet">
              {(problem.unmet as { message: string }[]).map((u, i) => <li key={i}>{u.message}</li>)}
            </ul>
          )}
        </div>
      )}
      {said && <p className="muted" data-testid="org-said">{said}</p>}

      {accounts === null ? <p className="muted">加载中…</p>
        : tab === "user" ? <UserTab {...{ me, accounts, roles, teams, run }} />
        : tab === "group" ? <GroupTab {...{ accounts, teams, run }} />
        : <PermTab {...{ roles, run }} />}
    </>
  );
}

function Stat({ label, value, unit, note }:
  { label: string; value: number; unit: string; note: string }) {
  return (
    <div className="stat">
      <div className="stat-l">{label}</div>
      <div className="stat-v">{value}<small className="muted" style={{ fontSize: 12, marginLeft: 2 }}>{unit}</small></div>
      <div className="stat-n">{note}</div>
    </div>
  );
}

type Run = (what: string, fn: () => Promise<unknown>) => Promise<void>;

/* ── 人员账号 ─────────────────────────────────────────────────────── */
function UserTab({ me, accounts, roles, teams, run }: {
  me: Me; accounts: Account[]; roles: Role[]; teams: Team[]; run: Run;
}) {
  const [login, setLogin] = useState("");
  const [name, setName] = useState("");
  const [roleId, setRoleId] = useState("");
  const [teamId, setTeamId] = useState("");
  const [orgRef, setOrgRef] = useState("");
  const [editing, setEditing] = useState<Account | null>(null);
  const [pwFor, setPwFor] = useState<Account | null>(null);

  const role = roles.find(r => r.id === roleId);
  /* hospital 规则的角色没有 orgRef 就是个"登得进来、一行都看不到"的账号。
     库里的触发器会拦（迁移 0002），但让人先看见比让人先撞上强。 */
  const needsOrg = role?.rowRule === NEEDS_ORG_REF;

  return (
    <>
      <div className="card stack" style={{ marginBottom: 12 }}>
        <div className="spread">
          <h3>新增人员</h3>
          <span className="muted">新账号建出来就能被授权，权限由角色决定</span>
        </div>
        <div className="grid-form">
          <label className="field"><span>姓名</span>
            <input value={name} data-testid="new-name"
              onChange={e => setName(e.target.value)} placeholder="例：周敏" /></label>
          <label className="field"><span>登录账号</span>
            <input value={login} data-testid="new-login" className="mono"
              onChange={e => setLogin(e.target.value)} placeholder="例：zhoumin" /></label>
          <label className="field"><span>角色</span>
            <select value={roleId} data-testid="new-role" onChange={e => setRoleId(e.target.value)}>
              <option value="">— 选一个 —</option>
              {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select></label>
          <label className="field"><span>分组</span>
            <select value={teamId} data-testid="new-team" onChange={e => setTeamId(e.target.value)}>
              <option value="">不分组</option>
              {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select></label>
        </div>
        {needsOrg && (
          <label className="field"><span>
            所属机构（必填）—— 这个角色按「本院承接的项目」切行，
            不填的话他登得进来，但一行数据都看不到
          </span>
            <input value={orgRef} data-testid="new-orgref"
              onChange={e => setOrgRef(e.target.value)} placeholder="例：北京协和医院" /></label>
        )}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button className="btn primary" data-testid="create-account"
            disabled={!login.trim() || !name.trim() || !roleId || (needsOrg && !orgRef.trim())}
            onClick={() => void run(`已建号 ${name}（${login}）`, async () => {
              await createAccount({
                login: login.trim(), displayName: name.trim(), roleId,
                teamId: teamId || null, orgRef: needsOrg ? orgRef.trim() : null
              });
              setLogin(""); setName(""); setTeamId(""); setOrgRef("");
            })}>
            创建账号
          </button>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          建出来的账号还没有进得来的路。两条选一条：给他登记收件地址（他就能自助申请一次性链接），
          或者在下面那一行点「设口令」当面给一个初始口令 —— 他第一次登录时会被要求改掉。
        </p>
      </div>

      <div className="card stack">
        <div className="spread">
          <h3>账号台账</h3>
          <span className="muted">停用不删除 —— 审计轨迹必须能追溯到人</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>姓名</th><th>登录账号</th><th>角色</th><th>分组</th>
                <th>行范围</th><th>入职</th><th>最近登录</th><th>状态</th><th />
              </tr>
            </thead>
            <tbody>
              {accounts.map(a => {
                const r = roles.find(x => x.id === a.role.id);
                const self = a.id === me.account.id;
                return (
                  <tr key={a.id} data-testid="account-row"
                    style={a.status === "disabled" ? { opacity: .55 } : undefined}>
                    <td>
                      {a.displayName}
                      {a.isExternal && <span className="chip warn" style={{ marginLeft: 6 }}>外部</span>}
                      {a.disabledReason && <div className="muted">{a.disabledReason}</div>}
                    </td>
                    <td className="mono">{a.login}</td>
                    <td><span className="chip flat">{a.role.name}</span></td>
                    <td className="muted">{a.team?.name ?? (a.isExternal ? a.orgRef ?? "外部机构" : "—")}</td>
                    <td className="muted">{r ? ROW_RULE[r.rowRule] ?? r.rowRule : "—"}</td>
                    <td className="mono muted">{a.joinedOn ?? "—"}</td>
                    <td className="mono muted">{a.lastLoginAt?.slice(0, 10) ?? "从未"}</td>
                    <td>
                      <span className={`chip ${a.status === "active" ? "good" : "flat"}`}>
                        {a.status === "active" ? "在职" : "已停用"}
                      </span>
                    </td>
                    <td>
                      <div className="row" style={{ gap: 4, justifyContent: "flex-end" }}>
                        <button className="btn" onClick={() => setEditing(a)}>改角色</button>
                        <button className="btn" onClick={() => setPwFor(a)}
                          /* 给自己设口令等于绕过"验旧口令"那道门 —— 服务端会拒，
                             这里先把按钮关掉，免得人点了才知道。 */
                          disabled={self} title={self ? "改自己的口令请用顶部的「改口令」" : undefined}>
                          设口令
                        </button>
                        {self ? <span className="muted">当前登录</span>
                          : a.status === "active"
                            ? <DangerButton label="停用" testid={`disable-${a.login}`}
                                placeholder="例：离职交接完成"
                                onConfirm={reason => run(`${a.displayName} 已停用`,
                                  () => disableAccount(a.id, reason))} />
                            : <DangerButton label="启用" testid={`enable-${a.login}`}
                                placeholder="例：休假结束返岗"
                                onConfirm={reason => run(`${a.displayName} 已启用`,
                                  () => enableAccount(a.id, reason))} />}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {editing && (
        <EditAccount account={editing} roles={roles} teams={teams}
          onClose={() => setEditing(null)}
          onSave={(b, label) => run(label, async () => {
            await updateAccount(editing.id, b); setEditing(null);
          })} />
      )}
      {pwFor && (
        <SetPassword account={pwFor} onClose={() => setPwFor(null)}
          onSave={(password, reason) => run(
            `${pwFor.displayName} 的口令已重设 —— 他下次登录会被要求改掉，之前的会话全部断开`,
            async () => { await setAccountPassword(pwFor.id, password, reason); setPwFor(null); })} />
      )}
    </>
  );
}

/** 停用 / 启用都要理由。**理由不是走过场** ——
 *  "这个人为什么在三月被停用"半年后只有这一行答得出来。 */
function DangerButton({ label, testid, placeholder, onConfirm }: {
  label: string; testid: string; placeholder: string;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  if (!open) return (
    <button className="btn" data-testid={testid} onClick={() => setOpen(true)}>{label}</button>
  );
  return (
    <span className="row" style={{ gap: 4 }}>
      <input value={reason} placeholder={placeholder} data-testid={`${testid}-reason`}
        style={{ width: 180 }} onChange={e => setReason(e.target.value)} />
      <button className="btn primary" data-testid={`${testid}-go`} disabled={!reason.trim()}
        onClick={() => void onConfirm(reason.trim()).then(() => { setOpen(false); setReason(""); })}>
        {label}
      </button>
      <button className="btn" onClick={() => { setOpen(false); setReason(""); }}>取消</button>
    </span>
  );
}

function EditAccount({ account, roles, teams, onClose, onSave }: {
  account: Account; roles: Role[]; teams: Team[]; onClose: () => void;
  onSave: (b: { roleId?: string; teamId?: string | null; orgRef?: string | null; reason: string },
           label: string) => void;
}) {
  const [roleId, setRoleId] = useState(account.role.id);
  const [teamId, setTeamId] = useState(account.team?.id ?? "");
  const [orgRef, setOrgRef] = useState(account.orgRef ?? "");
  const [reason, setReason] = useState("");
  const role = roles.find(r => r.id === roleId);
  const needsOrg = role?.rowRule === NEEDS_ORG_REF;
  const changed = roleId !== account.role.id
    || teamId !== (account.team?.id ?? "")
    || (needsOrg && orgRef !== (account.orgRef ?? ""));

  return (
    <div className="card stack" data-testid="edit-account" style={{ marginTop: 12 }}>
      <div className="spread">
        <h3>{account.displayName} · <span className="mono">{account.login}</span></h3>
        <button className="btn" onClick={onClose}>关闭</button>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        登录名与姓名不在这里改 —— 登录名是审计轨迹里的那个标识，
        改掉等于把过去的记录指向另一个人。
      </p>
      <div className="grid-form">
        <label className="field"><span>角色</span>
          <select value={roleId} data-testid="edit-role" onChange={e => setRoleId(e.target.value)}>
            {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select></label>
        <label className="field"><span>分组</span>
          <select value={teamId} data-testid="edit-team" onChange={e => setTeamId(e.target.value)}>
            <option value="">不分组</option>
            {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select></label>
      </div>
      {role && (
        <p className="muted" style={{ margin: 0 }}>
          改成「{role.name}」之后，他的行范围是 <b>{ROW_RULE[role.rowRule] ?? role.rowRule}</b>，
          看得到 {role.modules.length} 个模块。<b>改完立即生效</b>，不需要他重新登录。
        </p>
      )}
      {needsOrg && (
        <label className="field"><span>所属机构（这个角色必填）</span>
          <input value={orgRef} data-testid="edit-orgref"
            onChange={e => setOrgRef(e.target.value)} placeholder="例：北京协和医院" /></label>
      )}
      <label className="field"><span>原因（进审计轨迹）</span>
        <input value={reason} data-testid="edit-reason"
          onChange={e => setReason(e.target.value)} placeholder="例：转岗到华东组任 PM" /></label>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn primary" data-testid="edit-save"
          disabled={!changed || !reason.trim() || (needsOrg && !orgRef.trim())}
          onClick={() => onSave({
            ...(roleId !== account.role.id ? { roleId } : {}),
            ...(teamId !== (account.team?.id ?? "") ? { teamId: teamId || null } : {}),
            ...(needsOrg ? { orgRef: orgRef.trim() } : {}),
            reason: reason.trim()
          }, `${account.displayName} 的归属已更新`)}>
          保存
        </button>
      </div>
    </div>
  );
}

function SetPassword({ account, onClose, onSave }: {
  account: Account; onClose: () => void;
  onSave: (password: string, reason: string) => void;
}) {
  const [pw, setPw] = useState("");
  const [reason, setReason] = useState("");
  return (
    <div className="card stack" data-testid="set-password" style={{ marginTop: 12 }}>
      <div className="spread">
        <h3>给 {account.displayName} 设一个初始口令</h3>
        <button className="btn" onClick={onClose}>关闭</button>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        设出来的口令标成<b>初始口令</b>：他登录后顶上会挂一条改不掉的红条，
        改掉才消失、而且翻不回去。<b>他现有的会话会全部断开。</b>
        口令本身不进审计轨迹 —— 记的是「你给谁设过」，不是设成了什么。
      </p>
      <div className="grid-form">
        <label className="field"><span>初始口令（至少 8 位）</span>
          <input type="text" value={pw} data-testid="init-password" className="mono"
            onChange={e => setPw(e.target.value)}
            /* 这里刻意**不遮**：管理员要把它念给对方听，遮起来只会让他复制到别处再看 */
            placeholder="当面告诉他，然后让他立刻改掉" /></label>
        <label className="field"><span>原因（进审计轨迹）</span>
          <input value={reason} data-testid="init-reason"
            onChange={e => setReason(e.target.value)} placeholder="例：新人入职，通道尚未配置" /></label>
      </div>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn primary" data-testid="set-password-go"
          disabled={pw.length < 8 || !reason.trim()}
          onClick={() => onSave(pw, reason.trim())}>
          设置
        </button>
      </div>
    </div>
  );
}

/* ── 分组 ─────────────────────────────────────────────────────────── */
function GroupTab({ accounts, teams, run }: {
  accounts: Account[]; teams: Team[]; run: Run;
}) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [lead, setLead] = useState("");
  const internal = accounts.filter(a => a.status === "active" && !a.isExternal);
  const unassigned = internal.filter(a => !a.team);

  return (
    <>
      <div className="card stack" style={{ marginBottom: 12 }}>
        <div className="spread">
          <h3>新建分组</h3>
          <span className="muted">分组决定 PM 的行范围：只看得到本组承接的项目</span>
        </div>
        <div className="grid-form">
          <label className="field"><span>代号</span>
            <input value={code} data-testid="team-code" className="mono"
              onChange={e => setCode(e.target.value)} placeholder="例：G-04" /></label>
          <label className="field"><span>组名</span>
            <input value={name} data-testid="team-name"
              onChange={e => setName(e.target.value)} placeholder="例：华中组" /></label>
          <label className="field"><span>组长</span>
            <select value={lead} data-testid="team-lead" onChange={e => setLead(e.target.value)}>
              <option value="">暂不指定</option>
              {internal.map(a => (
                <option key={a.id} value={a.id}>{a.displayName}（{a.role.name}）</option>
              ))}
            </select></label>
        </div>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button className="btn primary" data-testid="create-team"
            disabled={!code.trim() || !name.trim()}
            onClick={() => void run(`已建分组 ${name}`, async () => {
              await createTeam({ code: code.trim(), name: name.trim(), leadAccountId: lead || null });
              setCode(""); setName(""); setLead("");
            })}>
            创建
          </button>
        </div>
      </div>

      {teams.map(t => {
        const members = internal.filter(a => a.team?.id === t.id);
        return (
          <div className="card stack" key={t.id} data-testid="team-card" style={{ marginBottom: 12 }}>
            <div className="spread">
              <h3>{t.name} <span className="mono muted">{t.code}</span></h3>
              <span className="muted">
                组长 {t.lead?.displayName ?? "未指定"} · {t.memberCount} 人 · 承接 {t.studyCount} 个项目
              </span>
            </div>
            <div className="row" style={{ gap: 5, flexWrap: "wrap" }}>
              {members.length
                ? members.map(m => (
                  <span key={m.id} className="chip flat">
                    {m.displayName} · {m.role.name}
                    <button className="btn link" style={{ marginLeft: 6 }}
                      onClick={() => void run(`${m.displayName} 已移出 ${t.name}`,
                        () => updateAccount(m.id, { teamId: null, reason: `移出分组 ${t.name}` }))}>
                      移出
                    </button>
                  </span>))
                : <span className="muted">暂无成员</span>}
            </div>
            <label className="field" style={{ maxWidth: 320 }}>
              <span>添加成员</span>
              <select value="" data-testid={`team-add-${t.code}`}
                onChange={e => {
                  const id = e.target.value; if (!id) return;
                  const a = internal.find(x => x.id === id)!;
                  void run(`${a.displayName} 已加入 ${t.name}`,
                    () => updateAccount(id, { teamId: t.id, reason: `加入分组 ${t.name}` }));
                }}>
                <option value="">— 选一个 —</option>
                {internal.filter(a => a.team?.id !== t.id).map(a => (
                  <option key={a.id} value={a.id}>
                    {a.displayName}（{a.role.name}{a.team ? ` · 现属 ${a.team.name}` : ""}）
                  </option>
                ))}
              </select>
            </label>
          </div>
        );
      })}

      <div className="derive">
        分组不是通讯录，是<b>权限的行维度</b>。PM 的行范围规则是 <code>team</code>：
        他看得到的中心 = 本组承接项目下的全部中心。把一个项目从 A 组划到 B 组，
        A 组组长立刻看不到它 —— 这是权限，不是显示偏好。
        {unassigned.length > 0
          ? <> <b>当前有 {unassigned.length} 人未分组</b>：
              {unassigned.map(a => a.displayName).join("、")}。
              他们不在任何 PM 的行范围里，那些 PM 看不到他们的工时与负载。</>
          : " 当前所有内部人员均已分组。"}
        <br />
        「本组承接哪些项目」（team_study）还不能在这里改 —— 那要一个项目侧的入口，
        目前只有直接改库。
      </div>
    </>
  );
}

/* ── 角色权限 ─────────────────────────────────────────────────────── */
function PermTab({ roles, run }: { roles: Role[]; run: Run }) {
  const [modsFor, setModsFor] = useState<Role | null>(null);
  const [pending, setPending] = useState<{ role: Role; label: string;
    body: Parameters<typeof updateRole>[1] } | null>(null);

  /* 权限变更**一律要理由**，所以不能改一下就发一次 ——
     先把要改的那一项存起来，问完理由再发。
     这也顺带解决了另一件事：一次勾选就是一次请求的话，
     手滑勾错再勾回来会在审计轨迹里留下两条互相抵消的记录。 */
  const propose = (role: Role, label: string, body: Parameters<typeof updateRole>[1]) =>
    setPending({ role, label, body });

  /* **待确认的改动要看得见。**
     这些复选框是受控的，checked 读的是服务端给的那份角色。
     propose() 只是把改动记下来、并不改它 —— 于是点下去之后
     复选框自己弹回原位，界面上唯一的变化是下面多出一张确认卡。
     人会以为自己没点中，再点一次（把改动翻回去），然后对着
     一张说"获得"的卡片确认一个"失去"。

     所以渲染时把待确认的那一项叠上去：看到的就是确认之后的样子。 */
  const view = (r: Role): Role => {
    if (!pending || pending.role.id !== r.id) return r;
    const { reason: _reason, ...patch } = pending.body;
    return { ...r, ...patch } as Role;
  };
  /* 一次只谈一项改动 —— 确认卡上写的就是一句话，
     允许同时攒好几项的话，那句话就说不全了。 */
  const locked = (r: Role) => pending !== null && pending.role.id !== r.id;

  return (
    <>
      <div className="card stack" style={{ marginBottom: 12 }}>
        <div className="spread">
          <h3>行范围 · 字段</h3>
          <span className="muted">改完立即生效 —— 导航、数据范围、字段遮罩同时变</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>角色</th><th>行范围（看得到哪些中心）</th>
                {Object.entries(FIELD_LABEL).map(([k, v]) =>
                  <th key={k} className="tick">{v}</th>)}
                <th>可访问模块</th>
              </tr>
            </thead>
            <tbody>
              {roles.map(r0 => {
                const r = view(r0);
                return (
                <tr key={r.id} data-testid="role-row">
                  <td><div>{r.name}</div><div className="muted mono">{r.code}{r.isExternal && " · 外部"}</div></td>
                  <td>
                    <select value={r.rowRule} data-testid={`rowrule-${r.code}`}
                      disabled={locked(r0)}
                      onChange={e => propose(r0,
                        `${r.name} 的行范围改为「${ROW_RULE[e.target.value]}」`,
                        { rowRule: e.target.value, reason: "" })}>
                      {Object.entries(ROW_RULE).map(([k, v]) =>
                        <option key={k} value={k}>{v}</option>)}
                    </select>
                  </td>
                  {Object.keys(FIELD_LABEL).map(f => (
                    <td key={f} className="tick">
                      <input type="checkbox" checked={r.visibleFields.includes(f)}
                        data-testid={`field-${r.code}-${f}`} disabled={locked(r0)}
                        aria-label={`${r.name} · ${FIELD_LABEL[f]}`}
                        onChange={e => propose(r0,
                          `${r.name} ${e.target.checked ? "获得" : "失去"}「${FIELD_LABEL[f]}」`,
                          { visibleFields: e.target.checked
                              ? [...r0.visibleFields, f]
                              : r0.visibleFields.filter(x => x !== f),
                            reason: "" })} />
                    </td>
                  ))}
                  <td>
                    <button className="btn" disabled={locked(r0)} onClick={() => setModsFor(r0)}>
                      {r.modules.length} 个模块
                    </button>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card stack" style={{ marginBottom: 12 }}>
        <div className="spread"><h3>动作权限</h3><span className="muted">能看到不等于能操作</span></div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>角色</th>{Object.entries(ACTION_LABEL).map(([k, v]) =>
                <th key={k} className="tick">{v}</th>)}</tr>
            </thead>
            <tbody>
              {roles.map(r0 => {
                const r = view(r0);
                return (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  {Object.keys(ACTION_LABEL).map(a => (
                    <td key={a} className="tick">
                      <input type="checkbox" checked={r.allowedActions.includes(a)}
                        data-testid={`action-${r.code}-${a}`} disabled={locked(r0)}
                        aria-label={`${r.name} · ${ACTION_LABEL[a]}`}
                        onChange={e => propose(r0,
                          `${r.name} ${e.target.checked ? "获得" : "失去"}「${ACTION_LABEL[a]}」`,
                          { allowedActions: e.target.checked
                              ? [...r0.allowedActions, a]
                              : r0.allowedActions.filter(x => x !== a),
                            reason: "" })} />
                    </td>
                  ))}
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {modsFor && (
        <ModulePicker role={modsFor} onClose={() => setModsFor(null)}
          onSave={(modules, label) => { setModsFor(null); propose(modsFor, label, { modules, reason: "" }); }} />
      )}

      {pending && (
        <ConfirmChange pending={pending} onCancel={() => setPending(null)}
          onGo={reason => void run(pending.label, async () => {
            await updateRole(pending.role.id, { ...pending.body, reason });
            setPending(null);
          })} />
      )}

      <div className="derive">
        权限是三件事同时成立，缺一个都会出事：<br />
        <b>行</b>：你看得到哪些中心。CRA 只看被指派的、PM 看本组的、机构办只看本院的。<br />
        <b>列</b>：同一行里哪些字段对你可见。CRA 看得到中心，看不到它的成本与毛利。<br />
        <b>动作</b>：你能对它做什么。QA 看得到全部质量事件，也只有 QA 能关闭。<br />
        <b>外部角色默认拒绝</b>：机构办与研究者的字段权限初始全关，靠白名单一项项加回来 ——
        而不是"先给全部再关掉敏感的"。两种做法在正常情况下结果一样，
        在<b>新增一个字段</b>时结果完全相反：前者新字段默认不可见，后者新字段默认泄漏。
      </div>
    </>
  );
}

/** 每一次权限变更都要一句理由。**这不是走过场** ——
 *  「谁给谁开了什么」是核查必查项，而半年后只有这一行答得出"为什么"。 */
function ConfirmChange({ pending, onCancel, onGo }: {
  pending: { label: string }; onCancel: () => void; onGo: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <div className="card stack" data-testid="confirm-change" style={{ marginBottom: 12 }}>
      <strong>{pending.label}</strong>
      <p className="muted" style={{ margin: 0 }}>
        改完对该角色的<b>所有账号立即生效</b>，不需要谁重新登录。
        这一条会进审计轨迹，并标为敏感操作。
      </p>
      <label className="field"><span>原因</span>
        <input value={reason} data-testid="change-reason" autoFocus
          onChange={e => setReason(e.target.value)}
          placeholder="例：QA 需要看成本才能核算偏差的影响" /></label>
      <div className="row" style={{ justifyContent: "flex-end", gap: 6 }}>
        <button className="btn" onClick={onCancel}>取消</button>
        <button className="btn primary" data-testid="change-go" disabled={!reason.trim()}
          onClick={() => onGo(reason.trim())}>确认</button>
      </div>
    </div>
  );
}

/** 模块勾选。**收敛导航，不是安全边界** —— 勾掉一个模块，
 *  那个角色的侧栏立刻少一项，但接口该给的数据一点不少。 */
function ModulePicker({ role, onClose, onSave }: {
  role: Role; onClose: () => void; onSave: (modules: string[], label: string) => void;
}) {
  const [picked, setPicked] = useState<string[]>(role.modules);
  const toggle = (k: string) =>
    setPicked(p => p.includes(k) ? p.filter(x => x !== k) : [...p, k]);
  const n = picked.length - role.modules.length;

  return (
    <div className="card stack" data-testid="module-picker" style={{ marginBottom: 12 }}>
      <div className="spread">
        <h3>{role.name} 可访问的模块</h3>
        <button className="btn" onClick={onClose}>关闭</button>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        这一维<b>只收敛导航，不是安全边界</b>：勾掉一个模块，这个角色的侧栏立刻少一项，
        但接口该给他的数据一点不少 —— 真正的边界是上面那三维，在服务端。
      </p>
      {GROUP_ORDER.map(g => {
        const inGroup = MODULES.filter(m => m.group === g);
        if (!inGroup.length) return null;
        return (
          <div key={g}>
            <div className="muted" style={{ marginBottom: 4 }}>{g}</div>
            <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
              {inGroup.map(m => (
                <label key={m.key} className="row" style={{ gap: 5, alignItems: "center" }}>
                  <input type="checkbox" style={{ width: "auto" }}
                    checked={picked.includes(m.key)}
                    data-testid={`mod-${role.code}-${m.key}`}
                    onChange={() => toggle(m.key)} />
                  <span>{m.title}</span>
                  <span className="muted mono" style={{ fontSize: 11 }}>{m.key}</span>
                </label>
              ))}
            </div>
          </div>
        );
      })}
      <div className="row" style={{ justifyContent: "flex-end", gap: 6 }}>
        <span className="muted">
          {picked.length} 个模块{n !== 0 && `（${n > 0 ? "+" : ""}${n}）`}
        </span>
        <button className="btn primary" data-testid="modules-save"
          disabled={n === 0 && picked.every(k => role.modules.includes(k))}
          onClick={() => onSave(picked, `${role.name} 的可访问模块改为 ${picked.length} 个`)}>
          应用
        </button>
      </div>
    </div>
  );
}
