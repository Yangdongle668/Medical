import { useEffect, useState } from "react";
import { call } from "../../api/client.js";
import { loadMe, type Me } from "../login/me.js";
import { yuan } from "../cost/money.js";

/* ════════════════════════════════════════════════════════════════════
   现金流预测。

   ── 系统此前只有后视镜 ────────────────────────────────────────────
   收入按已入组的例数确认，成本按已填的工时 —— 两者都只回答
   「已经发生了什么」。

   而现金是另一回事：**人力成本每月刚性支出，回款是里程碑制 + 账期。**
   一个毛利率 30% 的项目，完全可能在第四个月付不出工资 ——
   而这件事，靠损益表看不出来。

   这一页只回答一个问题：**缺口出现在哪个月。**
   那个月份就是"要提前多久去谈"的答案。

   ── 三样东西必须分开，混起来这套数就开始骗人 ──────────────────────
   ① 已开票未回款 —— 按到期日落月，最确定的一部分；
   ② 预计将达成 —— 按入组速度推，最不确定的一部分；
   ③ **已达成但没进开票队列** —— 它**不是**未来收入。
      钱本来就该收到了，只是没人去开票。把它算成现金，
      会在最不该乐观的那个月凭空多出一笔。

   所以 ③ 单独摆在最上面，一分钱都不进下面的曲线。

   ── 压力情景不是悲观 ──────────────────────────────────────────────
   逾期的再拖 3 个月：**它之所以逾期，恰恰是因为对方还没打算付。**
   预计达成的延后 1 个月：入组从来只会比计划慢。
   两条都不是"往坏了想"，是把已经知道的事算进去。
   ════════════════════════════════════════════════════════════════════ */

interface Item { label: string; inflowCents?: number; kind: string }
interface Month {
  month: string;
  inCents?: number; outCents?: number; netCents?: number; cumCents?: number;
  items: Item[];
}
interface Forecast {
  months: Month[];
  burnCents?: number; headcount: number;
  troughCents?: number; troughMonth: string | null;
  stress: { months: Month[]; troughCents?: number; troughMonth: string | null };
  recordGapCents?: number; recordGapCount: number;
  calcVersion: string;
}

const KIND: Record<string, { text: string; chip: string }> = {
  invoiced: { text: "已开票", chip: "flat" },
  overdue: { text: "已逾期", chip: "crit" },
  pending: { text: "待开票", chip: "warn" },
  forecast: { text: "预计达成", chip: "flat" }
};

