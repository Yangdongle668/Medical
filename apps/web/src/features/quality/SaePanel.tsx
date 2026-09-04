import { useCallback, useEffect, useState } from "react";
import { useToast } from "@sitedesk/ui/react";
import { call, ApiError, type ProblemDetails } from "../../api/client.js";
import { CreateForm, Field, Area } from "../../shell/CreateForm.js";
import { loadMe } from "../login/me.js";

/* ════════════════════════════════════════════════════════════════════
   SAE 台账与 24 小时及时率（I6）。

   这一页存在的理由写在 `packages/calc/src/kernel.ts` 的开头：
   原型里「SAE 24h 及时率」是一个**写死的常量**，而同一个页面下方
   就摆着一条超窗的 SAE。演示时没人看得出来，真实系统里这就是看板骗人。

   所以这里画三样东西，缺一不可：
   ① 及时率本身，带口径版本号；
   ② **最坏的那一条晚了多久** —— 92% 促不成任何动作，"最坏一条晾了 8 天"能；
   ③ 还在计时的那几条 —— 人要知道现在该去做什么，而不是事后再看一个百分比。
   ════════════════════════════════════════════════════════════════════ */

interface Sae {
  id: string; code: string; title: string; detail: string;
  occurredAt: string | null; reportedAt: string | null; reportHours: number | null;
  state: string;
}
interface Timeliness {
  total: number; onTime: number; late: number; pending: number;
  rate: number | null; worstLateHours: number | null; calcVersion: string;
}
interface Ledger { items: Sae[]; timeliness: Timeliness }

const DEADLINE_HOURS = 24;

/** 小时读起来太长时换成天。`8.3 天` 比 `199.2 小时` 更能让人有反应。 */
function howLong(h: number): string {
  return h < 48 ? `${h.toFixed(1)} 小时` : `${(h / 24).toFixed(1)} 天`;
}

const when = (iso: string | null) => iso ? iso.replace("T", " ").slice(0, 16) : "—";

