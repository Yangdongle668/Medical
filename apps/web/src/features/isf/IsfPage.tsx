import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { call, ApiError, type ProblemDetails } from "../../api/client.js";
import { loadMe, type Me } from "../login/me.js";

/* ════════════════════════════════════════════════════════════════════
   中心文件与物资（ISF）。

   ── 状态不能存，只能算 ────────────────────────────────────────────
   原型把它写成 `st: "good" | "warn" | "crit"`，而同一行的备注写着
   「2026-10-18 到期，需提前 60 天递交」—— 状态本来就是从到期日推出来的。

   **存成枚举的后果是它会过期**：六月标「齐备」的那一项，
   十月已经是缺项，而没有人会回去改。库里只存事实
   （在不在、什么时候到期、还剩几份），状态由 @sitedesk/calc 按今天算。

   ── 缺失与过期是两种缺 ────────────────────────────────────────────
   一份从来没有过的证书和一份过期的证书，要做的事不一样：
   前者是去要，后者是去换。合成一个「不合格」，看的人得自己再翻一遍。

   ── 已过期的「还剩几天」是负数 ────────────────────────────────────
   折算成 0 会让「昨天过期」和「今天到期」看起来一样，
   而这两件事的紧迫程度差着一个数量级。

   ── 齐备率为空的中心不是齐备，是没人查过 ──────────────────────────
   总数为 0 时齐备率是 null，不是 100%。
   ════════════════════════════════════════════════════════════════════ */

type Status = "missing" | "expired" | "due" | "low" | "ok";
interface Item {
  id: string; studySiteId: string; siteCode: string; hospital: string;
  category: "dossier" | "credential" | "ip" | "equipment";
  item: string; present: boolean;
  expiresOn: string | null; quantity: number | null; reorderAt: number | null;
  note: string | null; checkedOn: string | null; checkedByName: string | null;
  status: Status; daysLeft: number | null; leadDays: number;
}
interface Summary {
  total: number; missing: number; expired: number; due: number; low: number; ok: number;
  readyRatio: number | null; worstDaysLeft: number | null; calcVersion: string;
}

const CATEGORY: Record<Item["category"], string> = {
  dossier: "研究者文件夹", credential: "人员资质",
  ip: "试验用药品", equipment: "检验与设备"
};
const STATUS: Record<Status, { text: string; chip: string }> = {
  missing: { text: "缺失", chip: "crit" },
  expired: { text: "已过期", chip: "crit" },
  due: { text: "临期", chip: "warn" },
  low: { text: "库存不足", chip: "warn" },
  ok: { text: "齐备", chip: "flat" }
};

/** 「还剩几天」怎么念。**负数照原样念成「已过期 N 天」** ——
 *  折算成 0 会让昨天过期和今天到期看起来一样。 */
function daysText(i: Item): string {
  if (i.status === "missing") return "缺失，没有到期日可言";
  if (i.daysLeft === null) return "无到期日";
  if (i.daysLeft < 0) return `已过期 ${-i.daysLeft} 天`;
  if (i.daysLeft === 0) return "今天到期";
  return `还剩 ${i.daysLeft} 天`;
}

