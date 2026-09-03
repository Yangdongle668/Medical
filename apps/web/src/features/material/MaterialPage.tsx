import { useEffect, useState } from "react";
import { call, ApiError, type ProblemDetails } from "../../api/client.js";
import { today, daysSince } from "../../shell/dates.js";

/* ════════════════════════════════════════════════════════════════════
   药品与样本。

   两本账放在一页，因为它们是同一次现场访视里做的同一类事，
   而且**都是关闭中心时对不上的那种账**。

   ── 药品：在手数量是算出来的，不是存出来的 ────────────────────────
   存了就要维护，维护就会错。为负说明发出去的比收到的多 ——
   那不是"少了几盒"，是**记账错了**，而中心一关就再也查不清了。

   只追加：记错了用**反向流水冲销**，不能改历史。核查看的就是这本台账。

   ── 样本：闭环是「收到」或「销毁」，两个都没有就是丢了 ────────────
   在路上不知去向的样本，中心一关就永远查不清。
   所以这一页把"寄出了但没确认收到"单独顶出来 —— 那不是进行中，
   那是一件迟早要出事而现在还来得及问的事。
   ════════════════════════════════════════════════════════════════════ */

interface Site { id: string; code: string; hospital: string }
interface Movement {
  id: string; movedOn: string; kind: string; quantity: number;
  subjectRef: string | null; refNo: string | null; note: string | null;
}
interface Ledger { items: Movement[]; balance: number; blocksClose: boolean }
interface Specimen {
  id: string; studySiteId: string; subjectRef: string; kind: string;
  collectedOn: string; shippedOn: string | null; receivedOn: string | null;
  discardedOn: string | null; trackingNo: string | null; closed: boolean;
}

const IP_KIND: Record<string, string> = {
  receipt: "到货", dispense: "发放", return: "受试者退回",
  ship_back: "退回申办方", destroy: "销毁登记"
};
/** 加号那几种 —— 台账上要一眼看出方向 */
const INBOUND = new Set(["receipt", "return"]);


