import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { call } from "../../api/client.js";
import { loadMe, type Me } from "../login/me.js";
import { listEnrollment, pct, type Funnel } from "../enrollment/api.js";

/* ════════════════════════════════════════════════════════════════════
   机构工作台（机构办公室）。

   ── 机构办不是"权限小一号的经营层" ────────────────────────────────
   容易把这一页做成经营驾驶舱的删减版：少几个数、去掉钱。那是错的。
   经营层问的是「公司这个月挣不挣钱」；
   机构办问的是「**我院这几个项目合规不合规、进度对不对得起当初的承诺**」。

   于是这一页按 **项目 × 中心** 排，每一行答三件事：
   现在到哪一步了、入组够不够、有没有没了结的事。
   没有一栏是钱 —— 单价与启动费受列权限管辖（price），
   机构办本来就拿不到，而**画一列横杠比不画更糟**：
   那会让人以为这里将来会有数。

   ── 一条硬边界：机构办没有 subjRead ────────────────────────────────
   角色只有 `closeQA` 一个动作。所以这一页**一个受试者接口都不能碰** ——
   listSubjects / listSubjectVisits 都会 403。
   入组数从 `listEnrollment` 来：那条端点只返回**计数**，
   不返回明细，因此不需要 subject.read（I10）。
   「这个中心有 12 例在组」机构办看得到，「是哪 12 例」看不到。
   ════════════════════════════════════════════════════════════════════ */

interface Site {
  id: string; code: string; hospital: string; dept: string; state: string;
  contracted: number; piName: string;
  study: { id: string; code: string; shortName: string };
  irbApprovedOn: string | null; sivOn: string | null;
  startupInvalidated?: boolean;
}
interface Startup {
  studySiteId: string; siteCode: string; total: number; done: number;
  blockingOpen: number; overdue: number; daysToSiv: number | null;
}
interface Quality {
  id: string; code: string; siteCode: string; kind: string;
  severity: string; state: string; title: string; ageDays: number;
}

const STATE: Record<string, string> = {
  intake: "立项", irb_submit: "伦理递交", irb_approve: "伦理批件",
  contract: "合同签署", siv: "SIV 启动", enrolling: "入组中",
  enrolled: "入组完成", followup: "随访中", closed: "中心关闭"
};

