import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { call, ApiError, type ProblemDetails } from "../../api/client.js";
import { loadMe, type Me } from "../login/me.js";
import { yuan, pct } from "../cost/money.js";

/* ════════════════════════════════════════════════════════════════════
   客户档案。

   ── 比「单中心毛利」更上位的一个切片 ──────────────────────────────
   系统此前只按「项目 / 中心」切。而有几个问题在那个粒度上问不出来：

     · 这个客户一共欠了我们多少、平均拖多久？
     · 压价最狠的那家，是不是也是回款最慢的那家？
     · 明年还要不要接他的项目？

   最后一个才是这一页真正的用途 —— 它不是通讯录。

   ── 账期是这里最要紧的一个数 ──────────────────────────────────────
   同样一笔里程碑，月结 45 天和月结 90 天进账差一个半月，
   而现金流的缺口就出现在那一个半月里。
   所以它可改（谈下来的账期要能落进系统），但**改了不回溯历史发票** ——
   已开出去的票，到期日在开票那一刻就固化了。

   ── 这一页存在的另一半理由 ────────────────────────────────────────
   `study.sponsor_name` 原来是个字符串（迁移 0004 就写着"届时改为 FK"）。
   升成一张表不是为了规范化，是因为**按字符串分组算不出上面那些数** ——
   同一个客户在不同项目里名字写得不完全一样，一次就够毁掉那个数。
   ════════════════════════════════════════════════════════════════════ */

interface Client {
  id: string; name: string;
  sinceYear: number | null; contact: string | null;
  paymentTermsDays: number; nps: number | null; note: string | null;
  studyCount: number; siteCount: number;
  enrolled: number; plannedSubjects: number;
  contractCents?: number; paidCents?: number;
  receivableCents?: number; overdueCents?: number;
  meanArDays: number | null;
}

/** 账期超过这条线就该在报价里把资金成本算进去。 */
const LONG_TERMS = 75;

