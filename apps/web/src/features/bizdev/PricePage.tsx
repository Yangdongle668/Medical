import { useEffect, useMemo, useState } from "react";
import { quote, type QuoteParams, type QuoteRates, CALC_VERSION } from "@sitedesk/calc";
import { call } from "../../api/client.js";
import { loadMe, type Me } from "../login/me.js";
import { yuan, pct, days } from "../cost/money.js";

/* ════════════════════════════════════════════════════════════════════
   报价模型。

   ── 这一页没有自己的端点，这是**故意的** ──────────────────────────
   算式是纯函数（`@sitedesk/calc` 的 `quote()`），输入是滑块上的参数，
   而两样真实数据都已经有端点了：
     · 费率 → `listRateCards`（现行那一张）
     · 历史基线 → `listPnl`（真实发生过的人天与每例成本）

   再开一条 `POST /v1/quote` 只会让同一套口径有两个入口，
   而计算引擎独立成一层的理由正是"前后端共用同一份实现"。
   真要落库的是**报出去的价**（投标那一页），不是每一次拖动滑块。

   ── 护城河在右边那张表，不在左边的滑块 ────────────────────────────
   对手报价靠经验，这边靠**自己的成本数据库**：同一条算式代进历史项目的
   参数，应该算得出历史的实际成本。算不出，说明报价用的是一套账、
   结算用的是另一套 —— 那才是真正该慌的事。

   所以历史基线只取**入组完成度 ≥ 80% 的中心**：启动成本已经充分摊薄，
   人天/例与每例成本才具备可比性。没摊薄的中心列出来但不进均值。

   ── 筛败率是这套算式里最容易漏、代价最大的一项 ────────────────────
   漏掉它**同时低估成本和收入**。所以它在滑块里，
   而且旁边写着经验区间 —— 历史上那次失标（差 19%）的复盘结论
   是同一件事的另一面：参数错了，不是算式错了。
   ════════════════════════════════════════════════════════════════════ */

interface RateCard {
  id: string; roleKind: string; level: string | null;
  dayCostCents: number; validFrom: string; validTo: string | null;
}
interface Pnl {
  studySiteId: string; siteCode: string; hospital: string;
  enrolled: number; contracted: number;
  cost?: { personDays?: number; costPerEnrolledCents?: number };
  grossMargin?: number;
}

const DEFAULTS: QuoteParams = {
  sites: 12, subjectsPerSite: 20, months: 20, visits: 11,
  complexity: 1.2, imvIntervalMonths: 1.5, crcFte: 0.55,
  screenFailRate: 0.35, targetMargin: 0.30
};

/** 差旅与管理分摊没有费率卡 —— 它们不是人天。
 *  写在这里而不是藏进 calc：**这两个数是可以谈的**，
 *  而滑块上没有它们，所以至少要让人在代码之外看得见来源。 */
const TRAVEL_PER_TRIP_CENTS = 285_000;
const OVERHEAD_RATIO = 0.12;

interface Field {
  k: keyof QuoteParams; t: string;
  min: number; max: number; step: number;
  fmt: (v: number) => string;
  note?: string;
}
const FIELDS: Field[] = [
  { k: "sites", t: "参研中心数", min: 2, max: 40, step: 1, fmt: v => `${v} 个` },
  { k: "subjectsPerSite", t: "每中心入组例数", min: 5, max: 60, step: 1, fmt: v => `${v} 例` },
  { k: "months", t: "入组期", min: 6, max: 36, step: 1, fmt: v => `${v} 个月` },
  { k: "visits", t: "每例访视次数", min: 3, max: 20, step: 1, fmt: v => `${v} 次` },
  { k: "complexity", t: "方案复杂度系数", min: 0.8, max: 2, step: 0.05,
    fmt: v => `${v.toFixed(2)}×`, note: "肿瘤 / 罕见病 1.3–1.8；慢病 1.0" },
  { k: "imvIntervalMonths", t: "监查间隔", min: 0.5, max: 4, step: 0.5,
    fmt: v => `${v} 个月/次` },
  { k: "crcFte", t: "CRC 驻场 FTE", min: 0.1, max: 1, step: 0.05, fmt: v => pct(v),
    note: "最敏感的一项。历史上那次失标：我们按 0.8 报，对手按 0.5" },
  { k: "screenFailRate", t: "预期筛败率", min: 0, max: 0.7, step: 0.01, fmt: v => pct(v),
    note: "肿瘤 II/III 期 45%–60%；慢病 20%–35%。漏掉它会同时低估成本和收入" },
  { k: "targetMargin", t: "目标毛利率", min: 0.1, max: 0.5, step: 0.01, fmt: v => pct(v) }
];

