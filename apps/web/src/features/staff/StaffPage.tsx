import { useCallback, useEffect, useState } from "react";
import { call, ApiError, type ProblemDetails } from "../../api/client.js";
import { useToast } from "@sitedesk/ui/react";
import { loadMe } from "../login/me.js";
import { AssignForm } from "./AssignForm.js";

/* ════════════════════════════════════════════════════════════════════
   派工与产能。

   这一页盯两件会出事的事，而它们都不是"谁比较忙"：

   ① **GCP 证书过期。** 过期即不得开展工作 —— 不是提醒，是资质失效。
      一个证书上周过期的 CRA 还在中心干活，那是稽查发现项。
   ② **无继任者且带多个中心。** 这个人一旦离职，那几个中心当场断档。
      交接页解决的是"已经要走了"，这一页要在那之前就看得见。

   带几个中心是背景信息，不是结论：带 5 个小中心可能比带 2 个
   大中心轻松。所以数量只排序，不上色。

   ── 这一页叫「派工」，而它一直派不了工 ──────────────────────────
   `site_assignment` 是行规则 `assigned` 的唯一来源，而在这一版之前
   **全系统没有一处往里写**：种子灌了 30 行，交接在两个人之间挪行 ——
   挪的是已经存在的那些。第一行从哪来，没有答案。

   于是这一页有「带中心」那一列、有「无人可接」的角标，
   **唯独没有那个动词**。开发库的审计轨迹里留着绕过去的痕迹：

     09-06 11:13  admin  调整角色权限  crc
                  rowRule: assigned → team    理由：「改为按组切行」

   派不了工，就把整个角色的行规则改掉。一个建不出来的东西，
   会被人用改规则的方式绕过去，而绕过去之后没有任何地方是红的。
   ════════════════════════════════════════════════════════════════════ */

interface Staff {
  accountId: string; login: string; displayName: string; roleKind: string;
  level: string; city: string;
  gcpExpiresOn: string | null; gcpDaysLeft: number | null;
  mentorName: string | null; successorName: string | null;
  siteCount: number; successionGap: boolean;
  active: boolean; disabledReason: string | null;
}

interface Assignment {
  id: string; accountId: string; displayName: string; roleKind: string;
  studySiteId: string; siteCode: string; hospital: string;
  studyCode: string; studyShortName: string;
  since: string; until: string | null; active: boolean;
}

/* 契约里 ROLE_KINDS 就是大写的这五个（packages/contracts/src/site/staffing.ts）。
   这里不做映射，只兜底：将来加了一种工种而这里没跟上，
   页面上会看到那个原始值，而不是一片空白。 */
const roleKind = (k: string) => k;