export function ClientPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [rows, setRows] = useState<Client[] | null>(null);
  const [editing, setEditing] = useState<Client | null>(null);
  const [terms, setTerms] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const reload = () =>
    call<{ items: Client[] }>("listClients", { query: { limit: 100 } })
      .then(r => setRows(r.items));

  useEffect(() => { void loadMe().then(setMe); void reload(); }, []);

  if (!me || !rows) return <p className="muted">加载中…</p>;

  const canEdit = me.permissions.actions.includes("manage");
  const seesMoney = rows.some(c => c.contractCents !== undefined);

  const save = async () => {
    if (!editing) return;
    setBusy(true); setProblem(null); setSaid(null);
    try {
      await call<Client>("updateClient", {
        params: { id: editing.id },
        body: {
          ...(terms.trim() ? { paymentTermsDays: Number(terms) } : {}),
          ...(note !== editing.note ? { note } : {})
        }
      });
      await reload();
      setEditing(null);
      setSaid(`${editing.name} 已更新 —— 已开出去的票，到期日不受影响`);
    } catch (e) {
      if (e instanceof ApiError) setProblem(e.problem); else throw e;
    } finally { setBusy(false); }
  };

  /* 逾期最多的排最前。**不按合同额排** —— 一个大客户按时付款，
     不需要每天看；一个小客户拖了三个月，需要。 */
  const shown = [...rows].sort((a, b) =>
    (b.overdueCents ?? 0) - (a.overdueCents ?? 0)
    || (b.receivableCents ?? 0) - (a.receivableCents ?? 0)
    || a.name.localeCompare(b.name));
  const withOverdue = rows.filter(c => (c.overdueCents ?? 0) > 0);

  return (
    <>
      <div className="page-head">
        <h2>客户</h2>
        <p data-testid="client-summary">
          {rows.length} 家申办方
          {withOverdue.length > 0
            ? <>，<b>{withOverdue.length} 家有逾期未付</b>。</>
            : "，没有逾期未付的。"}
        </p>
      </div>

      <div className="derive" style={{ marginBottom: 14 }}>
        这一页<b>不是通讯录</b>。它回答的是按项目切看不出来的那几个问题：
        这个客户一共欠多少、平均拖多久、压价最狠的那家是不是也回款最慢 ——
        以及<b>明年还要不要接他的项目</b>。
      </div>

      <div className="stack">
        {shown.map(c => {
          const late = (c.overdueCents ?? 0) > 0;
          const attain = c.plannedSubjects > 0 ? c.enrolled / c.plannedSubjects : null;
          return (
            <div className="card stack" key={c.id} data-testid="client-row"
              style={late ? { borderColor: "var(--crit, #c0392b)" } : undefined}>
              <div className="spread">
                <h3>
                  {c.name}
                  <span className="muted" style={{ fontSize: 13, marginLeft: 8 }}>
                    {c.sinceYear ? `${c.sinceYear} 年起合作` : "合作年份未记"}
                    {c.contact && ` · ${c.contact}`}
                  </span>
                </h3>
                <span>
                  <span className={c.paymentTermsDays > LONG_TERMS ? "chip warn" : "chip flat"}
                    data-testid="client-terms">
                    月结 {c.paymentTermsDays} 天
                  </span>
                  {c.nps !== null && (
                    <span className="chip flat" style={{ marginLeft: 6 }}>
                      关系 {c.nps}/10
                    </span>
                  )}
                </span>
              </div>

              <div className="row" style={{ gap: 20, flexWrap: "wrap" }}>
                <span>{c.studyCount} 个项目 · {c.siteCount} 个中心</span>
                <span>
                  入组 {c.enrolled}/{c.plannedSubjects}
                  {attain !== null && <span className="muted"> · {pct(attain)}</span>}
                </span>
                {seesMoney && <>
                  <span>合同额 <b>{yuan(c.contractCents!)}</b></span>
                  <span className="muted">已回款 {yuan(c.paidCents!)}</span>
                  <span>
                    应收 <b>{yuan(c.receivableCents!)}</b>
                    {late && (
                      <span className="chip crit" style={{ marginLeft: 6 }}
                        data-testid="client-overdue">
                        逾期 {yuan(c.overdueCents!)}
                      </span>
                    )}
                  </span>
                </>}
                <span className="muted">
                  {c.meanArDays === null
                    ? "没有在途应收"
                    : `应收平均账龄 ${Math.round(c.meanArDays)} 天`}
                </span>
              </div>

              {c.paymentTermsDays > LONG_TERMS && (
                <p className="muted" style={{ margin: 0, fontSize: 13 }}
                  data-testid="client-long-terms">
                  账期 {c.paymentTermsDays} 天 —— <b>下次报价要把资金成本算进去</b>。
                  同样一笔里程碑，月结 45 天和 {c.paymentTermsDays} 天进账差
                  {" "}{Math.round((c.paymentTermsDays - 45) / 30)} 个多月，
                  而现金流的缺口就出现在那段时间里。
                </p>
              )}

              {c.note && (
                <p className="muted" style={{ margin: 0 }} data-testid="client-note">
                  {c.note}
                </p>
              )}

              <div className="row">
                <Link to={`/bill?client=${c.id}`} className="btn"
                  style={{ textDecoration: "none" }}>看他的里程碑</Link>
                {canEdit && (
                  <button className="btn" data-testid={`client-edit-${c.id}`}
                    onClick={() => {
                      setEditing(c);
                      setTerms(String(c.paymentTermsDays));
                      setNote(c.note ?? ""); setProblem(null);
                    }}>改档案</button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {problem && (
        <div className="problem stack" data-testid="client-problem" style={{ marginTop: 12 }}>
          <strong>{problem.title}</strong>
          {problem.detail && <div>{problem.detail}</div>}
        </div>
      )}
      {said && <p className="muted" data-testid="client-said">{said}</p>}

      {editing && (
        <div className="card stack" data-testid="client-form" style={{ marginTop: 16 }}>
          <h3>改 {editing.name} 的档案</h3>
          <label className="field" style={{ maxWidth: 260 }}>
            <span>合同账期（天）</span>
            <input type="number" min={0} max={365} value={terms} data-testid="client-terms-input"
              onChange={e => setTerms(e.target.value)} />
          </label>
          <label className="field">
            <span>备注</span>
            <textarea rows={2} value={note} data-testid="client-note-input"
              onChange={e => setNote(e.target.value)} />
          </label>
          <div className="derive" style={{ margin: 0 }}>
            <b>账期改了不回溯历史发票。</b>
            已经开出去的票，到期日在开票那一刻就固化了 ——
            否则改一次账期，应收账龄会集体位移，而昨天的报表和今天的对不上。
          </div>
          <div className="row">
            <button className="btn primary" data-testid="client-submit"
              disabled={busy} onClick={() => void save()}>
              {busy ? "…" : "保存"}
            </button>
            <button className="btn" onClick={() => setEditing(null)}>取消</button>
          </div>
        </div>
      )}

      <div className="derive" style={{ marginTop: 14 }}>
        申办方在此之前是 <span className="mono">study</span> 上的一个字符串
        （迁移 0004 就写着「届时改为 FK」）。升成一张表<b>不是为了规范化</b>，
        是因为上面那几个数按字符串分组算不出来 ——
        同一个客户在不同项目里名字写得不完全一样，一次就够毁掉那个数。
      </div>
    </>
  );
}