export function InstPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [funnels, setFunnels] = useState<Funnel[]>([]);
  const [startup, setStartup] = useState<Startup[]>([]);
  const [quality, setQuality] = useState<Quality[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void (async () => {
      const [m, s, f, st, q] = await Promise.all([
        loadMe(),
        call<{ items: Site[] }>("listStudySites", { query: { limit: 200 } }),
        listEnrollment(),
        call<{ items: Startup[] }>("listStartupChecklists", { query: { limit: 200 } }),
        call<{ items: Quality[] }>("listQualityEvents", { query: { limit: 200 } })
      ]);
      setMe(m); setSites(s.items); setFunnels(f.items);
      setStartup(st.items); setQuality(q.items);
      setReady(true);
    })();
  }, []);

  if (!ready || !me) return <p className="muted">加载中…</p>;

  const funnelBy = new Map(funnels.map(f => [f.studySiteId, f]));
  const startupBy = new Map(startup.map(s => [s.studySiteId, s]));
  const openQa = quality.filter(q => q.state !== "closed");
  const qaBy = (code: string) => openQa.filter(q => q.siteCode === code);

  /* 按项目分组 —— 机构办的台账是按项目立的（一个项目一个批件、一份合同），
     不是按中心。同一个项目在本院可能有两个科室各带一个中心。 */
  const studies = [...new Map(sites.map(s => [s.study.id, s.study])).values()]
    .sort((a, b) => a.code.localeCompare(b.code));

  const hospitals = [...new Set(sites.map(s => s.hospital))];
  const blocked = sites.filter(s => (startupBy.get(s.id)?.blockingOpen ?? 0) > 0);
  const invalidated = sites.filter(s => s.startupInvalidated);
  const enrolled = funnels.reduce((n, f) => n + f.enrolled, 0);
  const contracted = funnels.reduce((n, f) => n + f.contracted, 0);

  return (
    <>
      <div className="page-head">
        <h2>机构工作台</h2>
        <p data-testid="inst-summary">
          {hospitals.join(" / ") || "本院"} · 承接 {studies.length} 个项目、
          {sites.length} 个中心。
          {blocked.length > 0
            ? <> <b>{blocked.length} 个中心的启动清单还有阻塞项</b>。</>
            : " 没有卡在启动上的中心。"}
        </p>
      </div>

      <div className="stats" style={{ marginBottom: 16 }}>
        <Stat label="在研项目" v={String(studies.length)}
          note={`${sites.filter(s => s.state === "enrolling").length} 个中心在入组`} />
        <Stat label="入组" v={`${enrolled}/${contracted}`}
          note={contracted ? `达成 ${pct(enrolled / contracted)}` : "还没有合同例数"} />
        <Stat label="启动阻塞" v={String(blocked.length)}
          note={blocked.length ? "未清零不得开展受试者工作" : "都清零了"}
          bad={blocked.length > 0} />
        <Stat label="未关闭事件" v={String(openQa.length)}
          note={openQa.length
            ? `最久的 ${Math.max(...openQa.map(q => q.ageDays))} 天` : "无"}
          bad={openQa.some(q => q.severity === "critical")} />
      </div>

      {invalidated.length > 0 && (
        <div className="problem" data-testid="inst-invalidated" style={{ marginBottom: 14 }}>
          <b>{invalidated.length} 个中心已经过了 SIV，启动清单里却重新挂着未完成的阻塞项</b>
          （{invalidated.map(s => s.code).join("、")}）。
          出现这种情况只有一条路径：有人把一个已完成的阻塞项撤销了。
          系统<b>刻意不自动把中心退回启动前</b> —— 已经入组的受试者会挂在
          一个不存在的状态上，比不退回危险得多。所以它以这条提示的形式留在台账上。
        </div>
      )}

      {studies.map(st => {
        const rows = sites.filter(s => s.study.id === st.id)
          .sort((a, b) => a.code.localeCompare(b.code));
        return (
          <div key={st.id} style={{ marginBottom: 20 }} data-testid="inst-study">
            <h3>
              {st.shortName}
              <span className="mono muted" style={{ fontSize: 13, marginLeft: 8 }}>{st.code}</span>
            </h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>中心</th><th>科室</th><th>研究者</th><th>阶段</th>
                    <th>伦理批件</th><th>启动日</th>
                    <th className="num">入组 / 合同</th>
                    <th>启动清单</th><th>未了结</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(s => {
                    const f = funnelBy.get(s.id);
                    const c = startupBy.get(s.id);
                    const qa = qaBy(s.code);
                    return (
                      <tr key={s.id} data-testid="inst-site">
                        <td className="mono">
                          <Link to={`/sites/${s.id}`}>{s.code}</Link>
                        </td>
                        <td>{s.dept}</td>
                        <td>{s.piName}</td>
                        <td>{STATE[s.state] ?? s.state}</td>
                        <td className="mono muted">{s.irbApprovedOn ?? "—"}</td>
                        <td className="mono muted">{s.sivOn ?? "—"}</td>
                        <td className="num">
                          {f ? <>{f.enrolled} / {f.contracted}
                            {f.attainment !== null &&
                              <span className="muted"> · {pct(f.attainment)}</span>}</> : "—"}
                        </td>
                        <td>
                          {!c || c.total === 0
                            ? <span className="muted">无清单</span>
                            : c.blockingOpen > 0
                              ? <span className="chip crit" data-testid="inst-blocked">
                                  {c.blockingOpen} 项阻塞
                                </span>
                              : <span className="muted">{c.done}/{c.total}
                                  {c.overdue > 0 && <span className="chip warn"
                                    style={{ marginLeft: 6 }}>{c.overdue} 项逾期</span>}
                                </span>}
                        </td>
                        <td>
                          {qa.length === 0
                            ? <span className="muted">无</span>
                            : <Link to="/inst/qc" className={
                                qa.some(q => q.severity === "critical")
                                  ? "chip crit" : "chip warn"
                              } style={{ textDecoration: "none" }}>{qa.length} 件</Link>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

      {sites.length === 0 && (
        <p className="muted" data-testid="inst-empty">
          本院目前没有在研中心。<b>这不是"查不到"</b> ——
          你的行范围是本院，范围之外的中心对你不存在。
        </p>
      )}

      <div className="derive" style={{ marginTop: 14 }}>
        这一页<b>一栏钱都没有</b>：单价与启动费受列权限管辖，你的角色拿不到它们。
        画一列横杠会让人以为将来会有数 —— 所以整列不画。
        <br />
        入组数来自只返回<b>计数</b>的那条端点，因此不需要「查看受试者明细」这个动作：
        「这个中心有多少例在组」你看得到，<b>「是哪几例」你看不到</b>。
        <br />
        你看到哪些中心由 <b>行范围</b> 决定
        （<span className="mono">{me.permissions.rowRule}</span>，按
        <span className="mono"> account.org_ref</span> 匹配医院名）。
      </div>
    </>
  );
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
