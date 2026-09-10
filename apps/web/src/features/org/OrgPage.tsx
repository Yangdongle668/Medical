import { useCallback, useEffect, useState } from "react";
import { ApiError, type ProblemDetails } from "../../api/client.js";
import { loadMe, type Me } from "../login/me.js";
import { MODULES, GROUP_ORDER } from "../../shell/modules.js";
/* 动作与列的清单来自契约，**表头与格子用同一份** —— 各用各的话，
   19 列表头配 13 列格子这种事不会报错，只会错位。 */
import { ACTION_KEYS, FIELD_KEYS } from "@sitedesk/contracts";
import {
  listAccounts, listRoles, listTeams, createAccount, updateAccount,
  disableAccount, enableAccount, setAccountPassword, setLoginAddress,
  createTeam, updateRole, listStudies, setStudyTeam,
  getMailTransport, setMailTransport, testMailTransport, type MailTransport,
  ROW_RULE, NEEDS_ORG_REF, FIELD_LABEL, ACTION_LABEL,
  type Account, type Role, type Team, type Study
} from "./api.js";
import { Pick, Field } from "../../shell/CreateForm.js";

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

type Tab = "user" | "group" | "perm" | "mail";

export function OrgPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [tab, setTab] = useState<Tab>("user");
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [studies, setStudies] = useState<Study[]>([]);
  const [mail, setMail] = useState<MailTransport | null>(null);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [a, r, t, st, m] = await Promise.all([
      listAccounts(), listRoles(), listTeams(), listStudies(),
      /* 通道读不到不该让整页挂掉 —— 它是这一页里最新的一块。 */
      getMailTransport().catch(() => null)]);
    setAccounts(a.items); setRoles(r.items); setTeams(t.items); setStudies(st.items);
    setMail(m);
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
           ["perm", `角色权限 ${roles.length}`],
           /* 通道没配的时候标出来 —— 它是"人进不进得来"的前提，
              而没配的表现是：链接签得出来、一封都发不出去、没有人报障。 */
           ["mail", `投递通道${mail && mail.source === "none" ? " ·未配" : ""}`]
          ] as [Tab, string][]).map(([k, label]) => (
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
        : tab === "user" ? <UserTab {...{ me, accounts, roles, teams, run }} goTab={setTab} />
        : tab === "group" ? <GroupTab {...{ accounts, teams, studies, run }} />
        : tab === "mail" ? <MailTab {...{ mail, run }} />
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
function UserTab({ me, accounts, roles, teams, run, goTab }: {
  me: Me; accounts: Account[]; roles: Role[]; teams: Team[]; run: Run;
  goTab: (t: Tab) => void;
}) {
  const [login, setLogin] = useState("");
  const [name, setName] = useState("");
  const [roleId, setRoleId] = useState("");
  const [teamId, setTeamId] = useState("");
  const [orgRef, setOrgRef] = useState("");
  const [pw, setPw] = useState("");
  const [editing, setEditing] = useState<Account | null>(null);
  const [pwFor, setPwFor] = useState<Account | null>(null);
  const [addrFor, setAddrFor] = useState<Account | null>(null);

  /* 登录名的规则**与契约同一个正则**（CreateAccountBody）。
     在这里当场判，是因为服务端那句提示要等一次往返才看得到 ——
     而最自然的填法（「周敏」、「ZhouMin」）全都不合规。 */
  const loginOk = /^[a-z][a-z0-9_]{2,31}$/.test(login.trim());
  const loginBad = login.trim().length > 0 && !loginOk;

  const role = roles.find(r => r.id === roleId);
  /* hospital 规则的角色没有 orgRef 就是个"登得进来、一行都看不到"的账号。
     库里的触发器会拦（迁移 0002），但让人先看见比让人先撞上强。 */
  const needsOrg = role?.rowRule === NEEDS_ORG_REF;

  /* 初始口令是**可选**的：外部角色（机构办 / PI）走一次性链接那条路，
     本来就不该有口令。留空就是不设。
     长度这一档当场判；弱口令表那一档在服务端，抄过来两边迟早对不上。 */
  const pwOk = pw.length === 0 || (pw.length >= 8 && pw.length <= 200);
  const pwBad = pw.length > 0 && !pwOk;

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
          <label className="field">
            <span>
              登录账号 <span className="t-mut">· 3–32 位小写字母 / 数字 / 下划线，且以字母开头</span>
            </span>
            <input value={login} data-testid="new-login" className="mono"
              aria-invalid={loginBad || undefined}
              onChange={e => setLogin(e.target.value)} placeholder="例：zhoumin" />
            {/* 姓名那一栏收中文，这一栏不收 —— 说清楚，而不是等服务端拒。 */}
            {loginBad && (
              <span className="t-crit" data-testid="new-login-bad" style={{ fontSize: 12 }}>
                只能用小写字母 / 数字 / 下划线，以字母开头，至少 3 位 ——
                中文和大写都不行（姓名填在左边那一栏）。
              </span>
            )}
          </label>
          <Pick label="角色" v={roleId} on={setRoleId} testid="new-role"
            options={roles.map(r => ({ value: r.id, label: r.name }))}
            empty="这个租户一个角色都没有 —— 九个标准角色是开户时铺进去的（app.provision_tenant_roles）。出现这句话说明开户没跑完，建号也无从谈起。" />
          {/* 分组是在**另一个标签页**里建的，而人是在这里发现自己需要它的。
               `action` 就是那条去路 —— 一个只列现有分组的下拉框
               答不出"没有我要的那个怎么办"。 */}
          <Pick label="分组" hint="决定 PM 看得到哪些项目"
            v={teamId} on={setTeamId} testid="new-team" placeholder="不分组"
            options={teams.map(t => ({ value: t.id, label: t.name }))}
            empty="还一个分组都没有。项目总监（PM）的行范围规则是「本组承接的项目」—— 没有分组，他登进来一个项目都看不到。"
            action={{ label: "去「分组」页建一个", on: () => goTab("group") }} />
        </div>
        {needsOrg && (
          <label className="field"><span>
            所属机构（必填）—— 这个角色按「本院承接的项目」切行，
            不填的话他登得进来，但一行数据都看不到
          </span>
            <input value={orgRef} data-testid="new-orgref"
              onChange={e => setOrgRef(e.target.value)} placeholder="例：北京协和医院" /></label>
        )}
        {/* 初始口令与建号在**同一次提交**里。分成两步的话中间那一格
            是真的会停在那里的：建完号手头有别的事，账号在库里、人进不来，
            而台账上看不出这两件事没配套（「怎么进来」那一列只报收件地址，
            报不了口令 —— auth_password 严格只看得见自己那一行）。 */}
        <label className="field">
          <span>
            初始口令 <span className="t-mut">· 可留空 · 至少 8 位 —— 他第一次登录会被要求改掉</span>
          </span>
          <input value={pw} data-testid="new-password" type="password" autoComplete="new-password"
            aria-invalid={pwBad || undefined}
            onChange={e => setPw(e.target.value)}
            placeholder="留空 = 不设口令，靠一次性链接进来" />
          {pwBad && (
            <span className="t-crit" data-testid="new-password-bad" style={{ fontSize: 12 }}>
              至少 8 位（现在 {pw.length} 位）。不想设就整个留空 ——
              机构老师和 PI 本来就该走一次性链接那条路。
            </span>
          )}
        </label>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button className="btn primary" data-testid="create-account"
            disabled={!loginOk || !pwOk || !name.trim() || !roleId || (needsOrg && !orgRef.trim())}
            onClick={() => void run(
              pw ? `已建号 ${name}（${login}），初始口令已设 —— 他第一次登录会被要求改掉`
                 : `已建号 ${name}（${login}）`,
              async () => {
                await createAccount({
                  login: login.trim(), displayName: name.trim(), roleId,
                  teamId: teamId || null, orgRef: needsOrg ? orgRef.trim() : null,
                  ...(pw ? { password: pw } : {})
                });
                setLogin(""); setName(""); setTeamId(""); setOrgRef(""); setPw("");
              })}>
            创建账号
          </button>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          <b>进得来有两条路，建号时可以一并办掉。</b>
          上面那栏填了初始口令，账号建出来就能登 —— 当面把口令给他，
          他第一次登录时会被要求改掉，而且这个标记翻不回去。
          <br />
          另一条是<b>一次性链接</b>：给他登记收件地址（台账那一行的「设收件地址」），
          之后他自己在登录页申请。机构老师和 PI 走这条 —— 一周登录两次的人不该记密码。
          <b>没登记地址就去申请链接，接口会回一句「已发送」，但什么也不会发出去</b>
          （对外含糊是防账号枚举）—— 台账上「怎么进来」那一列就是为了让这件事看得见。
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
                <th>行范围</th><th>怎么进来</th><th>最近登录</th><th>状态</th><th />
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
                    {/* 自助那条路（一次性链接）通不通。**没登记收件地址时，
                        /v1/auth/magic-link 照样回一句「登录链接已发送」而
                        什么都没发** —— 对外含糊是防账号枚举，
                        但管理员这一侧必须看得见。

                        这里**只说链接这条路**：设没设过口令查不到，
                        auth_password 的行级策略严格只看得见自己那一行，
                        而那条策略是对的。所以下面那句话说的是
                        "自助进不来"，不是"进不来"。 */}
                    <td>
                      {a.hasLoginAddress
                        ? <span className="chip good" data-testid="has-address">
                            可自助申请链接
                          </span>
                        : <span className="chip warn" data-testid="no-address"
                            title="没登记收件地址 —— 申请登录链接会石沉大海，只能由管理员当面给初始口令">
                            未登记收件地址
                          </span>}
                    </td>
                    <td className="mono muted">{a.lastLoginAt?.slice(0, 10) ?? "从未"}</td>
                    <td>
                      <span className={`chip ${a.status === "active" ? "good" : "flat"}`}>
                        {a.status === "active" ? "在职" : "已停用"}
                      </span>
                    </td>
                    <td>
                      {/* 四个按钮一行排完，不换行 —— 换行时每行台账
                          长高一倍，十二行就多出四百多像素。 */}
                      <div className="row acts" style={{ gap: 4, justifyContent: "flex-end" }}>
                        <button className="btn" onClick={() => setEditing(a)}>改角色</button>
                        <button className="btn" onClick={() => setPwFor(a)}
                          /* 给自己设口令等于绕过"验旧口令"那道门 —— 服务端会拒，
                             这里先把按钮关掉，免得人点了才知道。 */
                          disabled={self} title={self ? "改自己的口令请用顶部的「改口令」" : undefined}>
                          设口令
                        </button>
                        {/* 「设收件地址」与「设口令」是同一件事的两条路：
                            让这个人进得来。链接那条是给机构老师与 PI 的
                            （一周登录两次的人不该记密码），口令那条是内部账号
                            当面给。所以两个按钮并排。 */}
                        <button className="btn" data-testid={`addr-${a.login}`}
                          onClick={() => setAddrFor(a)}>
                          {a.hasLoginAddress ? "换收件地址" : "设收件地址"}
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
      {addrFor && (
        <SetLoginAddress account={addrFor} onClose={() => setAddrFor(null)}
          onSave={(address, reason) => run(
            `${addrFor.displayName} 的登录链接以后送到这个地址 —— 他可以自己在登录页申请了`,
            async () => { await setLoginAddress(addrFor.id, address, reason); setAddrFor(null); })} />
      )}
    </>
  );
}

/* ── 登记登录链接的收件地址 ────────────────────────────────────────
   这一栏是**写进去、读不回来**的：台账上只报「登记过没有」。
   要判断的是"这个人自助进得来吗"，而把一屋子人的邮箱手机号铺在
   列表页上，是为了一个判断付一整页的代价。登记错了就再登记一次。

   **能改地址等于能拿到那个人的登录链接。** 界面上要把这句话说出来 ——
   管理员本来就能用「设口令」接管任何账号，所以这不是新增的能力，
   但它同样悄无声息，而悄无声息的事更该在按下去之前被说一遍。 */
function SetLoginAddress({ account, onClose, onSave }: {
  account: Account; onClose: () => void;
  onSave: (address: string, reason: string) => Promise<void>;
}) {
  const [address, setAddress] = useState("");
  const [reason, setReason] = useState("");
  const t = address.trim();
  /* 形状的真相在服务端的 app.set_login_address（运维脚本走的是同一个函数）。
     这里同一条口径先判一遍，是因为一个打错的地址不会报错 ——
     它只让那个人永远收不到链接，而他会以为是系统坏了。 */
  const ok = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t) || /^\+?[0-9][0-9 -]{5,19}$/.test(t);

  return (
    <div className="card stack" data-testid="set-login-address" style={{ marginTop: 12 }}>
      <div className="spread">
        <h3>{account.displayName} 的登录链接送到哪里</h3>
        <button className="btn link" onClick={onClose}>取消</button>
      </div>
      <label className="field">
        <span>邮箱或手机号</span>
        <input value={address} data-testid="addr-input" className="mono"
          placeholder="例：zhanghm@pumch.cn 或 13800138000"
          aria-invalid={t.length > 0 && !ok ? true : undefined}
          onChange={e => setAddress(e.target.value)} />
        {t.length > 0 && !ok && (
          <span className="t-crit" data-testid="addr-bad" style={{ fontSize: 12 }}>
            既不像邮箱也不像手机号 —— 打错的地址不会报错，
            只会让这个人永远收不到链接。
          </span>
        )}
      </label>
      <label className="field">
        <span>理由（必填，至少 4 字）</span>
        <input value={reason} data-testid="addr-reason"
          placeholder="例：入职登记，本人邮箱已核对"
          onChange={e => setReason(e.target.value)} />
      </label>
      <div className="derive">
        <b>能改收件地址，等于能拿到这个人的登录链接。</b>
        所以这一下要 <span className="mono">manage</span> 权限，
        并且<b>进审计轨迹</b> —— 记的是"谁给谁登记过"，不记地址本身。
        <br />
        一个账号只留一个地址，再登记一次就是更换。
        这个地址<b>已经属于别的账号时会被拦下</b>，不会悄悄改绑 ——
        那等于把那个人的入口转走。
      </div>
      <div className="row">
        <button className="btn primary" data-testid="addr-go"
          disabled={!ok || reason.trim().length < 4}
          onClick={() => void onSave(t, reason.trim())}>登记</button>
      </div>
    </div>
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
        <Pick label="角色" v={roleId} on={setRoleId} testid="edit-role" placeholder={null}
          options={roles.map(r => ({ value: r.id, label: r.name }))}
          empty="这个租户一个角色都没有 —— 开户时铺的九个标准角色没进去。" />
        <Pick label="分组" v={teamId} on={setTeamId} testid="edit-team"
          placeholder="不分组"
          options={teams.map(t => ({ value: t.id, label: t.name }))}
          empty="还一个分组都没有 —— 去「分组」页建一个，再回来把人放进去。" />
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
function GroupTab({ accounts, teams, studies, run }: {
  accounts: Account[]; teams: Team[]; studies: Study[]; run: Run;
}) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [lead, setLead] = useState("");
  const internal = accounts.filter(a => a.status === "active" && !a.isExternal);
  const unassigned = internal.filter(a => !a.team);
  const 无主 = studies.filter(st => !st.team);

  return (
    <>
      <div className="card stack" style={{ marginBottom: 12 }}>
        <div className="spread">
          <h3>新建分组</h3>
          <span className="muted">分组决定 PM 的行范围：只看得到本组承接的项目</span>
        </div>
        <div className="grid-form">
          <label className="field"><span>代号 <span className="t-mut">· 留空即自动</span></span>
            <input value={code} data-testid="team-code" className="mono"
              onChange={e => setCode(e.target.value)} placeholder="自动生成，如 G-04" /></label>
          <label className="field"><span>组名</span>
            <input value={name} data-testid="team-name"
              onChange={e => setName(e.target.value)} placeholder="例：华中组" /></label>
          <Pick label="组长" v={lead} on={setLead} testid="team-lead"
            placeholder="暂不指定"
            options={internal.map(a => ({
              value: a.id, label: `${a.displayName}（${a.role.name}）` }))}
            empty="还没有在职的内部人员可以当组长 —— 先在「人员账号」页建号。组长可以之后再指定，不挡着建组。" />
        </div>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button className="btn primary" data-testid="create-team"
            disabled={!name.trim()}
            onClick={() => void run(`已建分组 ${name}`, async () => {
              await createTeam({
                ...(code.trim() ? { code: code.trim() } : {}),
                name: name.trim(), leadAccountId: lead || null });
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
            {/* 承接的项目 —— **这就是这个组的行范围本身**。
                在此之前这一栏只有一个数字（上面那句"承接 N 个项目"），
                哪几个、怎么改都答不出来，改归属只能直接改库。 */}
            <StudyOwnership team={t} studies={studies} teams={teams} run={run} />

            <Pick label="添加成员" v="" testid={`team-add-${t.code}`}
              style={{ maxWidth: 320 }}
              on={id => {
                if (!id) return;
                const a = internal.find(x => x.id === id)!;
                void run(`${a.displayName} 已加入 ${t.name}`,
                  () => updateAccount(id, { teamId: t.id, reason: `加入分组 ${t.name}` }));
              }}
              options={internal.filter(a => a.team?.id !== t.id).map(a => ({
                value: a.id,
                label: `${a.displayName}（${a.role.name}${a.team ? ` · 现属 ${a.team.name}` : ""}）`
              }))}
              empty={internal.length === 0
                ? "还没有在职的内部人员 —— 先在「人员账号」页建号。"
                : "在职的内部人员都已经在本组了。"} />
          </div>
        );
      })}

      {无主.length > 0 && (
        <div className="card stack" data-testid="unowned-studies" style={{ marginBottom: 12 }}>
          <div className="spread">
            <h3>没有归属组的项目（{无主.length}）</h3>
            <span className="muted">只有行范围「全部」的人看得到它们</span>
          </div>
          {/* 这一块平时是空的。它非空的时候，说明有项目是由不在任何组里的人
              提交、也由不在任何组里的人批准的 —— 那些项目现在谁的台账上都没有。 */}
          {无主.map(st => (
            <div className="row" key={st.id} style={{ gap: 8, alignItems: "center" }}>
              <span className="mono">{st.code}</span>
              <span>{st.shortName}</span>
              <span className="sp" />
              <MoveStudy study={st} teams={teams} run={run} />
            </div>
          ))}
        </div>
      )}

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
        <b>项目是怎么归到组里的：批准立项那一刻，归给提交人所在的组。</b>
        （这句话从前是"只有直接改库"——「批准立项」当时根本不写 team_study，
        于是每个走完流程的项目都没有归属组，而 PM 的行范围全靠它：
        项目批下来了，做可行性调查的那个人却选不到它。）
        <br />
        <b>还缺一个入口：把项目从 A 组划到 B 组。</b> 现在改归属仍然只能直接改库 ——
        接手、拆组、并组都会需要它。
      </div>
    </>
  );
}

