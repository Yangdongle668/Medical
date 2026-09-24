import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { call, ApiError, type ProblemDetails } from "../../api/client.js";
import { useToast } from "@sitedesk/ui/react";
import { Pick, Field } from "../../shell/CreateForm.js";

/* ════════════════════════════════════════════════════════════════════
   这个中心上有谁。

   ── 为什么它属于中心详情页 ──────────────────────────────────────
   「派工与产能」那一页是**按人**看的：这个人跑哪几个中心、证书还剩几天。
   站在一个中心跟前要问的是反过来的那句：**这个中心归谁跑、研究者是谁。**
   同一份数据的两个方向，而缺了这一个方向，
   "SS-02 的 CRA 是谁"就只能靠一个个人去翻。

   ── 两栏，两种来源，说清楚 ──────────────────────────────────────
   · CRA / CRC 来自 `site_assignment`（行规则 `assigned`）；
   · PI 来自 `study_site.pi_account_id`（行规则 `pi`）。

   看着像一张名单，其实是两条不同的行规则。所以这里**分开列**，
   而不是拼成一栏"相关人员" —— 拼起来之后，
   "为什么把张三加进来他还是看不见"就没有地方回答了。

   ── PI 那一栏在这一版之前只有建档时能写 ─────────────────────────
   `createStudySite` 收 `piAccountId`，而建档表单从来没有那一栏。
   于是 PI 账号建得出来、登得进去、菜单也在，**一个中心都看不到**：
   `pi` 这条行规则从头到尾是空的，而空的表现是"研究者工作台是空页"，
   不是一条报错。
   ════════════════════════════════════════════════════════════════════ */

interface Assignment {
  id: string; accountId: string; displayName: string; roleKind: string;
  siteCode: string; since: string;
}
interface Account {
  id: string; displayName: string; login: string;
  role: { code: string; name: string; isExternal: boolean };
  status: string;
}

