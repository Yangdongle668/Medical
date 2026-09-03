import { useEffect, useState } from "react";
import { call } from "../../api/client.js";
import { loadMe, type Me } from "../login/me.js";

/* ════════════════════════════════════════════════════════════════════
   人员备案与准入。

   ── 它问的问题和「人才梯队」不是一个 ──────────────────────────────
   人才梯队问：这个人几级、谁带的、他走了谁接、断档风险在哪。
   那是**我方的人事账**，`/v1/staff` 那条端点对外部方一行也不给。

   这一页问：**我这几个中心上出现的人是谁、他的 GCP 证书还有效吗。**
   证书过期的人不得开展工作 —— 这不是我方的内部管理，
   是机构履行监管职责的一部分。在此之前它靠邮件和微信问，
   问到的答案没有出处。

   ── 于是新开了一条端点，而不是给旧端点放宽策略 ────────────────────
   `/v1/site-staff` 只给备案要用的那几列（姓名、工种、证书、在哪几个中心），
   职级、城市、带教、继任、登录名一个都不给。
   收敛照旧走行范围 —— 机构办只看本院，PI 只看自己的中心。

   最容易漏的一条在**计数**上：人才梯队里的"带几个中心"数的是全部派工，
   机构办拿到它就知道了这个 CRC 在别家医院还带着几个。
   所以这一页的中心列表与计数都只在本范围内算。

   ── 排序按"要动手的先来" ──────────────────────────────────────────
   已过期 → 60 天内到期 → 其余。备案表按姓名排等于每次都要自己扫一遍。
   ════════════════════════════════════════════════════════════════════ */

interface SiteStaff {
  accountId: string; displayName: string; roleKind: string;
  gcpExpiresOn: string | null; gcpDaysLeft: number | null;
  active: boolean;
  sites: { id: string; code: string; hospital: string;
           studyShortName: string; since: string }[];
}

const KIND: Record<string, string> = {
  CRA: "监查员 CRA", CRC: "协调员 CRC", PM: "项目总监", QA: "质量保证", DM: "数据管理"
};

/** 备案窗口。不是"快到期了"的美学阈值 ——
 *  换证要走机构培训与考试，排期通常一个月起，60 天是**来得及办**的下限。 */
const WINDOW = 60;