/* ════════════════════════════════════════════════════════════════════
   一个组承接哪些项目 —— 以及把其中一个划走。

   **这不是一张标签列表，它就是这个组的行范围。** 划走那一刻，
   这个组的 PM 看不见这个项目、它下面的全部中心、那些中心上的
   受试者与工时。所以每一次都要写原因，而且写进审计。
   ════════════════════════════════════════════════════════════════════ */
function StudyOwnership({ team, studies, teams, run }: {
  team: Team; studies: Study[]; teams: Team[]; run: Run;
}) {
  const 本组 = studies.filter(st => st.team?.id === team.id);
  return (
    <div className="stack" style={{ gap: 6 }}>
      <span style={{ color: "var(--ink-3)", fontSize: 12 }}>
        承接的项目{本组.length ? `（${本组.length}）` : ""}
      </span>
      {本组.length === 0
        ? <span className="muted" data-testid={`team-studies-${team.code}-empty`}>
            本组还没有承接任何项目 —— <b>这个组的 PM 现在一个项目都看不到</b>。
            项目在批准立项时归给提交人所在的组；也可以从别的组划过来。
          </span>
        : 本组.map(st => (
            <div className="row" key={st.id} data-testid="team-study-row"
              style={{ gap: 8, alignItems: "center" }}>
              <span className="mono">{st.code}</span>
              <span>{st.shortName}</span>
              <span className="sp" />
              <MoveStudy study={st} teams={teams} run={run} />
            </div>
          ))}
    </div>
  );
}

