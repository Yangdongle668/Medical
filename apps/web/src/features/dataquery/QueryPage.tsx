import { useEffect, useState } from "react";
import { call, ApiError, type ProblemDetails } from "../../api/client.js";
import { loadMe, type Me } from "../login/me.js";

/* ════════════════════════════════════════════════════════════════════
   数据质疑（EDC Query）。

   ── 这一页对不同的人是两件事 ──────────────────────────────────────
   CRC 打开它看到的是**待我回复**：一个待办队列。
   CRA / PM 打开它看到的是**我提的、以及我这几个中心的**：一个跟催队列。
   同一批数据，两个动词。

   ── 中间那一格是这套流程的全部意义 ────────────────────────────────
   待中心回复 → 已回复待关闭 → 已关闭。

   中间那一格不能省。**回复了不等于问题解决了** ——
   判定权在数据管理，而不是在回复的人手上。省掉它，
   「已关闭」就变成"我说我改好了"，核查时一文不值。

   ── 挂起天数不是装饰 ──────────────────────────────────────────────
   目标是平均 ≤ 5 天。超过 7 天的那些，靠系统提醒已经不够了 ——
   所以那一行给的是**电话催办**，而且催办要落库：
   「我们催过了」如果没有记录，它在核查时就等于没发生过。
   ════════════════════════════════════════════════════════════════════ */

interface Query {
  id: string; code: string; siteCode: string; hospital: string; studyShortName: string;
  subjectId: string | null; screeningNo?: string;
  form: string; fieldName: string; detail: string;
  severity: string; state: "open" | "pending_review" | "closed";
  raisedBy: string; raisedByName: string | null; raisedOn: string;
  ownerAccountId: string | null; ownerName: string | null;
  answer: string | null; answeredOn: string | null; returnedReason: string | null;
  chaseCount: number; lastChasedOn: string | null;
  closedAt: string | null; resolution: string | null;
  ageDays: number; stale: boolean;
}
interface Load {
  total: number; open: number; stale: number;
  pendingReview: number; staleReview: number; closed: number;
  meanAgeDays: number | null; worstAgeDays: number | null; meetsTarget: boolean | null;
}
interface Stats { load: Load; sites: unknown[]; calcVersion: string }

/** 目标平均关闭天数 —— 与 calc 的 QUERY_TARGET_DAYS 同一个数。 */
const TARGET = 5;