export function SiteCrew({ siteId, piName, piAccountId, canAssign, onChanged }: {
  siteId: string;
  piName: string;
  piAccountId: string | null;
  canAssign: boolean;
  onChanged: () => void;
}) {
  const [crew, setCrew] = useState<Assignment[] | null>(null);
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [pick, setPick] = useState(piAccountId ?? "");
  const [name, setName] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const say = useToast();
  const nav = useNavigate();

  const load = useCallback(() => {
    void call<{ items: Assignment[] }>("listSiteAssignments",
      { query: { limit: 100, studySiteId: siteId } })
      .then(r => setCrew(r.items)).catch(() => setCrew([]));
  }, [siteId]);
  useEffect(load, [load]);

  /* 候选 PI 只在要改的时候才拉 —— 大多数时候这张卡片只是在看。
     而且**只有能改的人才拉**：账号台账对没有 manage 的人是 403，
     一次注定失败的请求会在控制台里留一条看起来像故障的红。 */
  useEffect(() => {
    if (!editing || accounts) return;
    void call<{ items: Account[] }>("listAccounts", { query: { limit: 200 } })
      .then(r => setAccounts(r.items)).catch(() => setAccounts([]));
  }, [editing, accounts]);

  async function save() {
    setBusy(true); setProblem(null);
    try {
      const r = await call<{ sideEffects: { summary: string }[] }>("setStudySitePi", {
        params: { id: siteId },
        body: {
          piAccountId: pick || null, reason: reason.trim(),
          ...(name.trim() ? { piName: name.trim() } : {})
        }
      });
      say(r.sideEffects[0]?.summary ?? "已更新研究者");
      setEditing(false); setReason(""); setName("");
      onChanged();
    } catch (e) {
      if (e instanceof ApiError) setProblem(e.problem); else throw e;
    } finally { setBusy(false); }
  }

  /* 能当 PI 绑的**按行规则判，不按"是不是外部方"判**：机构办也是外部方，
     但他按所属医院切行 —— 绑上去那一栏对他不起作用，
     而界面上看着是绑好了。契约里没有 rowRule 这一栏，
     所以这里按角色代号收：与服务端同一条判据（role.row_rule = 'pi'）。 */
  const 候选 = (accounts ?? []).filter(a => a.role.code === "pi" && a.status === "active");

  return (
    <section className="card stack" data-testid="site-crew">
      <div className="spread">
        <h3>这个中心上有谁</h3>
        <span className="sub">看得见这个中心的人，就是这张单子上的人</span>
      </div>

      {/* ── 研究者 PI ── */}
      <div>
        <div className="row spread">
          <span className="muted" style={{ fontSize: 12 }}>
            研究者 PI · 中心上登记的 PI 账号
          </span>
          {canAssign && !editing && (
            <button className="btn link" data-testid="edit-pi"
              onClick={() => { setEditing(true); setPick(piAccountId ?? ""); }}>
              {piAccountId ? "换一个 / 解绑" : "绑定研究者账号"}
            </button>
          )}
        </div>
        <div className="row" style={{ gap: 8, marginTop: 4 }}>
          <b>{piName}</b>
          {piAccountId
            ? <span className="chip good" data-testid="pi-bound">已绑账号</span>
            : <span className="chip warn" data-testid="pi-unbound">
                只是一个名字 —— 没有绑账号，他登进来一个中心也看不到
              </span>}
        </div>
      </div>

      {editing && (
        <div className="stack" data-testid="pi-form">
          {problem && (
            <div className="problem" data-testid="pi-problem">
              <strong>{problem.title}</strong>
              {problem.detail && <div>{problem.detail}</div>}
            </div>
          )}
          <div className="grid-form">
            <Pick label="研究者账号" v={pick} on={setPick} testid="pi-account"
              hint="只列行规则为「pi」的外部账号"
              placeholder="— 不绑账号 —"
              options={候选.map(a => ({
                value: a.id, label: `${a.displayName}（${a.login}）`
              }))}
              empty={accounts === null ? "加载中…"
                : "还没有研究者账号 —— 去「组织与权限」用「研究者 PI（外部）」这个角色建一个。"}
              action={{ label: "去建号", on: () => nav("/org") }} />
            <Field label="登记姓名" v={name} on={setName} testid="pi-name"
              placeholder={pick ? "留空即取该账号的显示名" : piName}
              hint="方案上写「张三 教授」而账号叫「张三」时填这里" />
          </div>
          <Field label="原因" v={reason} on={setReason} testid="pi-reason"
            placeholder="例：机构发文确认由他担任本中心主要研究者"
            hint="至少 4 个字，进审计轨迹" />
          <div className="row">
            <button className="btn btn-p" data-testid="pi-submit"
              disabled={reason.trim().length < 4 || busy}
              onClick={() => void save()}>{busy ? "提交中…" : "保存"}</button>
            <button className="btn link" data-testid="pi-cancel"
              onClick={() => { setEditing(false); setProblem(null); }}>取消</button>
            <span className="note">
              绑上那一刻，这位院方研究者<b>看得见</b>这个中心的受试者与访视，
              也能确认访视。解绑那一刻看不见。
            </span>
          </div>
        </div>
      )}

      {/* ── CRA / CRC ── */}
      <div>
        <span className="muted" style={{ fontSize: 12 }}>
          CRA / CRC · 来自派工
        </span>
        {crew === null
          ? <p className="muted">加载中…</p>
          : crew.length === 0
            ? <p className="problem" data-testid="crew-empty">
                <strong>这个中心还没有派工。</strong>
                {" "}除了管理层和本组的项目总监，
                没有任何 CRA / CRC 看得见它 ——
                受试者、访视、质疑、药品台账，一个人也打不开。
              </p>
            : (
              <ul className="tasks" data-testid="crew-list" style={{ marginTop: 6 }}>
                {crew.map(a => (
                  <li key={a.id}>
                    <span className="grow">
                      {a.displayName}
                      <span className="muted"> · {a.roleKind} · 自 {a.since}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
        {canAssign && (
          <div className="row" style={{ marginTop: 8 }}>
            {/* 派工与撤下都在「派工与产能」那一页 —— **不在这里再做一份**。
                那一页是按人组织的（他跑哪几个、证书还剩几天），
                而派工恰恰要先看那些：给一个证书上周过期的人再加中心，
                是在这一页上看不出来的。 */}
            <Link to="/staff" className="btn go" data-testid="go-staff">
              去派工与产能加人 / 撤人
            </Link>
          </div>
        )}
      </div>
    </section>
  );
}