export function SaePanel({ studySiteId }: { studySiteId: string }) {
  const [led, setLed] = useState<Ledger | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  /** 正在给哪一条补上报时刻 —— 行内，因为要对着"发生时刻"那一行填。 */
  const [reportingId, setReportingId] = useState<string | null>(null);
  const [reportedAt, setReportedAt] = useState("");
  const say = useToast();

  const load = useCallback(() => {
    void call<Ledger>("listSaeEvents", { params: { id: studySiteId }, query: { limit: 50 } })
      .then(setLed).catch(() => setLed(null));
  }, [studySiteId]);
  useEffect(load, [load]);

  useEffect(() => {
    void loadMe()
      .then(m => setCanWrite(m.permissions.actions.includes("subjWrite")))
      .catch(() => setCanWrite(false));
  }, []);

  /** 登记「已上报」。**超过 24 小时的，服务端会在同一个事务里
   *  生成一条 sae_late 质量事件** —— 不可跳过，也不能人工删除，
   *  只能整改关闭。所以按下去之前界面上要说清这一点。 */
  const markReported = async (e: Sae) => {
    setBusy(true); setProblem(null);
    try {
      const r = await call<{ sideEffects: { summary: string }[] }>(
        "reportSaeSubmitted",
        { params: { id: e.id }, body: { reportedAt: new Date(reportedAt).toISOString() } });
      load();
      setReportingId(null); setReportedAt("");
      say(r.sideEffects[0]?.summary ?? `${e.code} 已登记上报`);
    } catch (err) {
      if (err instanceof ApiError) setProblem(err.problem); else throw err;
    } finally { setBusy(false); }
  };

  if (!led) return null;
  const t = led.timeliness;

  return (
    <section className="card stack" data-testid="sae-panel">
      <div className="spread">
        <h3 style={{ margin: 0, fontSize: 14 }}>SAE 24 小时上报</h3>
        <span className="muted mono" style={{ fontSize: 11 }}>
          口径 {t.calcVersion}
        </span>
      </div>

      {problem && (
        <div className="problem" data-testid="sae-problem">
          <strong>{problem.title}</strong>
          {problem.detail && <div>{problem.detail}</div>}
        </div>
      )}

      {/* 登记入口。此前这一格只能看 —— 而「录一条 SAE」正是它
          要服务的那个动作发生的时刻。 */}
      {canWrite && <ReportSaeForm studySiteId={studySiteId} onCreated={load} />}

      {t.total === 0 ? (
        /* 「还没有 SAE」和「及时率 100%」是两回事。
            后者是在用一个没有分母的数字给人安全感。 */
        <p className="muted" data-testid="sae-none" style={{ margin: 0 }}>
          这个中心还没有 SAE 记录 —— 及时率没有分母，所以这里不给数字。
        </p>
      ) : (
        <>
          <div className="row" style={{ gap: 16, flexWrap: "wrap" }}>
            <div>
              <div className="muted" style={{ fontSize: 11 }}>及时率</div>
              <b className="num" data-testid="sae-rate" style={{ fontSize: 20 }}>
                {t.rate === null ? "—" : `${Math.round(t.rate * 100)}%`}
              </b>
              <div className="muted" style={{ fontSize: 11 }}>
                {t.onTime} 按时 / {t.onTime + t.late} 已到点
              </div>
            </div>
            {t.worstLateHours !== null && (
              /* 一个百分比促不成任何动作，"最坏的那一条"能。 */
              <div>
                <div className="muted" style={{ fontSize: 11 }}>最坏的一条超时</div>
                <b className="num" data-testid="sae-worst" style={{ fontSize: 20 }}>
                  {howLong(t.worstLateHours - DEADLINE_HOURS)}
                </b>
                <div className="muted" style={{ fontSize: 11 }}>超过 24 小时时限</div>
              </div>
            )}
            {t.pending > 0 && (
              <div>
                <div className="muted" style={{ fontSize: 11 }}>还在计时</div>
                <b className="num" data-testid="sae-pending" style={{ fontSize: 20 }}>
                  {t.pending}
                </b>
                <div className="muted" style={{ fontSize: 11 }}>未满 24 小时，未上报</div>
              </div>
            )}
          </div>

          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            超过 24 小时仍未上报的<b>直接计入迟报</b> ——
            否则一条永远不上报的 SAE 就永远不进分母，越拖越好看。
          </p>

          <ul className="stack" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {led.items.map(e => {
              const late = e.reportHours === null
                ? Date.now() - new Date(e.occurredAt ?? 0).getTime() > DEADLINE_HOURS * 3.6e6
                : e.reportHours > DEADLINE_HOURS;
              return (
                <li key={e.id} className="card" data-testid="sae-row">
                  <div className="spread">
                    <span className="mono">{e.code}</span>
                    <span className={`chip ${late ? "crit" : e.reportedAt ? "good" : "warn"}`}
                      data-testid="sae-chip">
                      {e.reportedAt
                        ? (late ? "超时上报" : "按时上报")
                        : (late ? "尚未上报（已超时）" : "尚未上报（计时中）")}
                    </span>
                  </div>
                  <div style={{ margin: "6px 0 2px" }}>{e.title}</div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    发生 {when(e.occurredAt)} · 上报 {when(e.reportedAt)}
                    {e.reportHours !== null && (
                      /* 不四舍五入：把 24.4 小时显示成 24 小时是在替人开脱 */
                      <> · 经过 <b className="num">{e.reportHours.toFixed(1)}</b> 小时</>
                    )}
                  </div>

                  {/* 还没上报的那几条，补上报时刻。**这是唯一能让
                      「还在计时」变成「已上报」的动作** —— 没有它，
                      一条 SAE 只能永远挂在计时里，然后被算成迟报。 */}
                  {canWrite && !e.reportedAt && (
                    reportingId === e.id ? (
                      <div className="stack" style={{ gap: 8, marginTop: 8 }}>
                        <label className="field">
                          <span>
                            上报时刻 <span className="t-mut">
                              · 递交监管的那一刻，不是现在录入的这一刻</span>
                          </span>
                          <input type="datetime-local" value={reportedAt}
                            data-testid={`sae-reported-at-${e.id}`}
                            onChange={ev => setReportedAt(ev.target.value)} />
                        </label>
                        {/* 超 24 小时的后果，按下去之前就说清楚。 */}
                        {late && (
                          <div className="problem" data-testid="sae-late-warn">
                            这一条已经超过 24 小时。登记之后服务端会在
                            <b>同一个事务里</b>生成一条超时质量事件 ——
                            它<b>不可跳过、也不能人工删除</b>，只能整改关闭。
                          </div>
                        )}
                        <div className="row">
                          <button className="btn btn-p" data-testid={`sae-report-save-${e.id}`}
                            disabled={busy || !reportedAt}
                            onClick={() => void markReported(e)}>登记已上报</button>
                          <button className="btn link"
                            onClick={() => { setReportingId(null); setReportedAt(""); }}>
                            取消
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button className="btn" style={{ marginTop: 8 }}
                        data-testid={`sae-report-${e.id}`}
                        onClick={() => {
                          setReportingId(e.id); setReportedAt(""); setProblem(null);
                        }}>登记已上报</button>
                    )
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

/* ════════════════════════════════════════════════════════════════════
   登记一条 SAE。

   ── 发生时刻不能默认成"现在" ────────────────────────────────────
   契约原话：`occurredAt` 是**发生（或研究者知悉）**的时刻，不是录入时刻 ——
   **两者混为一谈，及时率就永远是 100%。**

   所以这一栏没有"填上现在"的便利按钮，也不预填当前时间：
   预填等于替人回答了那个决定及时率的问题，而他多半会直接按下去。

   ── 上报时刻可以留空 ───────────────────────────────────────────
   先记事件、上报之后再补是常态（那正是台账上"还在计时"那几条）。
   留空不是漏填，所以旁边说清楚它意味着什么。
   ════════════════════════════════════════════════════════════════════ */
function ReportSaeForm({ studySiteId, onCreated }:
  { studySiteId: string; onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [occurredAt, setOccurredAt] = useState("");
  const [reportedAt, setReportedAt] = useState("");

  const ready = !!(title.trim() && detail.trim().length >= 4 && occurredAt);

  return (
    <CreateForm
      testid="new-sae" cta="登记一条 SAE" title="严重不良事件登记"
      sub="发生时刻决定及时率 —— 它不是录入时刻" ready={ready}
      note={<>上报时刻可以留空，之后在台账上补 —— 那几条会显示为「还在计时」。</>}
      onSubmit={async () => {
        await call("reportSae", {
          params: { id: studySiteId },
          body: {
            title: title.trim(), detail: detail.trim(),
            occurredAt: new Date(occurredAt).toISOString(),
            ...(reportedAt ? { reportedAt: new Date(reportedAt).toISOString() } : {})
          }
        });
        const said = `SAE「${title.trim()}」已登记`;
        setTitle(""); setDetail(""); setOccurredAt(""); setReportedAt("");
        onCreated();
        return said;
      }}>
      <Field label="事件名称" v={title} on={setTitle} testid="sae-title"
        placeholder="例：III 度中性粒细胞减少伴发热" />
      <Area label="经过" hint="至少 4 字" v={detail} on={setDetail} testid="sae-detail" rows={3}
        placeholder="例：受试者于第 2 周期 D8 出现寒战高热，血常规示 ANC 0.4×10⁹/L，收入院予以升白与抗感染治疗。" />

      <div className="grid-form">
        <Field label="发生（或研究者知悉）时刻" hint="不是现在" v={occurredAt}
          on={setOccurredAt} testid="sae-occurred" type="datetime-local" />
        <Field label="上报时刻" hint="可留空，之后再补" v={reportedAt}
          on={setReportedAt} testid="sae-reported" type="datetime-local" />
      </div>

      <div className="derive">
        <b>发生时刻不是录入时刻。</b>
        两者混为一谈，及时率就永远是 100% —— 所以这一栏不预填当前时间：
        预填等于替人回答了那个决定及时率的问题，而他多半会直接按下去。
      </div>
    </CreateForm>
  );
}