export function QueryPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [rows, setRows] = useState<Query[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [tab, setTab] = useState<"open" | "wait">("open");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  /* CRC 看「指派给我的」，其余角色看行范围内的全部 ——
     DM / CRA 不在派工表里，按 STAFF 筛会把他们筛成空的。 */
  const isCrc = me?.account.role.code === "crc";
  const reload = (crc: boolean) => Promise.all([
    call<{ items: Query[] }>("listDataQueries",
      { query: { limit: 200, ...(crc ? { mine: true } : {}) } }).then(r => setRows(r.items)),
    call<Stats>("getQueryStats", { query: crc ? { mine: true } : {} }).then(setStats)
  ]);

  useEffect(() => {
    void loadMe().then(m => { setMe(m); void reload(m.account.role.code === "crc"); });
  }, []);

  if (!me || !rows || !stats) return <p className="muted">加载中…</p>;

  const canAnswer = me.permissions.actions.includes("subjWrite");
  const canChase = me.permissions.actions.includes("raiseQ");

  const open = rows.filter(q => q.state === "open");
  const waiting = rows.filter(q => q.state !== "open");
  const shown = tab === "open" ? open : waiting;

  const act = async (op: "answerDataQuery" | "chaseDataQuery", q: Query, text: string) => {
    setBusy(true); setProblem(null); setSaid(null);
    try {
      const r = await call<{ sideEffects: { summary: string }[] }>(op, {
        params: { id: q.id },
        body: op === "answerDataQuery" ? { answer: text } : { reason: text }
      });
      await reload(isCrc);
      setDraft(d => ({ ...d, [q.id]: "" }));
      setSaid(r.sideEffects[0]?.summary ?? `${q.code} 已更新`);
    } catch (e) {
      if (e instanceof ApiError) setProblem(e.problem); else throw e;
    } finally { setBusy(false); }
  };

  return (
    <>
      <div className="page-head">
        <h2>数据质疑</h2>
        <p data-testid="query-summary">
          {isCrc
            ? <>指派给你的 {rows.length} 条，<b>{open.length} 条待你回复</b>。</>
            : <>范围内 {rows.length} 条，<b>{open.length} 条待中心回复</b>。</>}
          {stats.load.stale > 0 && <> 其中 <b>{stats.load.stale} 条挂起超过 7 天</b>。</>}
        </p>
      </div>

      <div className="derive" style={{ marginBottom: 14 }}>
        待中心回复 → <b>已回复待关闭</b> → 已关闭。
        <b>中间那一格不能省</b> —— 回复了不等于问题解决了，
        判定权在数据管理，不在回复的人手上。
        省掉它，「已关闭」就只是「我说我改好了」，而核查时看的不是这句话。
      </div>

      <div className="stats" style={{ marginBottom: 16 }}>
        <Stat label={isCrc ? "待我回复" : "待中心回复"} v={String(open.length)}
          note="球在中心那边" bad={open.length > 0} />
        <Stat label="挂起超 7 天" v={String(stats.load.stale)}
          note={stats.load.stale ? "该打电话了" : "无"} bad={stats.load.stale > 0} />
        <Stat label="平均挂起"
          v={stats.load.meanAgeDays === null
            ? "—" : `${stats.load.meanAgeDays.toFixed(1)} 天`}
          note={stats.load.meanAgeDays === null
            ? "还没有质疑" : `目标 ≤ ${TARGET} 天`}
          bad={stats.load.meetsTarget === false} />
        <Stat label="已回复待关闭" v={String(stats.load.pendingReview)}
          note={isCrc ? "等数据管理判定" : "回复合格才能关"} />
      </div>

      {stats.load.meanAgeDays !== null && (
        <div className="derive" style={{ marginBottom: 14 }} data-testid="query-mean-note">
          <b>平均挂起把没关掉的也算进去了。</b>
          只算已关闭的那些，一条永远不关的质疑就永远不进分母 ——
          越拖这个数越好看，而「平均 4.2 天，目标 5 天」底下压着的，
          正是那条挂了 {stats.load.worstAgeDays} 天没人管的。
          <span className="muted mono" style={{ marginLeft: 8, fontSize: 12 }}>
            口径 {stats.calcVersion}
          </span>
        </div>
      )}

      {problem && (
        <div className="problem stack" data-testid="query-problem" style={{ marginBottom: 12 }}>
          <strong>{problem.title}</strong>
          {problem.detail && <div>{problem.detail}</div>}
        </div>
      )}
      {said && <p className="muted" data-testid="query-said">{said}</p>}

      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        <button className={tab === "open" ? "btn primary" : "btn"}
          data-testid="query-tab-open" onClick={() => setTab("open")}>
          {isCrc ? "待我回复" : "待中心回复"} {open.length}
        </button>
        <button className={tab === "wait" ? "btn primary" : "btn"}
          data-testid="query-tab-wait" onClick={() => setTab("wait")}>
          已回复 / 已关闭 {waiting.length}
        </button>
      </div>

      {shown.length === 0 && <p className="muted" data-testid="query-empty">这一栏是空的。</p>}

      <div className="stack">
        {shown.map(q => (
          <div className="card stack" key={q.id} data-testid="query-row"
            style={q.stale ? { borderColor: "var(--crit, #c0392b)" } : undefined}>
            <div className="spread">
              <span className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <span className="mono muted" style={{ fontSize: 12 }}>{q.code}</span>
                {q.screeningNo && <span className="mono">{q.screeningNo}</span>}
                <span className="chip flat">{q.form}</span>
                <span className="muted" style={{ fontSize: 12 }}>
                  {q.hospital} · {q.studyShortName}
                </span>
              </span>
              <span className={q.stale ? "chip crit" : "chip warn"}
                data-testid="query-age">
                挂起 {q.ageDays} 天
              </span>
            </div>

            <div>{q.detail}</div>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              字段「{q.fieldName}」｜发起方 {q.raisedByName ?? "—"}
              ｜责任 CRC {q.ownerName ?? <b>无人认领</b>}
              {q.chaseCount > 0 && <>｜已催办 {q.chaseCount} 次（{q.lastChasedOn}）</>}
            </p>

            {/* 被退回过的，理由要摆在回复框上面。**退回而不说为什么，
                是把「凭空」的毛病搬到了闭环的另一端** —— CRC 只知道
                弹回来了，不知道要补什么。 */}
            {q.returnedReason && q.state === "open" && (
              <div className="problem" style={{ margin: 0 }} data-testid="query-returned">
                <b>上一次回复被退回：</b>{q.returnedReason}
              </div>
            )}

            {q.answer && (
              <p className="muted" style={{ margin: 0, fontSize: 13 }}
                data-testid="query-answer">
                <b>中心回复（{q.answeredOn}）：</b>{q.answer}
              </p>
            )}
            {q.state === "closed" && (
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                <span className="chip flat">已关闭</span> {q.resolution}
              </p>
            )}
            {q.state === "pending_review" && (
              <p className="muted" style={{ margin: 0, fontSize: 13 }}
                data-testid="query-waiting-dm">
                <span className="chip warn">已回复待关闭</span>{" "}
                等数据管理判定 —— <b>回复了不等于关闭了</b>。
              </p>
            )}

            {isCrc && canAnswer && q.state === "open" && (
              <div className="stack">
                <textarea rows={2} data-testid={`query-answer-${q.id}`}
                  placeholder="填写核实结果与源数据依据，例如：已核对原始病历，AE 开始日期录入错误，已更正为 2026-08-09，源文件第 12 页。"
                  value={draft[q.id] ?? ""}
                  onChange={e => setDraft(d => ({ ...d, [q.id]: e.target.value }))} />
                <div className="row">
                  <button className="btn primary" data-testid={`query-submit-${q.id}`}
                    disabled={busy || (draft[q.id] ?? "").trim().length < 10}
                    onClick={() => void act("answerDataQuery", q, draft[q.id] ?? "")}>
                    提交回复
                  </button>
                  <span className="muted" style={{ fontSize: 12 }}>
                    只写「已修正」的回复，数据管理判定不了 —— 至少 10 个字。
                  </span>
                </div>
              </div>
            )}

            {!isCrc && canChase && q.state === "open" && q.stale && (
              <div className="row">
                <button className="btn" data-testid={`query-chase-${q.id}`}
                  disabled={busy}
                  onClick={() => void act("chaseDataQuery", q,
                    `电话联系 ${q.ownerName ?? "责任 CRC"}，已挂起 ${q.ageDays} 天`)}>
                  电话催办并记录
                </button>
                <span className="muted" style={{ fontSize: 12 }}>
                  超 7 天未回复，靠系统提醒已经不够了 ——
                  <b>而「催过了」没有记录等于没发生过</b>。
                </span>
              </div>
            )}
          </div>
        ))}
      </div>

      {!canAnswer && !canChase && (
        <p className="muted" style={{ marginTop: 12 }} data-testid="query-readonly">
          你的角色对质疑<b>只读</b>：回复要 <span className="mono">subjWrite</span>、
          发起与催办要 <span className="mono">raiseQ</span>、
          关闭要 <span className="mono">closeQ</span> —— 三个动作三个人。
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
