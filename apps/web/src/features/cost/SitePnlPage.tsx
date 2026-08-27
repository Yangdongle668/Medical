import { useEffect, useState } from "react";
import { PnlTrend } from "./PnlTrend.js";
import { useParams, Link } from "react-router-dom";
import { call } from "../../api/client.js";
import { SITE_STATE_LABEL } from "../site/states.js";
import { yuan, pct, days } from "./money.js";

/* ════════════════════════════════════════════════════════════════════
   单中心损益。

   收入按 **I8'** 四项算出：

       收入 = 启动费 + 入组×单价 − Σ(1 − 已完成/应完成)×单价 + 筛败×单价×筛败费率

   界面把四项**逐条摊开**，而不是给一个总数。理由不是好看：

   > 两处修正方向相反 —— 漏算筛败费会砍掉本来赚钱的高筛败中心；
   > 漏算脱落扣减会保住实际在亏钱的高脱落中心。
   > **只做一个比两个都不做更危险，因为它看起来是对的。**

   一个总数看不出少了哪一项。四行摆在一起，少一行是看得见的。

   三层列权限在这一页同时生效，而且**由数据决定**，不由角色判断：
   · 一线（CRC/CRA）：看得到中心与例数，`revenue`/`cost`/毛利整块消失
   · PM：cost + price + margin 都有
   · 经营层：同上
   缺席的字段不渲染成"0"或"—"，整块不出现 —— 把"没权限"显示成 0，
   等于给了一个错的数字，比什么都不显示糟得多。
   ════════════════════════════════════════════════════════════════════ */

interface Revenue {
  startupCents?: number; enrollmentCents?: number;
  dropoutDeductionCents?: number; screenFailFeeCents?: number;
  revenueCents?: number;
}
interface Cost {
  directCostCents?: number; billableCostCents?: number;
  nonBillableCostCents?: number; overheadCents?: number;
  totalCostCents?: number; unapprovedCostCents?: number; personDays?: number;
  nonBillableShare?: number; costPerEnrolledCents?: number;
}
interface Pnl {
  studySiteId: string; siteCode: string; hospital: string; state: string;
  enrolled: number; screenFailed: number; withdrawn: number; contracted: number;
  revenue: Revenue; cost: Cost;
  grossProfitCents?: number; grossMargin?: number;
  calcVersion: string;
}