export function IsfPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [items, setItems] = useState<Item[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [openOnly, setOpenOnly] = useState(false);
  const [editing, setEditing] = useState<Item | null>(null);
  const [form, setForm] = useState<{ present: boolean; expiresOn: string; note: string }>(
    { present: true, expiresOn: "", note: "" });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const reload = (only: boolean) =>
    call<{ items: Item[]; summary: Summary }>("getIsfBoard",
      { query: only ? { openOnly: true } : {} })
      .then(r => { setItems(r.items); setSummary(r.summary); });

  useEffect(() => { void loadMe().then(setMe); }, []);
  useEffect(() => { void reload(openOnly); }, [openOnly]);

  if (!me || !items || !summary) return <p className="muted">加载中…</p>;

  const canWrite = me.permissions.actions.includes("isfWrite");

  const save = async () => {
    if (!editing) return;
    setBusy(true); setProblem(null); setSaid(null);
    try {
      await call("updateIsfItem", {
        params: { id: editing.id },
        body: {
          present: form.present,
          expiresOn: form.expiresOn ? form.expiresOn : null,
          ...(form.note.trim() ? { note: form.note.trim() } : {})
        }
      });
      await reload(openOnly);
      setEditing(null);
      setSaid(`${editing.item} 已核对`);
    } catch (e) {
      if (e instanceof ApiError) setProblem(e.problem); else throw e;
    } finally { setBusy(false); }
  };

  return (
    <>
      <div className="page-head">
        <h2>中心文件与物资</h2>
        <p data-testid="isf-summary">
          {summary.total === 0
            ? <b>这个中心还没铺清单 —— 那不是「文件齐备」，是没人查过。</b>
            : <>
                共 {summary.total} 项，齐备 {summary.ok} 项
                {summary.readyRatio !== null &&
                  <>（{Math.round(summary.readyRatio * 100)}%）</>}。
                {summary.missing + summary.expired > 0 &&
                  <> <b>缺失 {summary.missing} 项、已过期 {summary.expired} 项</b>。</>}
                {summary.due + summary.low > 0 &&
                  <> 临期 {summary.due} 项、库存不足 {summary.low} 项。</>}
              </>}
        </p>
      </div>

      <div className="derive" style={{ marginBottom: 14 }}>
        <b>这里只存事实（在不在、什么时候到期、还剩几份），不存状态。</b>
        状态按<b>今天</b>算出来 —— 存成枚举它会过期：
        六月标「齐备」的那一项，十月已经是缺项，而没有人会回去改。
        <b>人员资质缺失与药品效期是核查现场最常见的两类严重发现</b>，
        它们都能被日历兜住，而一个存着过期状态的系统连日历都算不上。
      </div>

      <div className="stats" style={{ marginBottom: 16 }}>
        <Stat label="缺失" v={String(summary.missing)}
          note={summary.missing ? "去要" : "无"} bad={summary.missing > 0} />
        <Stat label="已过期" v={String(summary.expired)}
          note={summary.expired ? "去换 —— 与缺失不是一回事" : "无"}
          bad={summary.expired > 0} />
        <Stat label="临期 / 库存不足" v={`${summary.due} / ${summary.low}`}
          note="提前量按类别不同" bad={summary.due + summary.low > 0} />
        <Stat label="最紧的一项"
          v={summary.worstDaysLeft === null ? "—"
            : summary.worstDaysLeft < 0 ? `逾期 ${-summary.worstDaysLeft} 天`
            : `${summary.worstDaysLeft} 天`}
          note={summary.worstDaysLeft === null ? "没有带到期日的项" : "距到期"}
          bad={summary.worstDaysLeft !== null && summary.worstDaysLeft < 30} />
      </div>

      <div className="row" style={{ marginBottom: 12 }}>
        <label className="row" style={{ gap: 6, fontSize: 13 }}>
          <input type="checkbox" checked={openOnly} data-testid="isf-open-only"
            onChange={e => setOpenOnly(e.target.checked)} />
          只看不齐备的
        </label>
        <span className="muted" style={{ fontSize: 12 }}>
          齐备率按<b>全部清单</b>算，不按筛过之后的 ——
          否则只看这一栏时它永远是 0%。
        </span>
      </div>

      {problem && (
        <div className="problem stack" data-testid="isf-problem" style={{ marginBottom: 12 }}>
          <strong>{problem.title}</strong>
          {problem.detail && <div>{problem.detail}</div>}
        </div>
      )}
      {said && <p className="muted" data-testid="isf-said">{said}</p>}

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>中心</th><th>类别</th><th>项目</th>
                <th>状态</th><th>到期</th><th className="num">库存</th>
                <th>最近核对</th>{canWrite && <th />}
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr><td colSpan={canWrite ? 8 : 7} className="muted"
                  data-testid="isf-empty">
                  {openOnly ? "没有不齐备的项。" : "还没有铺清单。"}
                </td></tr>
              )}
              {items.map(i => (
                <tr key={i.id} data-testid="isf-row"
                  style={i.status === "missing" || i.status === "expired"
                    ? { background: "rgba(192,57,43,.06)" } : undefined}>
                  <td className="mono">{i.siteCode}</td>
                  <td>{CATEGORY[i.category]}</td>
                  <td>
                    {i.item}
                    {i.note && (
                      <div className="muted" style={{ fontSize: 12 }}>{i.note}</div>
                    )}
                  </td>
                  <td>
                    <span className={`chip ${STATUS[i.status].chip}`}
                      data-testid={`isf-status-${i.id}`}>
                      {STATUS[i.status].text}
                    </span>
                  </td>
                  <td style={{ fontSize: 13 }}>
                    {i.expiresOn ?? "—"}
                    <div className="muted" style={{ fontSize: 12 }}
                      data-testid={`isf-days-${i.id}`}>
                      {daysText(i)}
                      {i.expiresOn && <>｜提前 {i.leadDays} 天提醒</>}
                    </div>
                  </td>
                  <td className="num">
                    {i.quantity === null ? "—"
                      : <span style={i.status === "low"
                          ? { color: "var(--warn, #b7791f)" } : undefined}>
                          {i.quantity}<span className="muted"> / 补货线 {i.reorderAt}</span>
                        </span>}
                  </td>
                  <td className="muted" style={{ fontSize: 12 }}>
                    {i.checkedOn ? <>{i.checkedOn} · {i.checkedByName}</> : "从未核对"}
                  </td>
                  {canWrite && (
                    <td>
                      <button className="btn" data-testid={`isf-edit-${i.id}`}
                        onClick={() => {
                          setEditing(i);
                          setForm({ present: i.present, expiresOn: i.expiresOn ?? "", note: "" });
                          setProblem(null);
                        }}>核对</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {editing && (
        <div className="card stack" data-testid="isf-form" style={{ marginTop: 16 }}>
          <h3>核对 · {editing.item}<span className="muted"> · {editing.siteCode}</span></h3>
          <label className="row" style={{ gap: 8 }}>
            <input type="checkbox" checked={form.present} data-testid="isf-present"
              onChange={e => setForm(f => ({ ...f, present: e.target.checked }))} />
            这一项在中心文件夹里
          </label>
          <label className="field">
            <span>到期日（没有到期日就留空）</span>
            <input type="date" value={form.expiresOn} data-testid="isf-expires"
              disabled={!form.present}
              onChange={e => setForm(f => ({ ...f, expiresOn: e.target.value }))} />
          </label>
          <label className="field">
            <span>备注（可选）</span>
            <input value={form.note} data-testid="isf-note"
              placeholder="例：新护士 GCP 证书已归档，授权分工表同步更新。"
              onChange={e => setForm(f => ({ ...f, note: e.target.value }))} />
          </label>
          <div className="derive" style={{ margin: 0 }}>
            <b>不在的东西没有到期日。</b>
            标为缺失还留着到期日会被拦下 —— 缺失与过期是两种缺，
            混起来会让它们在统计上互相顶替：
            前者要去要，后者要去换。
          </div>
          <div className="row">
            <button className="btn primary" data-testid="isf-save" disabled={busy}
              onClick={() => void save()}>{busy ? "…" : "记下核对结果"}</button>
            <button className="btn" onClick={() => setEditing(null)}>取消</button>
          </div>
        </div>
      )}

      <div className="derive" style={{ marginTop: 16 }} data-testid="isf-note">
        <b>核查现场翻的就是这几摞东西。</b>
        缺件与过期最终会变成质量事件 —— 去{" "}
        <Link to="/quality">质量事件与 CAPA</Link> 看已经发生的那些，
        去 <Link to="/startup">中心启动清单</Link> 看还没启动的中心还差什么。
        <span className="muted mono" style={{ marginLeft: 8, fontSize: 12 }}>
          口径 {summary.calcVersion}
        </span>
      </div>
    </>
  );
}

function Stat({ label, v, note, bad }:
  { label: string; v: string; note: string; bad?: boolean }) {
  return (
    <div className="stat">
      <div className="stat-l">{label}</div>
      <div className="stat-v"
        style={{ fontSize: 19, ...(bad ? { color: "var(--crit, #c0392b)" } : {}) }}>{v}</div>
      <div className="stat-n">{note}</div>
    </div>
  );
}