export function StaffPage() {
  const [staff, setStaff] = useState<Staff[] | null>(null);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [activeOnly, setActiveOnly] = useState(true);
  const [canAssign, setCanAssign] = useState(false);
  /** 展开的那一行 —— **一次只展开一个人**：这一栏要回答的是
   *  「他现在跑哪几个」，同时摊开十个人只会把表撑成两屏。 */
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => {
    void call<{ items: Staff[] }>("listStaff",
      { query: { limit: 200, ...(activeOnly ? { activeOnly: true } : {}) } })
      .then(r => setStaff(r.items));
    /* 派工台账整张拉下来 —— 它是「谁在跑哪几个」的来源，
       而按人逐个去问会在 12 个人时发出 12 条请求。 */
    void call<{ items: Assignment[] }>("listSiteAssignments", { query: { limit: 500 } })
      .then(r => setAssignments(r.items)).catch(() => setAssignments([]));
  }, [activeOnly]);
  useEffect(load, [load]);
  useEffect(() => {
    void loadMe().then(m => setCanAssign(m.permissions.actions.includes("assign")))
      .catch(() => setCanAssign(false));
  }, []);

  if (!staff) return <p className="muted">加载中…</p>;

  const expired = staff.filter(s => s.active && s.gcpDaysLeft !== null && s.gcpDaysLeft < 0);
  const soon = staff.filter(s => s.active && s.gcpDaysLeft !== null
    && s.gcpDaysLeft >= 0 && s.gcpDaysLeft <= 60);
  const gaps = staff.filter(s => s.active && s.successionGap);

  return (
    <>
      <div className="page-head">
        <h2>派工与产能</h2>
        <p>谁在哪几个中心、资质还有多久、走了谁来接。</p>
      </div>

      <div className="stats" style={{ marginBottom: 14 }}>
        <Stat label="在职" v={staff.filter(s => s.active).length} note="人" />
        <Stat label="GCP 已过期" v={expired.length} note={expired.length ? "不得开展工作" : "无"} bad={expired.length > 0} />
        <Stat label="60 天内到期" v={soon.length} note="该安排复训了" />
        <Stat label="无继任者" v={gaps.length} note="带多个中心且没人接" bad={gaps.length > 0} />
      </div>

      {expired.length > 0 && (
        <div className="problem" style={{ marginBottom: 14 }} role="alert" data-testid="gcp-expired">
          <strong>{expired.map(s => s.displayName).join("、")} 的 GCP 证书已过期。</strong>
          <div className="muted">
            过期不是提醒，是<b>资质失效</b> —— 这几个人现在不得开展工作。
            他们名下还有 {expired.reduce((n, s) => n + s.siteCount, 0)} 个中心的派工。
          </div>
        </div>
      )}

      {/* 派工入口。在此之前这一页叫「派工与产能」而派不了工 ——
          唯一改变 site_assignment 的路是交接，而交接只挪已经存在的那些。 */}
      {canAssign && <AssignForm staff={staff} onDone={load} />}

      <label className="row" style={{ gap: 6, marginBottom: 12, alignItems: "center" }}>
        <input type="checkbox" style={{ width: "auto" }} checked={activeOnly}
          data-testid="active-only" onChange={e => setActiveOnly(e.target.checked)} />
        <span>只看在职</span>
      </label>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>姓名</th><th>工种</th><th>级别</th><th>城市</th>
              <th className="num">带中心</th><th>GCP</th><th>带教</th><th>继任者</th><th>状态</th>
            </tr>
          </thead>
          <tbody>
            {[...staff]
              /* 先按"要出事的"排：过期 → 无继任者 → 带得多。
                 按姓名排的话，这一页就只是一份通讯录。 */
              .sort((a, b) =>
                Number(gcpBad(b)) - Number(gcpBad(a))
                || Number(b.successionGap) - Number(a.successionGap)
                || b.siteCount - a.siteCount)
              .flatMap(s => {
                const 他的 = assignments.filter(a => a.accountId === s.accountId && a.active);
                const 展开 = open === s.accountId;
                return [
                  <tr key={s.accountId} data-testid="staff-row"
                    style={s.active ? undefined : { opacity: .55 }}>
                    <td>
                      {s.displayName}
                      <div className="muted mono" style={{ fontSize: 11 }}>{s.login}</div>
                    </td>
                    <td>{roleKind(s.roleKind)}</td>
                    <td className="muted">{s.level}</td>
                    <td className="muted">{s.city}</td>
                    <td className="num">
                      {/* 这个数一直在这儿，而点不开 —— 「他到底在跑哪几个」
                          此前这一页答不出来，要去别的页翻。 */}
                      {他的.length > 0
                        ? <button className="btn link" data-testid="open-sites"
                            aria-expanded={展开}
                            onClick={() => setOpen(展开 ? null : s.accountId)}>
                            {s.siteCount}
                          </button>
                        : s.siteCount}
                    </td>
                    <td>{gcpChip(s)}</td>
                    <td className="muted">{s.mentorName ?? "—"}</td>
                    <td>
                      {s.successorName
                        ? <span className="muted">{s.successorName}</span>
                        : s.successionGap
                          ? <span className="chip warn" data-testid="succession-gap">无人可接</span>
                          : <span className="muted">—</span>}
                    </td>
                    <td>
                      {s.active
                        ? <span className="chip good">在职</span>
                        : <>
                            <span className="chip flat">已停用</span>
                            {s.disabledReason && <div className="muted">{s.disabledReason}</div>}
                          </>}
                    </td>
                  </tr>,
                  ...(展开 ? [
                    <tr key={`${s.accountId}-sites`} data-testid="staff-sites">
                      <td colSpan={9} style={{ background: "var(--bg-2, #fafafa)" }}>
                        <SiteList who={s} rows={他的} canAssign={canAssign} onDone={load} />
                      </td>
                    </tr>
                  ] : [])
                ];
              })}
          </tbody>
        </table>
      </div>

      <div className="derive" style={{ marginTop: 14 }}>
        <b>带几个中心不上色。</b> 带 5 个小中心可能比带 2 个大中心轻松 ——
        这个数只用来排序，不用来下结论。真正会出事的是另外两件：
        资质过期（当场不能干活）和无人可接（一离职就断档）。
        <br />
        「无人可接」的判定是<b>带 3 个以上中心且没有登记继任者</b>，
        由服务端算（`successionGap`），不在这里重算 —— 两处各算一遍，
        迟早会有一页说有、另一页说没有。
      </div>
    </>
  );
}

