import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { call } from "../../api/client.js";
import { loadMe, type Me } from "../login/me.js";
import { listEnrollment, pct, type Funnel } from "../enrollment/api.js";

/* ════════════════════════════════════════════════════════════════════
   团队工作台（PM）。

   ── 和经营驾驶舱的分工 ────────────────────────────────────────────
   驾驶舱是**经营层**的：钱、达成率、公司整体。
   这一页是**项目总监**的：他手上这几个中心，今天卡在哪。

   两者都不画表 —— 各自底下已经有专门的页了。区别在于：
   驾驶舱按"要动手的几件事"排，这一页按**中心**排，
   因为 PM 的工作单位是中心，而不是问题类型。
   他要的是"SS-07 怎么样了"，不是"全部超窗的访视"。

   ── 行范围就是这一页的全部内容 ────────────────────────────────────
   PM 的 row_rule 是 `team`：本组承接项目下的全部中心。
   所以这一页不需要"选择项目"——它看到什么，就是他的全部工作面。
   ════════════════════════════════════════════════════════════════════ */

interface Site {
  id: string; code: string; hospital: string; state: string;
  contracted: number; startupInvalidated?: boolean;
}
interface Quality {
  id: string; code: string; siteCode: string; kind: string;
  severity: string; state: string; title: string; ageDays: number;
}
interface Visit {
  id: string; siteCode: string; visitLabel: string;
  windowTo: string; outOfWindow: boolean; status: string;
}
interface Startup {
  studySiteId: string; siteCode: string; total: number; done: number;
  blockingOpen: number; overdue: number; daysToSiv: number | null;
}