/** 今天现行的那一张卡。**不是最新的那一张** ——
 *  一张 2027 年才生效的费率卡不该被今天的报价用上。 */
function currentRate(cards: RateCard[], kind: string): number | null {
  const today = new Date().toISOString().slice(0, 10);
  const hit = cards.filter(c =>
    c.roleKind === kind && c.level === null
    && c.validFrom <= today && (c.validTo === null || c.validTo >= today));
  return hit[0]?.dayCostCents ?? null;
}

export function PricePage() {
  const [me, setMe] = useState<Me | null>(null);
  const [cards, setCards] = useState<RateCard[] | null>(null);
  const [pnl, setPnl] = useState<Pnl[]>([]);
  const [p, setP] = useState<QuoteParams>(DEFAULTS);

  useEffect(() => {
    void loadMe().then(setMe);
    void call<{ items: RateCard[] }>("listRateCards", { query: { limit: 100 } })
      .then(r => setCards(r.items)).catch(() => setCards([]));
    /* 基线取不到不该让整页打不开 —— 没有历史数据的租户是正常状态。 */
    void call<{ items: Pnl[] }>("listPnl", { query: { limit: 200 } })
      .then(r => setPnl(r.items)).catch(() => setPnl([]));
  }, []);

  const crc = cards ? currentRate(cards, "CRC") : null;
  const cra = cards ? currentRate(cards, "CRA") : null;

  const rates: QuoteRates | null = useMemo(() =>
    crc !== null && cra !== null
      ? { crcDayCents: crc, craDayCents: cra,
          travelPerTripCents: TRAVEL_PER_TRIP_CENTS, overheadRatio: OVERHEAD_RATIO }
      : null, [crc, cra]);

  const r = useMemo(() => rates ? quote(p, rates) : null, [p, rates]);

  /* 历史基线。**只取入组完成度 ≥ 80% 的中心** —— 启动成本已充分摊薄。
     未摊薄的列出来但不进均值：它们的每例成本天然偏高，
     混进均值会让报价系统性偏高，而那正是丢标的来源。 */
  const hist = pnl
    .filter(x => x.cost?.personDays !== undefined && x.enrolled > 0)
    .map(x => ({
      ...x,
      progress: x.contracted > 0 ? x.enrolled / x.contracted : 0,
      daysPerSubject: x.cost!.personDays! / x.enrolled,
      cpe: x.cost!.costPerEnrolledCents ?? 0
    }));
  const base = hist.filter(x => x.progress >= 0.8);
  const baseline = base.length ? {
    n: base.length,
    daysPerSubject: base.reduce((n, x) => n + x.daysPerSubject, 0) / base.length,
    cpe: Math.round(base.reduce((n, x) => n + x.cpe, 0) / base.length)
  } : null;

  if (!me || !cards) return <p className="muted">加载中…</p>;

  if (!rates) return (
    <>
      <div className="page-head"><h2>报价模型</h2></div>
      <p className="problem" data-testid="price-no-rate">
        {/* 两种"算不出来"，界面上必须分得开：
            没权限看费率，和费率卡里确实没有今天现行的那一张。
            前者去找管理员，后者去开一张卡 —— 说成同一句话，
            人会往错的方向找一整天。
            判据是 `cost` 列权限（dayCostCents 受它管辖），不是 `price` ——
            后者管的是中心单价，两者不是一回事。 */}
        {me.permissions.fields.includes("cost")
          ? <>费率卡里没有<b>今天现行</b>的 CRC 或 CRA 通用费率 ——
              报价算不出来。去「工时与差旅 → 费率卡」开一张。
              <b>不拿一张已收口的卡凑数</b>：用过期费率报出去的价，
              签下来就是直接的毛利缺口。</>
          : <>你的角色看不到人天成本（<span className="mono">cost</span> 列权限），
              而报价的每一个数都是从它推出来的 —— 这一页对你是空的。</>}
      </p>
    </>
  );

  const set = (k: keyof QuoteParams, v: number) => setP(x => ({ ...x, [k]: v }));

  return (
    <>
      <div className="page-head">
        <h2>报价模型</h2>
        <p data-testid="price-summary">
          用<b>历史真实人天</b>反推报价。对手报价靠经验，你靠自己的成本数据库 ——
          这是抄不走的护城河。
        </p>
      </div>

      <div className="stats" style={{ marginBottom: 16 }}>
        <Stat label="建议报价总额" v={yuan(r!.quoteCents)}
          note={`目标毛利率 ${pct(p.targetMargin)}`} hi />
        <Stat label="单例报价" v={yuan(r!.unitPriceCents)}
          note={`按 ${r!.billableUnits.toFixed(1)} 个计价单位摊`} />
        <Stat label="预估总成本" v={yuan(r!.totalCostCents)}
          note={`${r!.enrolled} 例入组 · 筛 ${r!.screened} 例`} />
        <Stat label="人天 / 例" v={days(r!.daysPerSubject)}
          note={baseline
            ? `历史基线 ${days(baseline.daysPerSubject)}（${baseline.n} 个中心）`
            : "还没有可比的历史中心"} />
      </div>

      {/* `grid g12` = 左窄右宽（1 : 1.9）。原来这里是一个不存在的
          `.grid-2` 类加一整行内联样式 —— 类名没人定义，实际生效的是内联那份。 */}
      <div className="grid g12" style={{ alignItems: "start" }}>
        <div className="card stack">
          <div className="spread">
            <h3>项目参数</h3>
            <button className="btn" data-testid="price-reset"
              onClick={() => setP(DEFAULTS)}>重置</button>
          </div>
          {FIELDS.map(f => (
            <label className="field" key={f.k}>
              <span className="spread">
                <span>{f.t}</span>
                <b data-testid={`price-v-${f.k}`}>{f.fmt(p[f.k])}</b>
              </span>
              <input type="range" data-testid={`price-f-${f.k}`}
                min={f.min} max={f.max} step={f.step} value={p[f.k]}
                onChange={e => set(f.k, Number(e.target.value))} />
              {f.note && <div className="muted" style={{ fontSize: 12 }}>{f.note}</div>}
            </label>
          ))}
        </div>

        <div className="stack">
          <div className="card stack">
            <div className="spread">
              <h3>成本构成推演</h3>
              <span className="muted" style={{ fontSize: 12 }}>改左边任一参数即时重算</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>项</th><th className="num">人天</th><th className="num">金额</th>
                    <th className="num">占成本</th></tr>
                </thead>
                <tbody>
                  <tr data-testid="price-line">
                    <td>CRC 人力</td>
                    <td className="num">{days(r!.crcDays)}</td>
                    <td className="num">{yuan(r!.crcCostCents)}</td>
                    <td className="num muted">{pct(r!.crcCostCents / r!.totalCostCents)}</td>
                  </tr>
                  <tr data-testid="price-line">
                    <td>CRA 人力</td>
                    <td className="num">{days(r!.craDays)}</td>
                    <td className="num">{yuan(r!.craCostCents)}</td>
                    <td className="num muted">{pct(r!.craCostCents / r!.totalCostCents)}</td>
                  </tr>
                  <tr data-testid="price-line">
                    <td>差旅（{r!.trips} 次现场）</td>
                    <td className="num muted">—</td>
                    <td className="num">{yuan(r!.travelCostCents)}</td>
                    <td className="num muted">{pct(r!.travelCostCents / r!.totalCostCents)}</td>
                  </tr>
                  <tr data-testid="price-line">
                    <td>管理分摊<span className="muted"> · 按直接人力 {pct(OVERHEAD_RATIO)}</span></td>
                    <td className="num muted">—</td>
                    <td className="num">{yuan(r!.overheadCents)}</td>
                    <td className="num muted">{pct(r!.overheadCents / r!.totalCostCents)}</td>
                  </tr>
                  <tr>
                    <td><b>合计</b></td>
                    <td className="num"><b>{days(r!.crcDays + r!.craDays)}</b></td>
                    <td className="num"><b>{yuan(r!.totalCostCents)}</b></td>
                    <td className="num muted">100%</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="row" style={{ gap: 24, flexWrap: "wrap" }}>
              <div>
                <div className="section-t">CRC 人天分解</div>
                <ul className="unmet" style={{ margin: 0 }}>
                  <li>启动与关闭 {days(r!.crcBreakdown.setup)}（每中心 12 天）</li>
                  <li>驻场基线 {days(r!.crcBreakdown.onsite)}</li>
                  <li>入组受试者访视陪同 {days(r!.crcBreakdown.visits)}</li>
                  <li data-testid="price-sf-days">
                    <b>筛败受试者 {days(r!.crcBreakdown.screenFail)}</b>
                    <span className="muted">（{r!.screenFailed} 例 × 1.6 天 × 复杂度）</span>
                  </li>
                </ul>
              </div>
              <div>
                <div className="section-t">CRA 人天分解</div>
                <ul className="unmet" style={{ margin: 0 }}>
                  <li>SIV {days(r!.craBreakdown.siv)}</li>
                  <li>现场监查 {days(r!.craBreakdown.imv)}（{r!.imvCount} 轮）</li>
                  <li>关中心 {days(r!.craBreakdown.closeout)}</li>
                  <li>远程跟进与报告 {days(r!.craBreakdown.reporting)}</li>
                </ul>
              </div>
            </div>
          </div>

          <div className="derive" data-testid="price-sf-note">
            <b>筛败率是这套算式里最容易漏、代价最大的一项。</b>
            漏掉它会<b>同时</b>低估成本和收入：
            筛败的每一例都要做知情、入排核对、筛选期检查陪同（CRC 的活一点没少），
            而这一例没入组。
            <br />
            当前参数下：筛 {r!.screened} 例入 {r!.enrolled} 例，
            筛败 <b>{r!.screenFailed}</b> 例 ——
            吃掉 <b>{days(r!.crcBreakdown.screenFail)}</b> 个 CRC 人天，
            按筛败费带回 <b>{yuan(r!.screenFailRevenueCents)}</b>。
            单价的分母因此是 {r!.billableUnits.toFixed(1)} 而不是 {r!.enrolled} ——
            <b>按入组例数摊会把单价报高，进而丢标</b>。
          </div>

          <div className="card stack">
            <h3>历史基线 · 护城河在这里</h3>
            {hist.length === 0 ? (
              <p className="muted" data-testid="price-no-hist">
                还没有可比的历史中心。<b>这一页现在只是一套算式</b> ——
                它要到有过几个跑完的中心之后才开始值钱。
              </p>
            ) : (
              <>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr><th>中心</th><th className="num">完成度</th>
                        <th className="num">人天/例</th><th className="num">每例成本</th>
                        <th>进不进均值</th></tr>
                    </thead>
                    <tbody>
                      {hist.sort((a, b) => b.progress - a.progress).map(x => (
                        <tr key={x.studySiteId} data-testid="price-hist">
                          <td className="mono">{x.siteCode}
                            <span className="muted" style={{ marginLeft: 6 }}>{x.hospital}</span>
                          </td>
                          <td className="num">{pct(x.progress)}</td>
                          <td className="num">{days(x.daysPerSubject)}</td>
                          <td className="num">{yuan(x.cpe)}</td>
                          <td>
                            {x.progress >= 0.8
                              ? <span className="chip flat">计入</span>
                              : <span className="muted">未摊薄，仅参考</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="muted" style={{ margin: 0 }}>
                  基线<b>只取入组完成度 ≥ 80% 的中心</b>：启动成本已经充分摊薄，
                  人天/例与每例成本才具备可比性。
                  没摊薄的中心每例成本天然偏高，混进均值会让报价<b>系统性偏高</b>，
                  而那正是丢标的来源。
                </p>
                {baseline && (
                  <div className="row" style={{ gap: 24, flexWrap: "wrap" }}>
                    <span data-testid="price-baseline">
                      基线人天/例 <b>{days(baseline.daysPerSubject)}</b>
                      <span className="muted">（{baseline.n} 个中心）</span>
                    </span>
                    <span>基线每例成本 <b>{yuan(baseline.cpe)}</b></span>
                    <span>
                      本次测算 <b>{days(r!.daysPerSubject)}</b> 人天/例
                      {r!.daysPerSubject > baseline.daysPerSubject * 1.2 && (
                        <span className="chip warn" style={{ marginLeft: 6 }}
                          data-testid="price-above-baseline">
                          比历史高 {pct(r!.daysPerSubject / baseline.daysPerSubject - 1)}
                        </span>
                      )}
                    </span>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      <div className="derive" style={{ marginTop: 14 }}>
        费率来自<b>今天现行</b>的那张费率卡（CRC {yuan(rates.crcDayCents)}/人天、
        CRA {yuan(rates.craDayCents)}/人天），不是写死的常量 ——
        调价是两步（旧卡收口 + 新卡生效），拿一张已收口的卡报出去的价，
        签下来就是直接的毛利缺口。
        <br />
        <b>这一页没有自己的接口。</b> 算式是纯函数，费率与历史基线各有现成端点 ——
        再开一条只会让同一套口径有两个入口。真要落库的是<b>报出去的价</b>，
        那在「投标与报价闭环」。
        <span className="muted mono" style={{ marginLeft: 8, fontSize: 12 }}>
          口径 {CALC_VERSION}
        </span>
      </div>
    </>
  );
}

function Stat({ label, v, note, hi }:
  { label: string; v: string; note: string; hi?: boolean }) {
  return (
    <div className="stat">
      <div className="stat-l">{label}</div>
      <div className="stat-v" style={{ fontSize: hi ? 22 : 19,
        ...(hi ? { color: "var(--accent, #2d6cdf)" } : {}) }}>{v}</div>
      <div className="stat-n">{note}</div>
    </div>
  );
}