/** 「划到别的组」那一下。展开成一行：选组 + 写原因 + 确认。
 *
 *  不做成一个直接生效的下拉 —— 它和「添加成员」不是一回事：
 *  加个人进组，看错了退出来就是；划走一个项目，原来那个组的人
 *  在你松手那一刻就看不见它了，而他们不会收到任何通知。 */
function MoveStudy({ study, teams, run }: {
  study: Study; teams: Team[]; run: Run;
}) {
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");
  const 别的组 = teams.filter(t => t.id !== study.team?.id);

  if (!open) return (
    <button className="btn link" data-testid={`move-${study.code}`}
      onClick={() => setOpen(true)}>划到别的组</button>
  );

  return (
    <div className="stack" style={{ gap: 6, flex: "1 1 100%" }}>
      <div className="row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
        <Pick label="划给" v={to} on={setTo} testid={`move-to-${study.code}`}
          style={{ minWidth: 200 }}
          placeholder={study.team ? "— 收回归属（谁也不承接）—" : "— 选一个组 —"}
          options={别的组.map(t => ({ value: t.id, label: `${t.name}（${t.code}）` }))}
          empty="没有别的组可以划 —— 先去上面建一个。" />
        <label className="field" style={{ flex: "2 1 260px" }}>
          <span>原因 <span className="t-mut">· 至少 4 字，进审计轨迹</span></span>
          <input value={reason} data-testid={`move-reason-${study.code}`}
            onChange={e => setReason(e.target.value)}
            placeholder="例：华东组人手不足，本项目移交华中组承接" />
        </label>
        <button className="btn primary" data-testid={`move-go-${study.code}`}
          disabled={reason.trim().length < 4}
          onClick={() => void run(
            to ? `${study.code} 已划走` : `${study.code} 已收回归属`,
            async () => {
              await setStudyTeam(study.id, to || null, reason.trim());
              setOpen(false); setTo(""); setReason("");
            })}>
          确认
        </button>
        <button className="btn link" onClick={() => { setOpen(false); setTo(""); setReason(""); }}>
          取消
        </button>
      </div>
      <span className="t-crit" style={{ fontSize: 12 }}>
        <b>这是权限变更。</b>
        {study.team ? `${study.team.name} ` : "原来能看到它的人"}
        的项目总监从确认那一刻起看不见 {study.code}、看不见它下面的全部中心、
        也看不见那些中心上的受试者与工时。他们不会收到通知。
      </span>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════
   投递通道。

   登录链接靠它送出去。在此之前**没有这一页** —— SITEDESK_SMTP_URL
   只能由能改环境变量、能重启进程的人来设，于是一套装好的系统里，
   管理员建得了账号、设得了口令、登记得了收件地址，
   **唯独没法让链接真的发出去**。login-delivery.ts 自己把这条写着：
   「签发权限等同于运维权限，这是上线前该补掉的一项。」

   三件事这一页必须说清楚：
   ① 现在到底有没有通道（没有的话，链接照签、没人收得到、没有人会报障）；
   ② 口令存了没有 —— 但**不给看**（能读回口令的设置页 = 发凭证）；
   ③ 配完能自己验一次，否则真假要等第一个人申请链接时才知道。
   ════════════════════════════════════════════════════════════════════ */
function MailTab({ mail, run }: { mail: MailTransport | null; run: Run }) {
  const [kind, setKind] = useState<"smtp" | "none">(mail?.kind ?? "none");
  const [url, setUrl] = useState(mail?.url ?? "");
  const [from, setFrom] = useState(mail?.fromAddr ?? "");
  const [user, setUser] = useState(mail?.username ?? "");
  const [secret, setSecret] = useState("");
  const [clearSecret, setClearSecret] = useState(false);
  const [reason, setReason] = useState("");
  const [testing, setTesting] = useState(false);
  const [testSaid, setTestSaid] = useState<string | null>(null);

  if (!mail) return <p className="muted">投递通道读不出来 —— 刷新一次看看。</p>;

  const 源 = { db: "在这一页配的", env: "还在用环境变量", none: "两处都没有" }[mail.source];
  const ready = reason.trim().length >= 4 &&
    (kind === "none" || (url.trim() !== "" && from.trim() !== ""));

  return (
    <>
      {/* 最要紧的一句放最上面：现在到底发不发得出去。 */}
      {mail.source === "none" ? (
        <div className="problem" data-testid="mail-none" style={{ marginBottom: 12 }}>
          <b>还没有投递通道 —— 登录链接发不出去。</b>
          系统照样签得出令牌，但没有人收得到：忘记口令的人只能找能进服务器的人
          用 <span className="mono">deploy/login-link.sh</span> 代发，
          也就是说<b>签发登录链接的权限现在等同于运维权限</b>。
        </div>
      ) : (
        <p className="muted" data-testid="mail-source" style={{ marginBottom: 12 }}>
          当前通道：<b>{mail.kind === "smtp" ? mail.url : "已关闭"}</b>（{源}）
          {mail.updatedByName && <> · 最近由 {mail.updatedByName} 改过</>}
        </p>
      )}

      <div className="card stack" style={{ marginBottom: 12 }}>
        <div className="spread">
          <h3>SMTP 服务器</h3>
          <span className="muted">登录链接与系统通知都走这一条</span>
        </div>

        <Pick label="通道" v={kind} on={v => setKind(v as "smtp" | "none")}
          testid="mail-kind" placeholder={null}
          options={[{ value: "smtp", label: "SMTP（发邮件）" },
                    { value: "none", label: "关闭 —— 链接照签，但没有人收得到" }]}
          empty="通道类型是一份固定清单，这里空了说明前端常量没打包进来。" />

        {kind === "smtp" && (
          <>
            <div className="grid-form">
              <Field label="服务器地址" testid="mail-url" v={url} on={setUrl}
                hint="smtps://host:465 或 smtp://host:587 —— 不要带口令"
                placeholder="smtps://smtp.example.com:465" />
              <Field label="发件人" testid="mail-from" v={from} on={setFrom}
                hint="没有它，多数服务器直接拒收"
                placeholder="中心台 <no-reply@example.com>" />
              <Field label="用户名" testid="mail-user" v={user} on={setUser}
                hint="服务器不需要认证就留空" placeholder="no-reply@example.com" />
            </div>

            {/* 口令那一栏。**读不回来**，所以这里只说"存了没有"。 */}
            <label className="field">
              <span>
                口令
                <span className="t-mut">
                  {" · "}
                  {mail.secretSet ? "已存一个（读不回来）· 留空 = 不动它" : "还没有存"}
                </span>
              </span>
              <input type="password" autoComplete="new-password" value={secret}
                data-testid="mail-secret" disabled={clearSecret || !mail.keyReady}
                onChange={e => setSecret(e.target.value)}
                placeholder={mail.secretSet ? "不改就留空" : "服务器的登录口令"} />
              {!mail.keyReady && (
                <span className="t-crit" data-testid="mail-nokey" style={{ fontSize: 12 }}>
                  <b>服务器上还没有配 SITEDESK_SECRET_KEY，口令存不下来。</b>
                  在服务器上设一个（<span className="mono">openssl rand -base64 32</span>）
                  再回来填 —— 这里<b>不会悄悄存明文</b>：一份会进备份、进从库、
                  进 dump 的明文口令，比这个功能暂时不能用糟得多。
                  服务器不需要认证的话，这一栏本来就该空着。
                </span>
              )}
              {mail.secretSet && (
                <label className="cbx" style={{ marginTop: 6 }}>
                  <input type="checkbox" checked={clearSecret} data-testid="mail-clear"
                    onChange={e => { setClearSecret(e.target.checked); setSecret(""); }} />
                  <span>清掉已存的口令（这台服务器不需要认证）</span>
                </label>
              )}
            </label>
          </>
        )}

        <Field label="原因" testid="mail-reason" v={reason} on={setReason}
          hint="至少 4 字，进审计轨迹"
          placeholder="例：接入公司邮件服务器，登录链接不再靠运维代发" />

        <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
          <button className="btn primary" data-testid="mail-save" disabled={!ready}
            onClick={() => void run("投递通道已更新", async () => {
              await setMailTransport({
                kind,
                url: url.trim() || null, fromAddr: from.trim() || null,
                username: user.trim() || null,
                /* 三种意思分得开：勾了「清掉」传空串，填了传新的，
                   都没有就**整个不传** —— 那是"不动它"。 */
                ...(clearSecret ? { secret: "" } : secret ? { secret } : {}),
                reason: reason.trim()
              });
              setSecret(""); setClearSecret(false); setReason("");
            })}>
            保存
          </button>
        </div>

        <div className="derive">
          <b>换一台服务器就是换一台机器去读所有人的登录链接。</b>
          指向一台会记日志的中继，等于把每一个链接抄送一份 —— 而被冒用的人
          在审计轨迹里看到的是他自己。所以这一步写审计、必须写原因。
        </div>
      </div>

      {/* 配完要能自己验一次 —— 否则真假要等第一个真人申请链接时才知道，
          而没收到的那个人不会来报，他只会以为系统坏了。 */}
      <div className="card stack">
        <div className="spread">
          <h3>试发一封</h3>
          <span className="muted">发给你自己登记的收件地址，不能指定别人</span>
        </div>
        {mail.lastTestAt && (
          <p className="muted" data-testid="mail-last-test" style={{ margin: 0 }}>
            最近一次试发：
            <span className={`chip ${mail.lastTestOk ? "good" : "crit"}`}>
              {mail.lastTestOk ? "成功" : "失败"}
            </span>{" "}
            {mail.lastTestAt.slice(0, 16).replace("T", " ")}
            {mail.lastTestError && <> · {mail.lastTestError}</>}
          </p>
        )}
        {testSaid && <p data-testid="mail-test-said">{testSaid}</p>}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button className="btn" data-testid="mail-test" disabled={testing}
            onClick={() => void (async () => {
              setTesting(true); setTestSaid(null);
              try {
                const r = await testMailTransport();
                setTestSaid(r.data.ok
                  ? `发出去了，收件地址 ${r.data.sentTo} —— 去收件箱看一眼再走。`
                  : `没发出去：${r.data.error}`);
              } catch (e) {
                setTestSaid(e instanceof ApiError
                  ? (e.problem.detail ?? e.problem.title) : String(e));
              } finally { setTesting(false); }
            })()}>
            {testing ? "发送中…" : "试发一封"}
          </button>
        </div>
        <div className="derive">
          <b>「配好了」和「发得出去」是两件事。</b>
          不验这一次的话，真假要等第一个真人申请登录链接时才知道 ——
          而没收到的那个人不会来报障，他只会以为系统坏了。
        </div>
      </div>
    </>
  );
}

/** 角色名的短写，给动作矩阵当列头用。
 *
 *  库里的名字是「临床协调员 CRC」这种"全称 + 缩写"的写法，而九列表头
 *  排在一起时全称一列要占三行。取名字里那段拉丁缩写 —— 那本来就是
 *  这些角色平时被叫的名字（没人说"临床监查员"，都说 CRA）。
 *  没有缩写的（系统管理员、经营层）就用原名，它们本来也短。
 *  完整名字留在 `title` 里，也留在上面那张「行范围 · 字段」表的第一列。 */
export function shortName(name: string): string {
  return name.match(/[A-Z]{2,}/)?.[0] ?? name;
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
                  {FIELD_KEYS.map(f => (
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

      {/* ── 动作权限：**动作在行，角色在列** ──────────────────────────
          反过来写（角色在行、18 个动作当表头）时这张表是坏的，而且是
          两处一起坏：18 个中文表头把「角色」那一列挤到只剩一个字宽，
          于是"系统管理员"竖着排成五行，每行高 90px；同时那 18 列还是
          放不下，后八列要横向滚出去才看得到。9 行的表长到 810px，
          却只露得出十列。

          长标签在左、短标签在头，是表格本来的读法：18 行各一行高，
          九列角色横着排得下 —— 一屏之内看得完，也不用横向滚。 */}
      <div className="card stack" style={{ marginBottom: 12 }}>
        <div className="spread"><h3>动作权限</h3><span className="muted">能看到不等于能操作</span></div>
        <div className="table-wrap">
          <table className="matrix">
            <thead>
              <tr>
                <th>动作</th>
                {roles.map(r0 => (
                  <th key={r0.id} className="tick" title={r0.name}>{shortName(r0.name)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ACTION_KEYS.map(a => (
                <tr key={a} data-testid={`action-row-${a}`}>
                  <th scope="row">{ACTION_LABEL[a]}</th>
                  {roles.map(r0 => {
                    const r = view(r0);
                    return (
                      <td key={r0.id} className="tick">
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
                    );
                  })}
                </tr>
              ))}
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
