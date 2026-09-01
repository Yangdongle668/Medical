import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { call } from "../../api/client.js";
import { yuan, pct } from "../cost/money.js";
import { listEnrollment, type Funnel } from "../enrollment/api.js";

/* ════════════════════════════════════════════════════════════════════
   经营驾驶舱。

   ── 它不是又一张表 ────────────────────────────────────────────────
   底下那几页（入组进度、成本与毛利、质量台账）已经把各自的表画全了。
   再画一遍等于让人读四遍同样的数。

   这一页只回答一句：**现在要动手的是哪几件。**
   所以主体是一份「待办」，每一条都指得出去哪一页处理；
   上面那排数字是背景，不是重点。

   ── 一条待办要成立，得同时满足两件事 ──────────────────────────────
   ① 它有明确的下一步（点过去能做点什么）；
   ② 它**不常态成立**。一条永远在那儿的待办等于没有待办 ——
      看两周之后人就不看了，然后真正要紧的那一条也一起被略过。

   所以这里没有「有 15 个中心」这种条目，也没有「本月入组 12 例」。
   ════════════════════════════════════════════════════════════════════ */

interface PnlRow {
  studySiteId: string; siteCode: string;
  revenue: { revenueCents?: number };
  cost: { totalCostCents?: number; unapprovedCostCents?: number };
  grossProfitCents?: number;
}
interface Site { id: string; code: string; state: string; startupInvalidated?: boolean }
interface Quality {
  id: string; code: string; siteCode: string; kind: string;
  severity: string; state: string; title: string; ageDays: number;
}

interface Todo {
  key: string; text: string; n: number; to: string; cta: string; grave?: boolean;
}

export function DashPage() {
  const [funnels, setFunnels] = useState<Funnel[] | null>(null);
  const [pnl, setPnl] = useState<PnlRow[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [quality, setQuality] = useState<Quality[]>([]);

  useEffect(() => {
    void (async () => {
      /* 四个并发，不是四个串行。串起来的话这一页的等待时间是
         四个接口之和 —— 而它是登录后第一眼看到的那一页。 */
      const [f, p, s, q] = await Promise.all([
        listEnrollment(),
        call<{ items: PnlRow[] }>("listPnl", { query: { limit: 200 } }),
        call<{ items: Site[] }>("listStudySites", { query: { limit: 200 } }),
        call<{ items: Quality[] }>("listQualityEvents", { query: { limit: 200 } })
      ]);
      setFunnels(f.items); setPnl(p.items); setSites(s.items); setQuality(q.items);
    })();
  }, []);

  if (!funnels) return <p className="muted">加载中…</p>;

  const showMoney = pnl.some(r => r.grossProfitCents !== undefined);
  const revenue = pnl.reduce((n, r) => n + (r.revenue.revenueCents ?? 0), 0);
  const profit = pnl.reduce((n, r) => n + (r.grossProfitCents ?? 0), 0);
  const unapproved = pnl.reduce((n, r) => n + (r.cost.unapprovedCostCents ?? 0), 0);

  const contracted = funnels.reduce((n, r) => n + r.contracted, 0);
  const enrolled = funnels.reduce((n, r) => n + r.enrolled, 0);

  const notStarted = funnels.filter(r => r.prescreened === 0);
  const behind = funnels.filter(r => r.enrolled < r.contracted * 0.5 && r.prescreened > 0);
  const highFail = funnels.filter(r => (r.screenFailRate ?? 0) > 0.6);
  const losing = pnl.filter(r => (r.grossProfitCents ?? 0) < 0);
  const invalidated = sites.filter(s => s.startupInvalidated);
  const openSevere = quality.filter(q => q.state !== "closed" && q.severity !== "minor");

  const todos: Todo[] = [
    { key: "notStarted", n: notStarted.length, to: "/enr", cta: "看入组进度",
      text: `${notStarted.length} 个中心一例预筛都没有 —— 那不是入组慢，是还没真正启动`,
      grave: true },
    { key: "invalidated", n: invalidated.length, to: "/sites", cta: "看中心台账",
      text: `${invalidated.length} 个中心已过 SIV，但启动清单还挂着未完成的阻塞项`,
      grave: true },
    { key: "severe", n: openSevere.length, to: "/quality", cta: "看质量台账",
      text: `${openSevere.length} 件严重及以上的质量事件还没关闭` },
    { key: "losing", n: showMoney ? losing.length : 0, to: "/pnl", cta: "看成本与毛利",
      text: `${losing.length} 个中心在亏钱` },
    { key: "highFail", n: highFail.length, to: "/screen", cta: "看筛选漏斗",
      text: `${highFail.length} 个中心筛败率超过 60% —— 该谈方案修订了` },
    { key: "behind", n: behind.length, to: "/enr", cta: "看入组进度",
      text: `${behind.length} 个中心入组不足合同例数的一半` },
    { key: "unapproved", n: showMoney && unapproved > 0 ? 1 : 0, to: "/timesheets", cta: "去审批",
      text: `有 ${yuan(unapproved)} 的工时还没被第二个人看过` }
  ].filter(t => t.n > 0);

  return (
    <>
      <div className="page-head">
        <h2>经营驾驶舱</h2>
        <p>这一页只回答一句：<b>现在要动手的是哪几件。</b>数字是背景，待办是重点。</p>
      </div>

      <div className="stats" style={{ marginBottom: 16 }}>
        <Stat label="在手中心" v={String(sites.length)}
          note={`${sites.filter(s => s.state === "enrolling").length} 个在入组`} />
        <Stat label="入组" v={`${enrolled}/${contracted}`}
          note={contracted ? `达成 ${pct(enrolled / contracted)}` : "还没有合同例数"} />
        {showMoney && <>
          <Stat label="收入" v={yuan(revenue)} note="到今天为止的累计" />
          <Stat label="毛利" v={yuan(profit)}
            note={revenue > 0 ? pct(profit / revenue) : "还没有收入"} bad={profit < 0} />
        </>}
      </div>

      <section className="card stack" data-testid="todos">
        <div className="spread">
          <h3>要动手的</h3>
          <span className="muted">每一条都指得出去哪一页处理</span>
        </div>
        {todos.length === 0
          ? <p className="muted" data-testid="todos-empty">
              没有需要现在处理的。<b>这一页空着是好事</b> ——
              它只列不常态成立的事，一条永远在那儿的待办等于没有待办。
            </p>
          : <ul className="unmet" style={{ margin: 0 }}>
              {todos.map(t => (
                <li key={t.key} data-testid="todo">
                  {t.grave ? <b>{t.text}</b> : t.text}
                  <Link to={t.to} className="btn" style={{
                    textDecoration: "none", display: "inline-block", marginLeft: 8
                  }}>{t.cta}</Link>
                </li>
              ))}
            </ul>}
      </section>

      <div className="derive" style={{ marginTop: 14 }}>
        底下那几页已经把各自的表画全了，这里不再画第四遍 ——
        再画一遍等于让人读四遍同样的数。
        <br />
        一条待办要出现在这里，得同时满足两件事：<b>有明确的下一步</b>，
        而且<b>不常态成立</b>。所以这里没有「有 15 个中心」这种条目 ——
        一条永远在那儿的待办，看两周之后人就不看了，
        然后真正要紧的那一条也跟着被略过。
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
