import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Diverging, HBars, Legend, type BarRow } from "@sitedesk/ui/react";
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

   ── 这一页是设计语言迁移的样板 ────────────────────────────────────
   用的是原型的词汇：`grid g4` + `.kpi`（被竖发丝线分隔的一排数字，
   不是四张磁贴）、`.card-h`/`.card-b`（发丝线分区，不是边框盒子）、
   以及两张真图。**图只画有真数的那两张** —— 原型的驾驶舱上还有一条
   "计划 vs 实际累计"折线，但服务端目前没有按月的入组时间序列
   （listEnrollment 只给到当下的计数）。为了画那条线去前端编一份月度
   分布，等于在驾驶舱上放一个看起来最权威、实际上是假的东西。
   缺图比假图好，所以它不在这里 —— 等 `getSitePnlTrend` 那样的
   时间序列接口铺到入组上，再补。
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
  const enrolling = sites.filter(s => s.state === "enrolling").length;

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

  /* 达成率条：落后的排在最前 —— 与 listEnrollment 的排序口径一致。
     `attainment` 为 null 是"还没有合同例数"，不是 0%，所以排除掉：
     把"没有分母"画成一条空条，看起来和"一例都没入"一模一样。 */
  const attain: BarRow[] = funnels
    .filter(f => f.attainment !== null)
    .sort((a, b) => a.attainment! - b.attainment!)
    .slice(0, 8)
    .map(f => ({
      label: `${f.hospital || f.siteCode}`,
      v: Math.round(f.attainment! * 100),
      color: "var(--ink-2)",
      vColor: f.attainment! < 0.5 ? "var(--crit)"
        : f.attainment! < 0.9 ? "var(--warn)" : "var(--ink)",
      tip: <>
        <div className="tip-t">{f.hospital || f.siteCode}</div>
        <div className="tip-r"><span>已入组</span><b>{f.enrolled} / {f.contracted} 例</b></div>
        <div className="tip-r"><span>已预筛</span><b>{f.prescreened} 例</b></div>
        <div className="tip-r"><span>筛败率</span>
          <b>{f.screenFailRate === null ? "—" : pct(f.screenFailRate)}</b></div>
      </>
    }));

  /* 单中心毛利：正负极性，按毛利额排序。只在拿得到 margin 字段时画 ——
     字段权限没给的人看到的是"这张图不存在"，不是一排零。 */
  const gp: BarRow[] = showMoney
    ? pnl
      .filter(r => r.grossProfitCents !== undefined)
      .map(r => ({
        label: r.siteCode,
        v: (r.grossProfitCents ?? 0) / 100_00,
        tip: <>
          <div className="tip-t">{r.siteCode}</div>
          <div className="tip-r"><span>已确认收入</span><b>{yuan(r.revenue.revenueCents ?? 0)}</b></div>
          <div className="tip-r"><span>已发生成本</span><b>{yuan(r.cost.totalCostCents ?? 0)}</b></div>
          <div className="tip-r"><span>毛利</span>
            <b style={{ color: (r.grossProfitCents ?? 0) < 0 ? "var(--crit)" : undefined }}>
              {yuan(r.grossProfitCents ?? 0)}</b></div>
        </>
      }))
      .sort((a, b) => b.v - a.v)
    : [];

  return (
    <>
      <div className="page-head">
        <h2>经营驾驶舱</h2>
        <p>这一页只回答一句：<b>现在要动手的是哪几件。</b>数字是背景，待办是重点。</p>
      </div>

      {/* 四格还是两格，取决于**列权限**：看不到钱的人这一排只有两项，
          仍然用 g4 的话右半边会空着两格 —— 空格看起来像"数据没加载出来"。 */}
      <div className={showMoney ? "grid g4" : "grid g2"} style={{ marginBottom: 30 }}>
        <Kpi label="在手中心" v={String(sites.length)} to="/sites"
          delta={`${enrolling} 个在入组`}
          note={`启动中 ${Math.max(0, sites.length - enrolling)} 个`} />
        <Kpi label="入组" v={String(enrolled)} unit={` / ${contracted}`} to="/enr"
          delta={contracted ? `达成 ${pct(enrolled / contracted)}` : "还没有合同例数"}
          deltaColor={contracted && enrolled < contracted * 0.5 ? "var(--crit)" : undefined}
          note={`${notStarted.length} 个中心一例预筛都没有`} />
        {showMoney && <>
          <Kpi label="收入" v={yuan(revenue)} to="/pnl"
            delta="到今天为止的累计" note={`${pnl.length} 个中心已确认`} />
          <Kpi label="毛利" v={yuan(profit)} to="/pnl"
            delta={revenue > 0 ? pct(profit / revenue) : "还没有收入"}
            deltaColor={profit < 0 ? "var(--crit)" : "var(--good)"}
            note={losing.length ? `${losing.length} 个中心在亏钱` : "没有亏损的中心"} />
        </>}
      </div>

      <section className="card" data-testid="todos" style={{ marginBottom: 30 }}>
        <div className="card-h">
          <h3>要动手的</h3>
          <span className="sub">每一条都指得出去哪一页处理</span>
          <span className="sp" />
          <span className={`pill ${todos.some(t => t.grave) ? "p-crit" : todos.length ? "p-warn" : "p-neut"}`}>
            {todos.length} 项待处理
          </span>
        </div>
        <div className="card-b">
          {todos.length === 0
            ? <p className="muted" data-testid="todos-empty" style={{ margin: 0 }}>
                没有需要现在处理的。<b>这一页空着是好事</b> ——
                它只列不常态成立的事，一条永远在那儿的待办等于没有待办。
              </p>
            : <ul className="unmet" style={{ margin: 0 }}>
                {todos.map(t => (
                  <li key={t.key} data-testid="todo">
                    <span>{t.grave ? <b>{t.text}</b> : t.text}</span>
                    <Link to={t.to} className="btn go">{t.cta}</Link>
                  </li>
                ))}
              </ul>}
        </div>
      </section>

      <div className={showMoney ? "grid g2" : "grid"}>
        <section className="card">
          <div className="card-h">
            <h3>入组达成率</h3>
            <span className="sub">落后的排在最前，最多八个</span>
            <span className="sp" />
            <Link to="/enr" className="btn">看全部 →</Link>
          </div>
          <div className="card-b">
            {attain.length
              ? <>
                  <HBars rows={attain} max={100} unit="%" band={[100]}
                    fmt={v => String(Math.round(v))} />
                  <Legend items={[{ name: "已入组 / 合同例数", color: "var(--ink-2)" }]}
                    hint="竖线是合同例数刻度；悬停看明细" />
                </>
              : <div className="empty">还没有中心定下合同例数</div>}
          </div>
        </section>

        {showMoney && (
          <section className="card">
            <div className="card-h">
              <h3>单中心毛利</h3>
              <span className="sub">零轴居中，按毛利额排序</span>
              <span className="sp" />
              <Link to="/pnl" className="btn">看明细 →</Link>
            </div>
            <div className="card-b">
              {gp.length
                ? <Diverging rows={gp} unit=" 万" />
                : <div className="empty">还没有中心产生收入</div>}
            </div>
          </section>
        )}
      </div>

      <div className="derive" style={{ marginTop: 30 }}>
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

/** 仪表盘刻度。**是按钮，不是磁贴** —— 每个数字都指得出它是从哪一页来的，
 *  点过去就是那一页。数字不能只是被展示，它得能被追下去。 */
function Kpi({ label, v, unit, delta, deltaColor, note, to }: {
  label: string; v: string; unit?: string; delta: ReactNode;
  deltaColor?: string | undefined; note: string; to: string;
}) {
  const nav = useNavigate();
  return (
    <button className="kpi" onClick={() => nav(to)} data-testid="kpi">
      <div className="kpi-l">{label}</div>
      <div className="kpi-v">{v}{unit && <small>{unit}</small>}</div>
      <div className="kpi-f">
        <div>
          <div className="kpi-d" style={deltaColor ? { color: deltaColor } : undefined}>{delta}</div>
          <div className="kpi-note">{note}</div>
        </div>
      </div>
    </button>
  );
}