export function MaterialPage() {
  const [sites, setSites] = useState<Site[] | null>(null);
  const [siteId, setSiteId] = useState("");
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [specimens, setSpecimens] = useState<Specimen[]>([]);
  const [tab, setTab] = useState<"ip" | "spec">("ip");
  const [adding, setAdding] = useState<"ip" | "spec" | null>(null);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  useEffect(() => {
    void call<{ items: Site[] }>("listStudySites", { query: { limit: 200 } })
      .then(r => { setSites(r.items); if (r.items[0]) setSiteId(r.items[0].id); });
  }, []);

  const load = async (id: string) => {
    const [l, s] = await Promise.all([
      call<Ledger>("listIpMovements", { params: { id }, query: { limit: 100 } }),
      call<{ items: Specimen[] }>("listSpecimens", { params: { id }, query: { limit: 100 } })
    ]);
    setLedger(l); setSpecimens(s.items);
  };
  useEffect(() => { if (siteId) void load(siteId); }, [siteId]);

  const run = async (what: string, fn: () => Promise<unknown>) => {
    setProblem(null); setSaid(null);
    try { await fn(); await load(siteId); setSaid(what); setAdding(null); }
    catch (e) { if (e instanceof ApiError) setProblem(e.problem); else throw e; }
  };

  if (!sites) return <p className="muted">加载中…</p>;
  if (!sites.length) return (
    <>
      <div className="page-head"><h2>药品与样本</h2></div>
      <p className="muted">你的行范围里没有中心。</p>
    </>
  );

  /* 寄出了但既没收到也没销毁 —— 在路上不知去向 */
  const inFlight = specimens.filter(s => s.shippedOn && !s.closed);
  const notShipped = specimens.filter(s => !s.shippedOn);

  return (
    <>
      <div className="page-head">
        <h2>药品与样本</h2>
        <p>两本账都是<b>关闭中心时对不上的那种</b>：药品在手数量、样本闭环。</p>
      </div>

      <label className="field" style={{ maxWidth: 340, marginBottom: 14 }}>
        <span>中心</span>
        <select value={siteId} data-testid="mat-site" onChange={e => setSiteId(e.target.value)}>
          {sites.map(s => <option key={s.id} value={s.id}>{s.code} · {s.hospital}</option>)}
        </select>
      </label>

      {ledger && ledger.balance < 0 && (
        <div className="problem" role="alert" data-testid="ip-negative" style={{ marginBottom: 14 }}>
          <strong>药品台账不平：算出来是 {ledger.balance}</strong>
          <div className="muted">
            发出去的比收到的多 {-ledger.balance} —— 这不是「少了几盒」，是<b>记账错了</b>。
            只追加的账改不了历史，要用<b>反向流水冲销</b>补平。
            关了中心就再也查不清了。
          </div>
        </div>
      )}

      {inFlight.length > 0 && (
        <div className="problem" data-testid="spec-inflight" style={{ marginBottom: 14 }} role="status">
          <strong>{inFlight.length} 管样本寄出了，既没确认收到也没销毁登记。</strong>
          <div className="muted">
            两个都没有就是<b>在路上不知去向</b>。最久的一管已经 {
              Math.max(...inFlight.map(s => daysSince(s.shippedOn!)))
            } 天 —— 现在还问得到实验室，中心一关就问不到了。
          </div>
        </div>
      )}

      <div className="seg" style={{ marginBottom: 14 }}>
        <button aria-pressed={tab === "ip"} data-testid="tab-ip"
          onClick={() => { setTab("ip"); setAdding(null); }}>
          药品台账 {ledger ? ledger.items.length : 0}
        </button>
        <button aria-pressed={tab === "spec"} data-testid="tab-spec"
          onClick={() => { setTab("spec"); setAdding(null); }}>
          生物样本 {specimens.length}
        </button>
      </div>

      {problem && (
        <div className="problem stack" data-testid="mat-problem" style={{ marginBottom: 12 }}>
          <strong>{problem.title}</strong>
          {problem.detail && <div>{problem.detail}</div>}
        </div>
      )}
      {said && <p className="muted" data-testid="mat-said">{said}</p>}

      {tab === "ip" ? (
        <>
          <div className="spread" style={{ marginBottom: 10 }}>
            <span className={`chip ${ledger && ledger.balance < 0 ? "crit"
              : ledger && ledger.balance > 0 ? "warn" : "good"}`} data-testid="ip-balance">
              在手 <b className="num">{ledger?.balance ?? 0}</b>
            </span>
            <button className="btn" data-testid="add-ip"
              onClick={() => setAdding("ip")}>记一笔出入库</button>
          </div>

          {adding === "ip" && (
            <IpForm onCancel={() => setAdding(null)}
              onGo={b => void run(`已记一笔${IP_KIND[b.kind]} ${b.quantity}`,
                () => call("recordIpMovement", { params: { id: siteId }, body: b }))} />
          )}

          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>日期</th><th>类型</th><th className="num">数量</th>
                  <th>受试者</th><th>凭证</th><th>说明</th></tr>
              </thead>
              <tbody>
                {(ledger?.items ?? []).map(m => (
                  <tr key={m.id} data-testid="ip-row">
                    <td className="mono muted">{m.movedOn}</td>
                    <td>{IP_KIND[m.kind] ?? m.kind}</td>
                    <td className="num">
                      {/* 方向要一眼看出来 —— 只写数字的话，
                          一列 12 / 8 / 20 看不出账是怎么变的 */}
                      <span className={INBOUND.has(m.kind) ? "" : "muted"}>
                        {INBOUND.has(m.kind) ? "+" : "−"}{m.quantity}
                      </span>
                    </td>
                    <td className="mono muted">{m.subjectRef ?? "—"}</td>
                    <td className="mono muted">{m.refNo ?? "—"}</td>
                    <td className="muted">{m.note ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="derive" style={{ marginTop: 14 }}>
            在手数量是<b>算出来的</b>，不是存出来的 —— 存了就要维护，维护就会错。
            <br />
            这本账<b>只追加</b>：记错了要用反向流水冲销，不能改历史。
            核查看的就是它，而一本能改的账在核查眼里等于没有账。
          </div>
        </>
      ) : (
        <>
          <div className="spread" style={{ marginBottom: 10 }}>
            <span className="muted">
              {specimens.filter(s => s.closed).length} / {specimens.length} 已闭环
              {notShipped.length > 0 && `｜${notShipped.length} 管还没寄出`}
            </span>
            <button className="btn" data-testid="add-spec"
              onClick={() => setAdding("spec")}>登记一管样本</button>
          </div>

          {adding === "spec" && (
            <SpecForm onCancel={() => setAdding(null)}
              onGo={b => void run(`已登记 ${b.subjectRef} 的 ${b.kind}`,
                () => call("recordSpecimen", { params: { id: siteId }, body: b }))} />
          )}

          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>受试者</th><th>类型</th><th>采集</th>
                  <th>链路</th><th>运单号</th><th /></tr>
              </thead>
              <tbody>
                {[...specimens]
                  /* 在路上的排最前 —— 它们是唯一还来得及问的 */
                  .sort((a, b) =>
                    Number(!!b.shippedOn && !b.closed) - Number(!!a.shippedOn && !a.closed)
                    || a.collectedOn.localeCompare(b.collectedOn))
                  .map(s => (
                    <tr key={s.id} data-testid="spec-row">
                      <td className="mono">{s.subjectRef}</td>
                      <td>{s.kind}</td>
                      <td className="mono muted">{s.collectedOn}</td>
                      <td>{stageChip(s)}</td>
                      <td className="mono muted">{s.trackingNo ?? "—"}</td>
                      <td>
                        <div className="row" style={{ gap: 4 }}>
                          {!s.shippedOn && (
                            <button className="btn" data-testid={`ship-${s.id}`}
                              onClick={() => void run("已登记寄出",
                                () => advance(s.id, "shipped"))}>寄出</button>
                          )}
                          {s.shippedOn && !s.closed && <>
                            <button className="btn primary" data-testid={`recv-${s.id}`}
                              onClick={() => void run("已登记实验室收到 —— 这一管闭环了",
                                () => advance(s.id, "received"))}>收到</button>
                            <button className="btn" data-testid={`disc-${s.id}`}
                              onClick={() => void run("已登记销毁 —— 这一管闭环了",
                                () => advance(s.id, "discarded"))}>销毁</button>
                          </>}
                        </div>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <div className="derive" style={{ marginTop: 14 }}>
            闭环 = 实验室<b>确认收到</b>，或者<b>销毁登记</b>。
            两个都没有 = 在路上不知去向 —— 而中心一关就再也查不清。
            <br />
            所以"寄出了但没确认"不算进行中，它是一件<b>迟早要出事、
            而现在还问得到</b>的事，要顶到最上面。
          </div>
        </>
      )}
    </>
  );
}

const advance = (id: string, stage: string) =>
  call("advanceSpecimen", { params: { id }, body: { stage, on: today() } });

function stageChip(s: Specimen) {
  if (s.receivedOn) return <span className="chip good">已收到 {s.receivedOn}</span>;
  if (s.discardedOn) return <span className="chip flat">已销毁 {s.discardedOn}</span>;
  if (s.shippedOn) {
    const d = daysSince(s.shippedOn);
    return <span className={`chip ${d > 14 ? "crit" : "warn"}`}>在途 {d} 天</span>;
  }
  return <span className="chip flat">待寄出</span>;
}

function IpForm({ onCancel, onGo }: {
  onCancel: () => void;
  onGo: (b: { kind: string; quantity: number; movedOn: string;
              subjectRef?: string; refNo?: string; note?: string }) => void;
}) {
  const [kind, setKind] = useState("dispense");
  const [qty, setQty] = useState("1");
  const [d, setD] = useState(today());
  const [subjectRef, setSubjectRef] = useState("");
  const [refNo, setRefNo] = useState("");
  const n = Number(qty);
  return (
    <div className="card stack" data-testid="ip-form" style={{ marginBottom: 12 }}>
      <div className="spread"><h3>记一笔出入库</h3>
        <button className="btn" onClick={onCancel}>取消</button></div>
      <p className="muted" style={{ margin: 0 }}>
        <b>只追加。</b> 记错了要用反向流水冲销（例如发放记多了就补一笔受试者退回），
        不能回来改这一条 —— 核查看的就是这本账。
      </p>
      <div className="grid-form">
        <label className="field"><span>类型</span>
          <select value={kind} data-testid="ip-kind" onChange={e => setKind(e.target.value)}>
            {Object.entries(IP_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select></label>
        <label className="field"><span>数量</span>
          <input type="number" min="1" value={qty} data-testid="ip-qty"
            onChange={e => setQty(e.target.value)} /></label>
        <label className="field"><span>日期</span>
          <input type="date" value={d} data-testid="ip-date"
            onChange={e => setD(e.target.value)} /></label>
      </div>
      <div className="grid-form">
        <label className="field">
          {/* 数据红线：只存筛选号/随机号，不存任何受试者可识别信息 */}
          <span>受试者编号（发放时填，只填筛选号 / 随机号）</span>
          <input value={subjectRef} data-testid="ip-subject" className="mono"
            onChange={e => setSubjectRef(e.target.value)} placeholder="例：R-0203" /></label>
        <label className="field"><span>凭证号（可选）</span>
          <input value={refNo} data-testid="ip-ref" className="mono"
            onChange={e => setRefNo(e.target.value)} /></label>
      </div>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn primary" data-testid="ip-go"
          disabled={!Number.isInteger(n) || n < 1 || !d}
          onClick={() => onGo({
            kind, quantity: n, movedOn: d,
            ...(subjectRef.trim() ? { subjectRef: subjectRef.trim() } : {}),
            ...(refNo.trim() ? { refNo: refNo.trim() } : {})
          })}>记账</button>
      </div>
    </div>
  );
}

function SpecForm({ onCancel, onGo }: {
  onCancel: () => void;
  onGo: (b: { subjectRef: string; kind: string; collectedOn: string;
              trackingNo?: string }) => void;
}) {
  const [subjectRef, setSubjectRef] = useState("");
  const [kind, setKind] = useState("");
  const [d, setD] = useState(today());
  const [tracking, setTracking] = useState("");
  return (
    <div className="card stack" data-testid="spec-form" style={{ marginBottom: 12 }}>
      <div className="spread"><h3>登记一管样本</h3>
        <button className="btn" onClick={onCancel}>取消</button></div>
      <div className="grid-form">
        <label className="field"><span>受试者编号（筛选号 / 随机号）</span>
          <input value={subjectRef} data-testid="spec-subject" className="mono"
            onChange={e => setSubjectRef(e.target.value)} placeholder="例：R-0203" /></label>
        <label className="field"><span>样本类型</span>
          <input value={kind} data-testid="spec-kind"
            onChange={e => setKind(e.target.value)} placeholder="例：全血 / 血清 / 尿" /></label>
        <label className="field"><span>采集日</span>
          <input type="date" value={d} data-testid="spec-date"
            onChange={e => setD(e.target.value)} /></label>
        <label className="field"><span>运单号（可选）</span>
          <input value={tracking} data-testid="spec-tracking" className="mono"
            onChange={e => setTracking(e.target.value)} /></label>
      </div>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn primary" data-testid="spec-go"
          disabled={!subjectRef.trim() || !kind.trim() || !d}
          onClick={() => onGo({
            subjectRef: subjectRef.trim(), kind: kind.trim(), collectedOn: d,
            ...(tracking.trim() ? { trackingNo: tracking.trim() } : {})
          })}>登记</button>
      </div>
    </div>
  );
}
