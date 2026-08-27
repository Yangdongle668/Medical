import { useEffect, useState } from "react";
import { call } from "../../api/client.js";

/* 药品在手数量（I5 的台账面）。
   这个数**是算出来的**，不是存出来的 —— 存了就要维护，而维护就会错。
   为负说明发出去的比收到的多：那不是"少了几盒"，是**记账错了**，
   而中心一关就再也查不清了。关闭闸门看的正是这两种情况。 */

interface Movement {
  id: string; movedOn: string; kind: string; quantity: number;
  subjectRef: string | null; refNo: string | null; note: string | null;
}
interface Ledger {
  items: Movement[]; balance: number; blocksClose: boolean;
}

const KIND: Record<string, string> = {
  receipt: "到货", dispense: "发放", return: "受试者退回",
  ship_back: "退回申办方", destroy: "销毁登记"
};
/** 加号那几种和减号那几种 —— 台账上要一眼看出方向 */
const INBOUND = new Set(["receipt", "return"]);

export function IpPanel({ studySiteId }: { studySiteId: string }) {
  const [led, setLed] = useState<Ledger | null>(null);
  useEffect(() => {
    call<Ledger>("listIpMovements", { params: { id: studySiteId }, query: { limit: 50 } })
      .then(setLed).catch(() => setLed(null));
  }, [studySiteId]);

  if (!led) return null;

  return (
    <section className="card stack" data-testid="ip-panel">
      <div className="spread">
        <h3 style={{ margin: 0, fontSize: 14 }}>药品台账</h3>
        <span className={`chip ${led.balance < 0 ? "crit" : led.balance > 0 ? "warn" : "good"}`}
          data-testid="ip-balance-chip">
          在手 <b className="num">{led.balance}</b>
        </span>
      </div>

      {led.balance < 0 && (
        <div className="problem" data-testid="ip-negative">
          <strong>台账不平：算出来是 {led.balance}</strong>
          <div>
            发出去的比收到的多 {-led.balance} —— 这不是"少了几盒"，是<b>记账错了</b>。
            先把流水补齐或找出差在哪：关了中心就查不清了。
          </div>
        </div>
      )}
      {led.balance > 0 && (
        <p className="muted" style={{ margin: 0, fontSize: 12 }} data-testid="ip-remaining">
          中心还有 {led.balance} 份药品在手 —— 退回申办方或登记销毁之后才能关闭中心。
        </p>
      )}

      {led.items.length === 0 ? (
        <p className="muted" style={{ margin: 0 }} data-testid="ip-none">还没有药品流水。</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>日期</th><th>动作</th><th>数量</th><th>受试者</th><th>单号</th></tr>
            </thead>
            <tbody>
              {led.items.map(m => (
                <tr key={m.id} data-testid="ip-row">
                  <td className="mono">{m.movedOn}</td>
                  <td>{KIND[m.kind] ?? m.kind}</td>
                  <td className="num">
                    {INBOUND.has(m.kind) ? "+" : "−"}{m.quantity}
                  </td>
                  <td className="mono">{m.subjectRef ?? "—"}</td>
                  <td className="mono">{m.refNo ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        流水<b>只追加</b>：记错了要用反向流水冲销，不能改历史 —— 核查看的就是这本台账。
      </p>
    </section>
  );
}