export function InstRegistryPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [rows, setRows] = useState<SiteStaff[] | null>(null);
  const [kind, setKind] = useState("");
  const [problemOnly, setProblemOnly] = useState(false);

  useEffect(() => {
    void loadMe().then(setMe);
    call<{ items: SiteStaff[] }>("listSiteStaff", { query: { limit: 200 } })
      .then(r => setRows(r.items)).catch(() => setRows([]));
  }, []);

  if (!me || !rows) return <p className="muted">加载中…</p>;

  const expired = rows.filter(p => p.gcpDaysLeft !== null && p.gcpDaysLeft < 0);
  const soon = rows.filter(p =>
    p.gcpDaysLeft !== null && p.gcpDaysLeft >= 0 && p.gcpDaysLeft <= WINDOW);
  const missing = rows.filter(p => p.gcpExpiresOn === null);
  const inactive = rows.filter(p => !p.active);

  /* 筛选在**前端**做：这一页的数据量是"我院这几个中心上的人"，
     十几到几十条，服务端来回一趟比本地过一遍慢得多。
     （gcpProblem 与 roleKind 两个查询参数在端点上是有的 ——
     留给数据量真的上来的那天，以及给别的调用方用。） */
  const shown = rows
    .filter(p => !kind || p.roleKind === kind)
    .filter(p => !problemOnly
      || p.gcpExpiresOn === null || (p.gcpDaysLeft ?? 0) <= WINDOW)
    .slice().sort((a, b) => rank(a) - rank(b)
      || (a.gcpDaysLeft ?? 0) - (b.gcpDaysLeft ?? 0)
      || a.displayName.localeCompare(b.displayName));

  const kinds = [...new Set(rows.map(p => p.roleKind))].sort();

  return (
    <>
      <div className="page-head">
        <h2>人员备案与准入</h2>
        <p data-testid="reg-summary">
          你的中心上有 {rows.length} 名在岗人员。
          {expired.length > 0
            ? <> <b>{expired.length} 人的 GCP 证书已过期</b>
                {soon.length > 0 && <>，另有 {soon.length} 人将在 {WINDOW} 天内到期</>}。</>
            : soon.length > 0
              ? <> {soon.length} 人的证书将在 {WINDOW} 天内到期。</>
              : " 证书都在有效期内。"}
        </p>
      </div>

      {expired.length > 0 && (
        <div className="problem" data-testid="reg-expired" style={{ marginBottom: 14 }}>
          <b>证书过期的人不得开展工作。</b>
          {expired.map(p => `${p.displayName}（${p.sites.map(s => s.code).join("、")}）`).join("；")}
          —— 过期日之后这些中心上发生的访视，核查时会被逐一问到签署人资质。
        </div>
      )}

      <div className="stats" style={{ marginBottom: 16 }}>
        <Stat label="在岗人员" v={String(rows.length)}
          note={`${new Set(rows.flatMap(p => p.sites.map(s => s.code))).size} 个中心`} />
        <Stat label="证书已过期" v={String(expired.length)}
          note={expired.length ? "不得开展工作" : "无"} bad={expired.length > 0} />
        <Stat label={`${WINDOW} 天内到期`} v={String(soon.length)}
          note={soon.length ? "换证排期通常一个月起" : "无"} bad={soon.length > 0} />
        <Stat label="无证书记录" v={String(missing.length)}
          note={missing.length ? "和过期在核查时是同一件事" : "无"}
          bad={missing.length > 0} />
      </div>

      <div className="row" style={{ marginBottom: 12, gap: 12, alignItems: "end" }}>
        <label className="field" style={{ maxWidth: 220 }}>
          <span>工种</span>
          <select value={kind} data-testid="reg-kind" onChange={e => setKind(e.target.value)}>
            <option value="">全部</option>
            {kinds.map(k => <option key={k} value={k}>{KIND[k] ?? k}</option>)}
          </select>
        </label>
        <label className="field" style={{ maxWidth: 260 }}>
          <span>
            <input type="checkbox" checked={problemOnly} data-testid="reg-problem-only"
              onChange={e => setProblemOnly(e.target.checked)} />
            {" "}只看要动手的
          </span>
        </label>
      </div>

      {shown.length === 0 ? (
        <p className="muted" data-testid="reg-empty">
          {rows.length === 0
            ? <>你的中心上还没有登记在岗的监查员或协调员。
                <b>这不是"查不到"</b> —— 范围之外的中心对你不存在。</>
            : "按这个条件没有人。"}
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>姓名</th><th>工种</th><th>GCP 证书</th><th className="num">剩余</th>
                <th>在岗中心</th><th>状态</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(p => (
                <tr key={p.accountId} data-testid="reg-row">
                  <td>{p.displayName}</td>
                  <td>{KIND[p.roleKind] ?? p.roleKind}</td>
                  <td className="mono muted">
                    {p.gcpExpiresOn ?? <span className="chip crit">无记录</span>}
                  </td>
                  <td className="num">
                    {p.gcpDaysLeft === null ? "—"
                      : p.gcpDaysLeft < 0
                        ? <span className="chip crit" data-testid="reg-expired-chip">
                            已过期 {-p.gcpDaysLeft} 天
                          </span>
                        : p.gcpDaysLeft <= WINDOW
                          ? <span className="chip warn" data-testid="reg-soon-chip">
                              {p.gcpDaysLeft} 天
                            </span>
                          : <span className="muted">{p.gcpDaysLeft} 天</span>}
                  </td>
                  <td>
                    {p.sites.map(s => (
                      <div key={s.id} style={{ fontSize: 13 }}>
                        <span className="mono">{s.code}</span>
                        <span className="muted"> {s.studyShortName} · 自 {s.since}</span>
                      </div>
                    ))}
                  </td>
                  <td>
                    {p.active
                      ? <span className="muted">在职</span>
                      : <span className="chip flat" data-testid="reg-inactive">已停用</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {inactive.length > 0 && (
        <p className="muted" style={{ marginTop: 10 }}>
          停用的人<b>留在备案表上</b>：他上周还在中心里出现过。
          从表上抹掉，那几次访视在核查时就成了无人签字的记录。
        </p>
      )}

      <div className="derive" style={{ marginTop: 14 }}>
        这张表<b>不是人事名册的一个筛子</b>，是另一条端点：
        只给备案要用的那几列 —— 职级、城市、带教人、继任者、登录名一个都没有。
        <br />
        「在岗中心」<b>只列你范围内的</b>（<span className="mono">{me.permissions.rowRule}</span>）。
        同一个协调员在别家医院还带着几个中心，与本院无关，
        所以这一列的条数不是他的全部派工数。
        <br />
        研究者不在这张表上：他是医院自己的人，证书归医院管，
        我方手里那份不会更新 —— 摆一列永远为空的证书日期，比不摆更糟。
      </div>
    </>
  );
}

/** 排序档位：已过期 0、将到期 1、无记录 2、其余 3。
 *  无记录排在"将到期"之后而不是最前 —— 它多半是**还没登记**，
 *  而不是这个人真的没有证书；把它顶在最上面会淹掉真正到期的那几个。 */
function rank(p: SiteStaff) {
  if (p.gcpDaysLeft !== null && p.gcpDaysLeft < 0) return 0;
  if (p.gcpDaysLeft !== null && p.gcpDaysLeft <= WINDOW) return 1;
  if (p.gcpExpiresOn === null) return 2;
  return 3;
}

function Stat({ label, v, note, bad }:
  { label: string; v: string; note: string; bad?: boolean }) {
  return (
    <div className="stat">
      <div className="stat-l">{label}</div>
      <div className="stat-v" style={{ fontSize: 19, ...(bad ? { color: "var(--crit, #c0392b)" } : {}) }}>{v}</div>
      <div className="stat-n">{note}</div>
    </div>
  );
}