export function SitePnlPage() {
  const { id = "" } = useParams();
  const [p, setPnl] = useState<Pnl | null>(null);

  useEffect(() => {
    void call<Pnl>("getSitePnl", { params: { id } }).then(setPnl);
  }, [id]);

  if (!p) return <p className="muted">加载中…</p>;

  const hasRevenue = p.revenue.revenueCents !== undefined;
  const hasCost = p.cost.totalCostCents !== undefined;
  const hasMargin = p.grossProfitCents !== undefined;

  return (
    <>
      <div className="page-head">
        <Link to={`/sites/${id}`} className="muted">← {p.siteCode} 中心详情</Link>
        <h2 style={{ marginTop: 6 }}>损益</h2>
        <p>
          {p.hospital} · {SITE_STATE_LABEL[p.state] ?? p.state} ·
          口径版本 <span className="mono" data-testid="calc-version">{p.calcVersion}</span>
        </p>
      </div>

      <div className="stack" style={{ maxWidth: 780 }}>
        {/* 例数：不受列权限管辖，所有人都看得到 */}
        <section className="card" data-testid="counts">
          <h3 style={{ marginBottom: 10 }}>例数</h3>
          <dl className="kv">
            <dt>已入组</dt><dd className="num">{p.enrolled} / {p.contracted}</dd>
            <dt>筛败</dt><dd className="num">{p.screenFailed}</dd>
            <dt>脱落</dt><dd className="num">{p.withdrawn}</dd>
          </dl>
        </section>

        {!hasRevenue && !hasCost && (
          <p className="muted" data-testid="no-money">
            钱这一侧不在你的可见范围里 —— 你看得到这个中心和它的例数，看不到它的价钱与成本。
          </p>
        )}

        {/* ── 收入：I8' 四项 ────────────────────────────────────── */}
        {hasRevenue && (
          <section className="card" data-testid="revenue">
            <h3 style={{ marginBottom: 4 }}>收入</h3>
            <p className="muted" style={{ margin: "0 0 10px" }}>
              四项缺一不可 —— 中间两项方向相反，少做一项比两项都不做更危险，
              因为它看起来是对的。
            </p>
            <table className="terms">
              <tbody>
                <tr>
                  <td>启动费</td>
                  <td className="num">{yuan(p.revenue.startupCents ?? 0)}</td>
                </tr>
                <tr>
                  <td>入组 × 单价<span className="muted"> · {p.enrolled} 例</span></td>
                  <td className="num">{yuan(p.revenue.enrollmentCents ?? 0)}</td>
                </tr>
                <tr className="minus" data-testid="dropout-term">
                  <td>
                    脱落扣减
                    <span className="muted"> · 按已完成访视比例扣回 · {p.withdrawn} 例</span>
                  </td>
                  <td className="num">{yuan(p.revenue.dropoutDeductionCents ?? 0)}</td>
                </tr>
                <tr className="plus" data-testid="screenfail-term">
                  <td>
                    筛败费
                    <span className="muted"> · 筛败也是收入 · {p.screenFailed} 例</span>
                  </td>
                  <td className="num">
                    {yuan(p.revenue.screenFailFeeCents ?? 0, { sign: true })}
                  </td>
                </tr>
                <tr className="sum">
                  <td>合计</td>
                  <td className="num" data-testid="revenue-total">
                    {yuan(p.revenue.revenueCents ?? 0)}
                  </td>
                </tr>
              </tbody>
            </table>
          </section>
        )}

        {/* ── 成本 ─────────────────────────────────────────────── */}
        {hasCost && (
          <section className="card" data-testid="cost">
            <h3 style={{ marginBottom: 10 }}>成本</h3>
            <table className="terms">
              <tbody>
                <tr>
                  <td>可计费人力</td>
                  <td className="num">{yuan(p.cost.billableCostCents ?? 0)}</td>
                </tr>
                <tr>
                  <td>不可计费人力<span className="muted"> · 培训 / 返工 / 商务</span></td>
                  <td className="num">{yuan(p.cost.nonBillableCostCents ?? 0)}</td>
                </tr>
                <tr>
                  <td>管理分摊</td>
                  <td className="num">{yuan(p.cost.overheadCents ?? 0)}</td>
                </tr>
                <tr className="sum">
                  <td>合计</td>
                  <td className="num" data-testid="cost-total">
                    {yuan(p.cost.totalCostCents ?? 0)}
                  </td>
                </tr>
              </tbody>
            </table>
            {!!p.cost.unapprovedCostCents && (
              /* 待审的那一部分**已经在合计里了**。这一行只说"其中有多少
                 还没被第二个人看过" —— 把它从合计里剔掉才是错的：
                 毛利会比实际好看，等审批补上又突然掉一截，
                 而那时没人说得清是经营变差了还是审批积压了。 */
              <p className="muted" style={{ margin: "10px 0 0", fontSize: 12 }}
                data-testid="unapproved-cost">
                其中 <b className="num">{yuan(p.cost.unapprovedCostCents)}</b> 还没审
                —— 已经计入上面的合计，这一行只说它还没被第二个人看过。
              </p>
            )}
            <dl className="kv" style={{ marginTop: 12 }}>
              {p.cost.personDays !== undefined && <>
                <dt>投入人天</dt><dd className="num">{days(p.cost.personDays)}</dd></>}
              {/* 缺席 = 没有分母（直接成本为 0）。不显示成 0% —— 那是另一回事 */}
              {p.cost.nonBillableShare !== undefined && <>
                <dt>不可计费占比</dt>
                <dd className="num" data-testid="nonbillable-share">
                  {pct(p.cost.nonBillableShare)}
                  <span className="muted"> · 它高，说明人力花在了卖不出去的事情上</span>
                </dd></>}
              {p.cost.costPerEnrolledCents !== undefined && <>
                <dt>每例入组成本</dt>
                <dd className="num">{yuan(p.cost.costPerEnrolledCents)}</dd></>}
            </dl>
          </section>
        )}

        {/* ── 毛利 ─────────────────────────────────────────────── */}
        {hasMargin && (
          <section className={`card gatebar ${(p.grossProfitCents ?? 0) >= 0 ? "clear" : "blocked"}`}
            data-testid="margin">
            <strong className="num">{yuan(p.grossProfitCents ?? 0)}</strong>
            <span>
              毛利
              {p.grossMargin !== undefined
                ? <> · 毛利率 <b className="num" data-testid="gross-margin">
                    {pct(p.grossMargin)}</b></>
                : /* 收入为 0 时后端不下发 grossMargin。
                     显示成 0% 会把「还没有收入」说成「一分钱不赚」——
                     那是两件事，而后者会让人去砍一个还没开始的中心。 */
                  <span className="muted" data-testid="no-margin-rate">
                    {" "}· 还没有收入，毛利率无从谈起（不是 0%）
                  </span>}
            </span>
          </section>
        )}

        {/* 分月：累计回答不了「这个月比上个月差在哪」 */}
        <PnlTrend studySiteId={id} />
      </div>
    </>
  );
}