/* ── 他现在跑哪几个中心，以及把他从其中一个撤下 ────────────────────
   撤下**必须写原因**，而且原因留在这一行上，不是弹一个对话框：
   对话框一关，"为什么撤的"就只剩审计里那一条，而点这一下的人
   此刻正需要它在眼前。 */
function SiteList({ who, rows, canAssign, onDone }: {
  who: Staff; rows: Assignment[]; canAssign: boolean; onDone: () => void;
}) {
  const [target, setTarget] = useState<Assignment | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const say = useToast();

  async function drop() {
    if (!target) return;
    setBusy(true); setProblem(null);
    try {
      const r = await call<{ sideEffects: { summary: string }[] }>("endSiteAssignment", {
        params: { id: who.accountId },
        body: { studySiteIds: [target.studySiteId], reason: reason.trim() }
      });
      say(r.sideEffects[0]?.summary ?? "已撤下");
      setTarget(null); setReason("");
      onDone();
    } catch (e) {
      if (e instanceof ApiError) setProblem(e.problem); else throw e;
    } finally { setBusy(false); }
  }

  return (
    <div className="stack" style={{ padding: "8px 2px" }}>
      <span className="muted" style={{ fontSize: 12 }}>
        {who.displayName} 现在负责这 {rows.length} 个中心 ——
        <b>这几行就是他看得见的范围本身</b>，不是一张排班表。
      </span>
      <ul className="tasks" data-testid="assigned-sites">
        {rows.map(a => (
          <li key={a.id}>
            <span className="mono">{a.siteCode}</span>
            <span className="grow">
              {a.hospital}
              <span className="muted"> · {a.studyCode} {a.studyShortName} · 自 {a.since}</span>
            </span>
            {canAssign && (
              <button className="btn link" data-testid={`unassign-${a.siteCode}`}
                onClick={() => { setTarget(a); setReason(""); setProblem(null); }}>
                撤下
              </button>
            )}
          </li>
        ))}
      </ul>

      {target && (
        <div className="stack" data-testid="unassign-form">
          {problem && (
            <div className="problem" data-testid="unassign-problem">
              <strong>{problem.title}</strong>
              {problem.detail && <div>{problem.detail}</div>}
            </div>
          )}
          <label className="field">
            <span>
              把 {who.displayName} 从 <b className="mono">{target.siteCode}</b>
              {" "}{target.hospital} 撤下 —— 为什么？
            </span>
            <input value={reason} data-testid="unassign-reason"
              placeholder="例：他调去 HJ-2025-003 了，这个中心交给唐延"
              onChange={e => setReason(e.target.value)} />
          </label>
          <div className="row">
            <button className="btn btn-p" data-testid="unassign-submit"
              disabled={reason.trim().length < 4 || busy}
              onClick={() => void drop()}>{busy ? "提交中…" : "撤下"}</button>
            <button className="btn link" data-testid="unassign-cancel"
              onClick={() => setTarget(null)}>取消</button>
            <span className="note">
              撤下那一刻他<b>看不见</b>这个中心的受试者与访视。
              要把在组受试者逐例交底的，走「交接」那条路 ——
              撤下是「不归他了」，交接是「归另一个人了」。
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

const gcpBad = (s: Staff) => s.active && s.gcpDaysLeft !== null && s.gcpDaysLeft < 0;

function gcpChip(s: Staff) {
  if (s.gcpDaysLeft === null) return <span className="muted">未登记</span>;
  const d = s.gcpDaysLeft;
  if (d < 0) return <span className="chip crit">已过期 {-d} 天</span>;
  if (d <= 60) return <span className="chip warn">{d} 天后到期</span>;
  return <span className="muted mono">{s.gcpExpiresOn}</span>;
}

function Stat({ label, v, note, bad }:
  { label: string; v: number; note: string; bad?: boolean }) {
  return (
    <div className="stat">
      <div className="stat-l">{label}</div>
      <div className="stat-v" style={bad ? { color: "var(--crit, #c0392b)" } : undefined}>{v}</div>
      <div className="stat-n">{note}</div>
    </div>
  );
}
