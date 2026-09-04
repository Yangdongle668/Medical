import { useEffect, useState } from "react";
import { call, ApiError, type ProblemDetails } from "../../api/client.js";
import { loadMe, type Me } from "../login/me.js";
import { yuan, pct, days } from "../cost/money.js";
import { NewBidForm } from "./NewBidForm.js";

/* ════════════════════════════════════════════════════════════════════
   投标与报价闭环。

   ── 这一页是报价模型的**反馈回路** ────────────────────────────────
   报价模型算「按我们的人天该报多少」，这一页算「市场认不认」。
   报出去的价赢没赢不回写，前者就是自说自话 ——
   而「我们是不是系统性报高 / 报低」这个问题永远答不了。

   所以顶上那一块不是台账的汇总，是**复盘**：
   价格偏差、失标偏差、样本数。

   ── 失标偏差比总体偏差有用得多 ────────────────────────────────────
   中标的那几标天然贴着成交价（成交价往往就是我们的价），
   把它们混进均值会把真相稀释掉。真相在失标那一边。

   ── 「问不到」不能记成「和我们一样」 ──────────────────────────────
   失标常常问不到对方报了多少。把它当成同价会把偏差算成 0，
   于是一次输得很惨的标在统计上毫无痕迹。
   所以成交价那一栏**允许缺席**，界面上写明它不进统计。
   ════════════════════════════════════════════════════════════════════ */

interface Bid {
  id: string; code: string; sponsor: string; name: string;
  submittedOn: string; sites: number; subjects: number;
  ourQuoteCents?: number; ourPersonDays: number; daysPerSubject: number;
  status: "pending" | "won" | "lost";
  decidedOn: string | null;
  winningPriceCents?: number;
  gap: number | null;
  ownerName: string | null; note: string | null;
}
interface Review {
  total: number; decided: number; won: number; winRate: number | null;
  wonAmountCents?: number; bidAmountCents?: number;
  priceBias: number | null; lostBias: number | null;
  biasSamples: number; lostBiasSamples: number;
  medianDaysPerSubject: number | null; calcVersion: string;
}

const STATUS: Record<Bid["status"], { text: string; chip: string }> = {
  pending: { text: "待定", chip: "flat" },
  won: { text: "中标", chip: "flat" },
  lost: { text: "失标", chip: "warn" }
};

/** 偏差超过这个数就值得单独看一眼。**不是"错了"的阈值** ——
 *  报价本来就该有溢价，15% 是"该问一句为什么"的线。 */
const NOTABLE = 0.15;