export function PmPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [funnels, setFunnels] = useState<Funnel[]>([]);
  const [quality, setQuality] = useState<Quality[]>([]);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [startup, setStartup] = useState<Startup[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void (async () => {
      /* 五个并发。串起来的话这一页的等待时间是五个接口之和 ——
         而它是 PM 登录后的第一落点。 */
      const [m, s, f, q, v, st] = await Promise.all([
        loadMe(),
        call<{ items: Site[] }>("listStudySites", { query: { limit: 200 } }),
        listEnrollment(),
        call<{ items: Quality[] }>("listQualityEvents", { query: { limit: 200 } }),
        call<{ items: Visit[] }>("listSubjectVisits",
          { query: { limit: 200, status: "planned", outOfWindow: true } }),
        call<{ items: Startup[] }>("listStartupChecklists", { query: { limit: 200 } })
      ]);
      setMe(m); setSites(s.items); setFunnels(f.items);
      setQuality(q.items); setVisits(v.items); setStartup(st.items);
      setReady(true);
    })();
  }, []);

  if (!ready || !me) return <p className="muted">加载中…</p>;

  const byCode = <T extends { siteCode: string }>(xs: T[]) => {
    const m = new Map<string, T[]>();
    for (const x of xs) m.set(x.siteCode, [...(m.get(x.siteCode) ?? []), x]);
    return m;
  };
  const funnelBy = new Map(funnels.map(f => [f.siteCode, f]));
  const startupBy = new Map(startup.map(s => [s.siteCode, s]));
  const qaBy = byCode(quality.filter(q => q.state !== "closed"));
  const lateBy = byCode(visits.filter(v => v.outOfWindow));

  /** 一个中心身上现在成立的问题。**每一条都指得出去哪一页处理**。 */
  const troubles = (code: string) => {
    const out: { text: string; to: string; grave?: boolean }[] = [];
    const st = startupBy.get(code);
    if (st && st.blockingOpen > 0)
      out.push({ text: `启动清单还有 ${st.blockingOpen} 项阻塞项`, to: "/startup", grave: true });
    const late = lateBy.get(code) ?? [];
    if (late.length)
      out.push({ text: `${late.length} 次访视已超窗`, to: "/today", grave: true });
    const qa = (qaBy.get(code) ?? []).filter(q => q.severity !== "minor");
    if (qa.length)
      out.push({ text: `${qa.length} 件严重及以上的质量事件未关闭`, to: "/quality" });
    const f = funnelBy.get(code);
    if (f && f.prescreened === 0)
      out.push({ text: "一例预筛都没有 —— 不是入组慢，是还没真正启动", to: "/enr", grave: true });
    else if (f && (f.screenFailRate ?? 0) > 0.6)
      out.push({ text: `筛败率 ${pct(f.screenFailRate)} —— 该谈方案修订了`, to: "/screen" });
    return out;
  };

  const rows = sites.map(s => ({ s, t: troubles(s.code), f: funnelBy.get(s.code) }))
    /* 有问题的排前面；同样有问题时，问题多的在前。
       **不按中心代号排** —— 那样 PM 每天要自己从十几行里找出哪几行不对劲。 */
    .sort((a, b) =>
      b.t.filter(x => x.grave).length - a.t.filter(x => x.grave).length
      || b.t.length - a.t.length
      || a.s.code.localeCompare(b.s.code));

  const trouble = rows.filter(r => r.t.length > 0);
  const enrolled = funnels.reduce((n, f) => n + f.enrolled, 0);
  const contracted = funnels.reduce((n, f) => n + f.contracted, 0);
  const oldestQa = quality.filter(q => q.state !== "closed")
    .sort((a, b) => b.ageDays - a.ageDays)[0];

  return (
    <>
      <div className="page-head">
        <h2>团队工作台</h2>
        <p data-testid="pm-summary">
          {me.account.team ? <>{me.account.team.name} · </> : null}
          {sites.length} 个中心在你的范围里
          {trouble.length > 0
            ? <>，<b>{trouble.length} 个现在有事</b>。</>
            : "，都没有需要现在处理的。"}
        </p>
      </div>

      <div className="stats" style={{ marginBottom: 16 }}>
        <Stat label="中心" v={String(sites.length)}
          note={`${sites.filter(s => s.state === "enrolling").length} 个在入组`} />
        <Stat label="入组" v={`${enrolled}/${contracted}`}
          note={contracted ? `达成 ${pct(enrolled / contracted)}` : "还没有合同例数"} />
        <Stat label="未关闭质量事件" v={String(quality.filter(q => q.state !== "closed").length)}
          note={oldestQa ? `最久的 ${oldestQa.ageDays} 天` : "无"}
          bad={quality.some(q => q.state !== "closed" && q.severity === "critical")} />
        <Stat label="超窗访视" v={String(visits.filter(v => v.outOfWindow).length)}
          note="每多一天都在往方案偏离上走"
          bad={visits.some(v => v.outOfWindow)} />
      </div>

      <div className="stack">
        {rows.map(({ s, t, f }) => (
          <div className="card stack" key={s.id} data-testid="pm-site"
            style={t.some(x => x.grave) ? { borderColor: "var(--crit, #c0392b)" } : undefined}>
            <div className="spread">
              <h3>
                <Link to={`/sites/${s.id}`} style={{ textDecoration: "none" }}>
                  <span className="mono">{s.code}</span>
                </Link>
                <span className="muted" style={{ fontSize: 13, marginLeft: 8 }}>{s.hospital}</span>
              </h3>
              <span className="muted">
                {f ? <>入组 {f.enrolled}/{f.contracted}
                  {f.attainment !== null && ` · ${pct(f.attainment)}`}</> : "—"}
              </span>
            </div>

            {t.length === 0
              ? <p className="muted" style={{ margin: 0 }} data-testid="pm-ok">
                  没有需要现在处理的。
                </p>
              : <ul className="unmet" style={{ margin: 0 }}>
                  {t.map((x, i) => (
                    <li key={i} data-testid="pm-trouble">
                      {x.grave ? <b>{x.text}</b> : x.text}
                      <Link to={x.to} className="btn" style={{
                        textDecoration: "none", display: "inline-block", marginLeft: 8
                      }}>去处理</Link>
                    </li>
                  ))}
                </ul>}
          </div>
        ))}
      </div>

      <div className="derive" style={{ marginTop: 14 }}>
        这一页按<b>中心</b>排，不按问题类型 —— PM 的工作单位是中心：
        他要的是「SS-07 怎么样了」，不是「全部超窗的访视」。
        （按问题类型排的那一版是经营驾驶舱，那是经营层的看法。）
        <br />
        有事的排前面，"有事"里再按严重程度。<b>不按中心代号排</b> ——
        那样每天都要自己从十几行里找出哪几行不对劲。
        <br />
        你看到哪些中心，由<b>行范围</b>决定（<span className="mono">{me.permissions.rowRule}</span>）——
        所以这一页没有"选择项目"：看到什么，就是你的全部工作面。
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
