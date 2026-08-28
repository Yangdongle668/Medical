import { useEffect, useState } from "react";
import { call } from "../../api/client.js";

/* ════════════════════════════════════════════════════════════════════
   派工与产能。

   这一页盯两件会出事的事，而它们都不是"谁比较忙"：

   ① **GCP 证书过期。** 过期即不得开展工作 —— 不是提醒，是资质失效。
      一个证书上周过期的 CRA 还在中心干活，那是稽查发现项。
   ② **无继任者且带多个中心。** 这个人一旦离职，那几个中心当场断档。
      交接页解决的是"已经要走了"，这一页要在那之前就看得见。

   带几个中心是背景信息，不是结论：带 5 个小中心可能比带 2 个
   大中心轻松。所以数量只排序，不上色。
   ════════════════════════════════════════════════════════════════════ */

interface Staff {
  accountId: string; login: string; displayName: string; roleKind: string;
  level: string; city: string;
  gcpExpiresOn: string | null; gcpDaysLeft: number | null;
  mentorName: string | null; successorName: string | null;
  siteCount: number; successionGap: boolean;
  active: boolean; disabledReason: string | null;
}

/* 契约里 ROLE_KINDS 就是大写的这五个（packages/contracts/src/site/staffing.ts）。
   这里不做映射，只兜底：将来加了一种工种而这里没跟上，
   页面上会看到那个原始值，而不是一片空白。 */
const roleKind = (k: string) => k;

export function StaffPage() {
  const [staff, setStaff] = useState<Staff[] | null>(null);
  const [activeOnly, setActiveOnly] = useState(true);

  useEffect(() => {
    void call<{ items: Staff[] }>("listStaff",
      { query: { limit: 200, ...(activeOnly ? { activeOnly: true } : {}) } })
      .then(r => setStaff(r.items));
  }, [activeOnly]);

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
              .map(s => (
                <tr key={s.accountId} data-testid="staff-row"
                  style={s.active ? undefined : { opacity: .55 }}>
                  <td>
                    {s.displayName}
                    <div className="muted mono" style={{ fontSize: 11 }}>{s.login}</div>
                  </td>
                  <td>{roleKind(s.roleKind)}</td>
                  <td className="muted">{s.level}</td>
                  <td className="muted">{s.city}</td>
                  <td className="num">{s.siteCount}</td>
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
                </tr>
              ))}
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