export function BidPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [rows, setRows] = useState<Bid[] | null>(null);
  const [rev, setRev] = useState<Review | null>(null);
  const [deciding, setDeciding] = useState<Bid | null>(null);
  const [result, setResult] = useState<"won" | "lost">("won");
  const [priceYuan, setPriceYuan] = useState("");
  const [unknown, setUnknown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const reload = () => Promise.all([
    call<{ items: Bid[] }>("listBids", { query: { limit: 100 } })
      .then(r => setRows(r.items)),
    call<Review>("getBidReview").then(setRev)
  ]);

  useEffect(() => { void loadMe().then(setMe); void reload(); }, []);

  if (!me || !rows || !rev) return <p className="muted">加载中…</p>;

  const canWrite = me.permissions.actions.includes("bid");
  /* 拿不到 price 列的人整页只能看结构，看不到钱。**整列不画**。 */
  const seesPrice = rows.some(b => b.ourQuoteCents !== undefined)
    || rev.bidAmountCents !== undefined;

  const decide = async () => {
    if (!deciding) return;
    setBusy(true); setProblem(null); setSaid(null);
    try {
      const cents = unknown || !priceYuan.trim()
        ? null : Math.round(Number(priceYuan) * 100);
      const r = await call<{ data: Bid; sideEffects: { summary: string }[] }>(
        "decideBid", { params: { id: deciding.id }, body: {
          result, ...(cents !== null ? { winningPriceCents: cents } : {})
        } });
      await reload();
      setDeciding(null); setPriceYuan(""); setUnknown(false);
      setSaid(r.sideEffects[0]?.summary ?? `${r.data.code} 已回写`);
    } catch (e) {
      if (e instanceof ApiError) setProblem(e.problem); else throw e;
    } finally { setBusy(false); }
  };

  /* 待定的排最前 —— 它们要人做事。其余按投标日倒序。 */
  const shown = [...rows].sort((a, b) =>
    Number(b.status === "pending") - Number(a.status === "pending")
    || b.submittedOn.localeCompare(a.submittedOn));
  const pending = rows.filter(b => b.status === "pending");

  return (
    <>
      <div className="page-head">
        <h2>投标与报价闭环</h2>
        <p data-testid="bid-summary">
          {rows.length} 个标
          {pending.length > 0
            ? <>，<b>{pending.length} 个还没回写结果</b>。</>
            : "，结果都回写了。"}
        </p>
      </div>

      <div className="derive" style={{ marginBottom: 14 }}>
        报价模型算「按我们的人天<b>该报多少</b>」，这一页算「市场<b>认不认</b>」。
        <br />
        <b>报出去的价赢没赢不回写，前者就是自说自话</b> ——
        「我们是不是系统性报高」这个问题会永远答不了。
      </div>

      <div className="card stack" data-testid="bid-review" style={{ marginBottom: 18 }}>
        <div className="spread">
          <h3>报价偏差复盘</h3>
          <span className="muted mono" style={{ fontSize: 12 }}>口径 {rev.calcVersion}</span>
        </div>
        <div className="stats">
          <Stat label="中标率" v={rev.winRate === null ? "—" : pct(rev.winRate)}
            note={`${rev.won} / ${rev.decided} 已出结果`} />
          <Stat label="失标偏差"
            v={rev.lostBias === null ? "—" : pct(rev.lostBias)}
            note={rev.lostBias === null
              ? "还没有可比的失标"
              : `${rev.lostBiasSamples} 个样本 · 正数 = 我们报得高`}
            bad={rev.lostBias !== null && rev.lostBias > NOTABLE} />
          <Stat label="总体偏差"
            v={rev.priceBias === null ? "—" : pct(rev.priceBias)}
            note={`${rev.biasSamples} 个样本 · 被中标的那些稀释过`} />
          <Stat label="人天/例 中位数"
            v={rev.medianDaysPerSubject === null ? "—" : days(rev.medianDaysPerSubject)}
            note="报价模型的输入就该从这里来" />
        </div>
        {seesPrice && (
          <div className="row" style={{ gap: 24, flexWrap: "wrap" }}>
            <span>报出去 <b>{yuan(rev.bidAmountCents ?? 0)}</b></span>
            <span>拿回来 <b>{yuan(rev.wonAmountCents ?? 0)}</b></span>
          </div>
        )}
        <p className="muted" style={{ margin: 0 }}>
          <b>失标偏差比总体偏差有用得多</b> ——
          中标的那几标天然贴着成交价（成交价往往就是我们的价），
          混进均值会把真相稀释掉。
          <br />
          样本数一并给出：一个样本算出来的「系统性报高 21%」，
          和二十个样本算出来的，不是一回事。
        </p>
      </div>

      {problem && (
        <div className="problem stack" data-testid="bid-problem" style={{ marginBottom: 12 }}>
          <strong>{problem.title}</strong>
          {problem.detail && <div>{problem.detail}</div>}
        </div>
      )}
      {said && <p className="muted" data-testid="bid-said">{said}</p>}

      {/* 登记入口。此前只有复盘与中标回填 —— 标是投不进去的。 */}
      {canWrite && <NewBidForm onCreated={() => void reload()} />}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>编号</th><th>申办方 · 项目</th><th>投标日</th>
              <th className="num">规模</th>
              {seesPrice && <th className="num">我们报</th>}
              <th className="num">人天/例</th>
              <th>结果</th>
              {seesPrice && <th className="num">成交价</th>}
              <th className="num">偏差</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map(b => {
              const st = STATUS[b.status];
              return (
                <tr key={b.id} data-testid="bid-row">
                  <td className="mono">{b.code}</td>
                  <td>
                    {b.sponsor}
                    <div className="muted" style={{ fontSize: 12 }}>{b.name}</div>
                  </td>
                  <td className="mono muted">{b.submittedOn}</td>
                  <td className="num muted">{b.sites} 中心 · {b.subjects} 例</td>
                  {seesPrice && (
                    <td className="num">{yuan(b.ourQuoteCents ?? 0)}</td>
                  )}
                  <td className="num">{days(b.daysPerSubject)}</td>
                  <td><span className={`chip ${st.chip}`}>{st.text}</span></td>
                  {seesPrice && (
                    <td className="num">
                      {b.winningPriceCents !== undefined
                        ? yuan(b.winningPriceCents)
                        : b.status === "pending"
                          ? <span className="muted">—</span>
                          : <span className="muted" data-testid="bid-unknown">问不到</span>}
                    </td>
                  )}
                  <td className="num">
                    {b.gap === null
                      ? <span className="muted">不进统计</span>
                      : Math.abs(b.gap) > NOTABLE
                        ? <span className="chip warn" data-testid="bid-gap">{pct(b.gap)}</span>
                        : pct(b.gap)}
                  </td>
                  <td>
                    {b.status === "pending" && canWrite
                      ? <button className="btn" data-testid={`bid-decide-${b.id}`}
                          onClick={() => {
                            setDeciding(b); setResult("won");
                            setPriceYuan(""); setUnknown(false); setProblem(null);
                          }}>回写结果</button>
                      : b.status === "pending"
                        ? <span className="muted">不归你写</span>
                        : <span className="muted mono">{b.decidedOn}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {deciding && (
        <div className="card stack" data-testid="bid-form" style={{ marginTop: 16 }}>
          <h3>回写 <span className="mono">{deciding.code}</span> · {deciding.name}</h3>
          <label className="field" style={{ maxWidth: 220 }}>
            <span>结果</span>
            <select value={result} data-testid="bid-result"
              onChange={e => {
                setResult(e.target.value as "won" | "lost");
                /* 切回中标时要把"问不到"取消掉 —— 中标必须填价。 */
                if (e.target.value === "won") setUnknown(false);
              }}>
              <option value="won">中标</option>
              <option value="lost">失标</option>
            </select>
          </label>

          {result === "lost" && (
            <label className="field" style={{ maxWidth: 320 }}>
              <span>
                <input type="checkbox" checked={unknown} data-testid="bid-unknown-check"
                  onChange={e => setUnknown(e.target.checked)} />
                {" "}问不到对方报了多少
              </span>
            </label>
          )}

          {!unknown && (
            <label className="field" style={{ maxWidth: 320 }}>
              <span>成交价（元）{result === "won" && "（必填）"}</span>
              <input type="number" min={0} value={priceYuan} data-testid="bid-price"
                onChange={e => setPriceYuan(e.target.value)} />
            </label>
          )}

          <div className={unknown ? "problem" : "derive"} style={{ margin: 0 }}>
            {unknown
              ? <><b>「问不到」不会被记成「和我们报得一样」。</b>
                  这一标照常计入中标率，但<b>不进偏差统计</b> ——
                  当成同价会把偏差算成 0，于是一次输得很惨的标毫无痕迹。</>
              : result === "won"
                ? <><b>中标必须填成交价</b> —— 那个数就在合同上。
                    不填的话，这一标就永远进不了报价偏差统计。</>
                : <>知道对方报了多少就填上 —— <b>失标的偏差是这套数里最有用的一半</b>。</>}
          </div>

          <div className="row">
            <button className="btn primary" data-testid="bid-submit"
              disabled={busy || (result === "won" && !priceYuan.trim())}
              onClick={() => void decide()}>
              {busy ? "…" : "回写"}
            </button>
            <button className="btn" onClick={() => setDeciding(null)}>取消</button>
          </div>
        </div>
      )}

      {!seesPrice && (
        <p className="muted" style={{ marginTop: 12 }} data-testid="bid-no-price">
          你的角色看不到金额（<span className="mono">price</span> 列权限），
          所以价格那几列<b>整列不画</b> —— 画一列横杠会让人以为将来会有数。
          偏差是<b>比例</b>，不含金额，所以它还在。
        </p>
      )}
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