export function CashPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [f, setF] = useState<Forecast | null>(null);
  const [months, setMonths] = useState(6);
  const [stress, setStress] = useState(false);
  const [openMonth, setOpenMonth] = useState<string | null>(null);

  useEffect(() => { void loadMe().then(setMe); }, []);
  useEffect(() => {
    setF(null);
    void call<Forecast>("getCashForecast", { query: { months } }).then(setF);
  }, [months]);

  if (!me || !f) return <p className="muted">加载中…</p>;

  const seesMoney = f.burnCents !== undefined;
  if (!seesMoney) return (
    <>
      <div className="page-head"><h2>现金流预测</h2></div>
      <p className="problem" data-testid="cash-no-money">
        你的角色看不到金额（<span className="mono">price</span> 列权限），
        而这一页每一个数都是钱 —— <b>它对你是空的</b>，
        不是画一屏零。
      </p>
    </>
  );

  const view = stress ? f.stress : f;
  const rows = view.months;
  /* 最低点是负数才叫缺口。为正说明这几个月现金是够的 —— 那句话要说出来，
     否则一个正的最低点会被当成"没算出来"。 */
  const gap = (view.troughCents ?? 0) < 0;
  /* 画柱子用的标尺：取累计的绝对值最大者。 */
  const scale = Math.max(1, ...rows.map(m => Math.abs(m.cumCents ?? 0)));

  return (
    <>
      <div className="page-head">
        <h2>现金流预测</h2>
        <p data-testid="cash-summary">
          未来 {months} 个月：每月刚性支出 <b>{yuan(f.burnCents!)}</b>
          （{f.headcount} 名在职）。
          {gap
            ? <> 累计最低点 <b>{yuan(view.troughCents!)}</b>，
                出现在 <b>{view.troughMonth}</b>。</>
            : " 这几个月现金是够的。"}
        </p>
      </div>

      <div className="derive" style={{ marginBottom: 14 }}>
        <b>系统此前只有后视镜。</b> 收入按已入组的例数确认、成本按已填的工时 ——
        两者都只回答「已经发生了什么」。
        <br />
        而现金是另一回事：人力成本每月刚性支出，回款是里程碑制 + 账期。
        <b>一个毛利率 30% 的项目，完全可能在第四个月付不出工资。</b>
        这一页只回答一件事：<b>缺口出现在哪个月</b> ——
        那个月份就是「要提前多久去谈」的答案。
      </div>

      {f.recordGapCount > 0 && (
        <div className="problem" data-testid="cash-gap" style={{ marginBottom: 14 }}>
          <b>{f.recordGapCount} 笔里程碑其实已经达成，但没进开票队列</b>
          （约 {yuan(f.recordGapCents!)}）。
          <br />
          <b>它一分钱都没算进下面的曲线</b> —— 因为它不是未来收入：
          钱本来就该收到了，只是没人去开票。
          把它算成现金，会在最不该乐观的那个月凭空多出一笔。
          去「里程碑 · 结算」把票开了，这笔钱就变成真的应收。
        </div>
      )}

      <div className="row" style={{ gap: 16, marginBottom: 14, flexWrap: "wrap" }}>
        <label className="field" style={{ maxWidth: 180 }}>
          <span>预测跨度</span>
          <select value={months} data-testid="cash-months"
            onChange={e => setMonths(Number(e.target.value))}>
            <option value={3}>3 个月</option>
            <option value={6}>6 个月</option>
            <option value={12}>12 个月</option>
          </select>
        </label>
        <label className="field" style={{ maxWidth: 260 }}>
          <span>
            <input type="checkbox" checked={stress} data-testid="cash-stress"
              onChange={e => setStress(e.target.checked)} />
            {" "}压力情景
          </span>
        </label>
      </div>

      <div className={stress ? "problem" : "derive"} style={{ marginBottom: 14 }}
        data-testid="cash-stress-note">
        {stress
          ? <><b>压力情景不是悲观。</b> 逾期的再拖 3 个月 ——
              它之所以逾期，恰恰是因为对方还没打算付；
              预计达成的延后 1 个月 —— 入组从来只会比计划慢。
              <b>两条都是把已经知道的事算进去。</b>
              这一版的最低点是 <b>{yuan(f.stress.troughCents ?? 0)}</b>
              （{f.stress.troughMonth}）。</>
          : <>下面是<b>基准</b>情景。勾上「压力情景」看逾期再拖三个月会掉到哪里 ——
              基准最低点 {yuan(f.troughCents ?? 0)}，
              压力下 <b>{yuan(f.stress.troughCents ?? 0)}</b>。</>}
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>月份</th><th className="num">预计进账</th><th className="num">刚性支出</th>
              <th className="num">净额</th><th className="num">累计</th>
              <th>累计走势</th><th />
            </tr>
          </thead>
          <tbody>
            {rows.map(m => {
              const cum = m.cumCents ?? 0;
              const w = Math.round(Math.abs(cum) / scale * 100);
              const worst = m.month === view.troughMonth;
              return (
                <tr key={m.month} data-testid="cash-row"
                  style={worst && gap ? { background: "rgba(192,57,43,.06)" } : undefined}>
                  <td className="mono">
                    {m.month}
                    {worst && gap && (
                      <span className="chip crit" style={{ marginLeft: 6 }}
                        data-testid="cash-trough">最低点</span>
                    )}
                  </td>
                  <td className="num">{yuan(m.inCents ?? 0)}</td>
                  <td className="num muted">−{yuan(m.outCents ?? 0)}</td>
                  <td className="num" style={(m.netCents ?? 0) < 0
                    ? { color: "var(--crit, #c0392b)" } : undefined}>
                    {yuan(m.netCents ?? 0)}
                  </td>
                  <td className="num" style={cum < 0
                    ? { color: "var(--crit, #c0392b)", fontWeight: 600 } : undefined}>
                    {yuan(cum)}
                  </td>
                  <td>
                    {/* 一条最朴素的柱子。**负数往左长** ——
                        用颜色区分正负而不用方向的话，
                        "从正转负"那一格看起来只是换了个色。 */}
                    <div style={{ display: "flex", alignItems: "center", height: 14 }}>
                      <div style={{ width: "50%", display: "flex", justifyContent: "flex-end" }}>
                        {cum < 0 && <div style={{
                          width: `${w}%`, height: 10,
                          background: "var(--crit, #c0392b)", borderRadius: 2
                        }} />}
                      </div>
                      <div style={{ width: "50%" }}>
                        {cum >= 0 && <div style={{
                          width: `${w}%`, height: 10,
                          background: "var(--accent, #2d6cdf)", borderRadius: 2
                        }} />}
                      </div>
                    </div>
                  </td>
                  <td>
                    {m.items.length > 0 && (
                      <button className="btn" data-testid={`cash-open-${m.month}`}
                        onClick={() => setOpenMonth(openMonth === m.month ? null : m.month)}>
                        {m.items.length} 笔
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {openMonth && (() => {
        const m = rows.find(x => x.month === openMonth);
        if (!m) return null;
        return (
          <div className="card stack" data-testid="cash-detail" style={{ marginTop: 16 }}>
            <h3>{openMonth} 的进账明细</h3>
            <ul className="unmet" style={{ margin: 0 }}>
              {m.items.map((i, n) => (
                <li key={n}>
                  <span className={`chip ${KIND[i.kind]?.chip ?? "flat"}`}>
                    {KIND[i.kind]?.text ?? i.kind}
                  </span>
                  {" "}{i.label} —— <b>{yuan(i.inflowCents ?? 0)}</b>
                </li>
              ))}
            </ul>
            <p className="muted" style={{ margin: 0 }}>
              「预计达成」那几笔的月份是<b>从入组速度推出来的</b>，
              不是承诺 —— 入组慢一个月，它们整体右移一个月。
            </p>
          </div>
        );
      })()}

      <div className="derive" style={{ marginTop: 14 }}>
        进账分四类，<b>分开是有意的</b>：已开票（按到期日落月，最确定）、
        已逾期（同上，但压力情景里再拖 3 个月）、待开票（流程还没走完）、
        预计达成（按入组速度推，最不确定）。
        混成一个数，这套预测就开始骗人。
        <span className="muted mono" style={{ marginLeft: 8, fontSize: 12 }}>
          口径 {f.calcVersion}
        </span>
      </div>
    </>
  );
}
