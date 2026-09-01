import { useEffect, useState } from "react";
import { call } from "../../api/client.js";

/* ════════════════════════════════════════════════════════════════════
   人才梯队。

   和「派工与产能」同一份名册，问的是**另一个时间尺度**的问题：
   那一页问"今天谁不能干活"，这一页问"半年后谁会走、走了断在哪"。

   ── 断档风险不是一个玄学分数 ──────────────────────────────────────
   原型里那个 `talentM(x).risk >= 60` 是个复合指标。这里不抄它，
   因为一个算出来的分数最后一定会被问"这 60 分是怎么来的" ——
   而回答不了这个问题的指标，人不会照着它做决定。

   改成**逐条列出成立的风险项**：每一条都说得出是什么、怎么解。
   三条以上标红，因为那时通常不是这个人的问题，是排班的问题。
   ════════════════════════════════════════════════════════════════════ */

interface Staff {
  accountId: string; login: string; displayName: string; roleKind: string;
  level: string; city: string;
  gcpExpiresOn: string | null; gcpDaysLeft: number | null;
  mentorName: string | null; successorName: string | null;
  siteCount: number; successionGap: boolean;
  active: boolean; disabledReason: string | null;
}

/** 一个人身上成立的风险项。**每一条都要有解法** ——
 *  说得出问题却说不出下一步的指标，是一种昂贵的装饰。 */
function risks(s: Staff): { what: string; fix: string }[] {
  const out: { what: string; fix: string }[] = [];
  if (s.successionGap)
    out.push({ what: `带 ${s.siteCount} 个中心且没有继任者`, fix: "指定继任者，或把中心分掉" });
  if (s.gcpDaysLeft !== null && s.gcpDaysLeft < 0)
    out.push({ what: "GCP 证书已过期", fix: "立刻停止现场工作并安排复训" });
  else if (s.gcpDaysLeft !== null && s.gcpDaysLeft <= 90)
    out.push({ what: `GCP 还有 ${s.gcpDaysLeft} 天到期`, fix: "排复训，别等到期那周" });
  if (s.gcpDaysLeft === null)
    out.push({ what: "没有登记 GCP 证书", fix: "补登记 —— 没登记不等于没有，但查起来一样" });
  if (!s.mentorName && s.level && /P[12]/.test(s.level))
    out.push({ what: "初级但没有带教", fix: "指一个带教 —— 这一级的人独立上现场容易出偏差" });
  return out;
}

export function PeoplePage() {
  const [staff, setStaff] = useState<Staff[] | null>(null);

  useEffect(() => {
    void call<{ items: Staff[] }>("listStaff", { query: { limit: 200, activeOnly: true } })
      .then(r => setStaff(r.items));
  }, []);

  if (!staff) return <p className="muted">加载中…</p>;

  const scored = staff
    .map(s => ({ s, r: risks(s) }))
    .sort((a, b) => b.r.length - a.r.length || b.s.siteCount - a.s.siteCount);
  const atRisk = scored.filter(x => x.r.length >= 3);
  const noSuccessor = staff.filter(s => s.successionGap);

  /* 「谁带谁」——从 mentorName 反推。名册上只有"我的带教是谁"，
     而排班要问的是"这个人带了几个"。 */
  const mentees = new Map<string, string[]>();
  for (const s of staff)
    if (s.mentorName) mentees.set(s.mentorName, [...(mentees.get(s.mentorName) ?? []), s.displayName]);

  return (
    <>
      <div className="page-head">
        <h2>人才梯队</h2>
        <p>
          和「派工与产能」同一份名册，问的是另一个时间尺度：
          那一页问<b>今天谁不能干活</b>，这一页问<b>半年后谁会走、走了断在哪</b>。
        </p>
      </div>

      <div className="stats" style={{ marginBottom: 14 }}>
        <Stat label="在职" v={staff.length} note="人" />
        <Stat label="三项以上风险" v={atRisk.length}
          note={atRisk.length ? "通常不是人的问题，是排班的问题" : "无"} bad={atRisk.length > 0} />
        <Stat label="无继任者" v={noSuccessor.length}
          note="一旦离职，名下中心当场断档" bad={noSuccessor.length > 0} />
        <Stat label="在带教" v={mentees.size} note={`带着 ${[...mentees.values()].flat().length} 个人`} />
      </div>

      <div className="stack">
        {scored.map(({ s, r }) => (
          <div className="card stack" key={s.accountId} data-testid="person-card">
            <div className="spread">
              <h3>
                {s.displayName}
                <span className="muted mono" style={{ fontSize: 12, marginLeft: 8 }}>
                  {s.roleKind} · {s.level} · {s.city}
                </span>
              </h3>
              <span className={`chip ${r.length >= 3 ? "crit" : r.length ? "warn" : "good"}`}
                data-testid="risk-chip">
                {r.length === 0 ? "无风险项" : `${r.length} 项风险`}
              </span>
            </div>

            <div className="muted">
              带 {s.siteCount} 个中心
              {s.successorName ? ` · 继任者 ${s.successorName}` : " · 没有继任者"}
              {s.mentorName && ` · 带教 ${s.mentorName}`}
              {mentees.get(s.displayName)?.length
                && ` · 在带 ${mentees.get(s.displayName)!.join("、")}`}
            </div>

            {r.length > 0 && (
              <ul className="unmet" style={{ margin: 0 }}>
                {r.map((x, i) => (
                  <li key={i}>
                    {x.what} —— <span className="muted">{x.fix}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>

      <div className="derive" style={{ marginTop: 14 }}>
        <b>这里没有风险分数。</b> 一个算出来的复合分最后一定会被问
        「这 60 分是怎么来的」—— 而回答不了这个问题的指标，
        人不会照着它做决定。
        <br />
        改成逐条列出成立的风险项，每一条都说得出<b>是什么</b>和<b>怎么解</b>。
        三条以上标红，因为那时通常不是这个人的问题，是排班的问题。
      </div>
    </>
  );
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
