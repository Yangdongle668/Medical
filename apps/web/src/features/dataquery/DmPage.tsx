import { useEffect, useState } from "react";
import { call, ApiError, type ProblemDetails } from "../../api/client.js";
import { loadMe, type Me } from "../login/me.js";

/* ════════════════════════════════════════════════════════════════════
   数据管理 DM 工作台。

   ── 这一页存在的理由，是原型自己写下的一句话 ──────────────────────
   「此前 QUERIES 里 by:"数据管理" 出现了 5 次，却没有这个角色 ——
     质疑凭空产生、凭空关闭。」

   补齐的是闭环的两端：
     · **发起**：DM 与 CRA 都可以（raiseQ）。CRA 的 SDV 产出恰恰就是质疑，
       而此前 CRA 只能"看到"质疑、不能"提出"质疑。
     · **关闭**：只有 DM（closeQ）。中心回复了不等于问题解决了。

   ── 每例质疑数高，不一定是中心差 ──────────────────────────────────
   原型写了这句话，但没给区分的办法。区分的线索是**集中度**：

     · 扎堆在一个表单上 → 是这个表单本身难填。要改的是 eCRF 或培训材料，
       换一家中心照样会出。
     · 散在七八个表单上 → 才是这家中心的录入质量问题。要改的是人。

   两件事要做的动作完全相反，所以密度和集中度必须一起给 ——
   只给密度，那句"高不一定是中心差"就只是一句免责声明。

   ── 与机构质控是两条线 ────────────────────────────────────────────
   机构办是**外部**的质量反馈闭环，DM 是**内部**的数据质量闭环。
   两条线共用 quality_event 一张表，但外部方看不到 kind='query'
   （迁移 0032 的行策略）—— 否则一家医院会因为几条例行的数据核实，
   在质控页上看到一个像是要挨检查的数字。
   ════════════════════════════════════════════════════════════════════ */

interface Query {
  id: string; code: string; siteCode: string; hospital: string;
  subjectId: string | null; screeningNo?: string;
  form: string; fieldName: string; detail: string;
  state: "open" | "pending_review" | "closed";
  raisedByName: string | null; ownerName: string | null;
  answer: string | null; answeredOn: string | null;
  ageDays: number; stale: boolean;
}
interface SiteRow {
  studySiteId: string; siteCode: string; hospital: string;
  enrolled: number; total: number; open: number;
  meanAgeDays: number | null; perSubject: number | null;
  band: "ok" | "watch" | "bad" | null;
  topForm: string | null; topFormShare: number | null;
  verdict: "too-few" | "form" | "entry";
}
interface Load {
  total: number; open: number; stale: number;
  pendingReview: number; staleReview: number; closed: number;
  meanAgeDays: number | null; worstAgeDays: number | null; meetsTarget: boolean | null;
}
interface Stats { load: Load; sites: SiteRow[]; calcVersion: string }
interface Subject {
  id: string; screeningNo?: string; siteCode: string; state: string; crcName: string | null;
}

const FORMS = [
  "合并用药 CM", "不良事件 AE", "实验室检查 LB", "生命体征 VS",
  "访视日期 SV", "疗效评估 RS", "用药依从性 EX", "既往病史 MH"
];
const TARGET = 5;
const VERDICT: Record<SiteRow["verdict"], string> = {
  "too-few": "质疑太少，不下结论",
  form: "集中在一个表单 —— 是这张表难填，不是这家中心差",
  entry: "散在多个表单 —— 这是录入质量问题"
};

export function DmPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [rows, setRows] = useState<Query[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [subjects, setSubjects] = useState<Subject[] | null>(null);
  const [form, setForm] = useState(FORMS[0]!);
  const [subjectId, setSubjectId] = useState("");
  const [field, setField] = useState("");
  const [text, setText] = useState("");
  const [judging, setJudging] = useState<{ q: Query; kind: "close" | "return" } | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const reload = () => Promise.all([
    call<{ items: Query[] }>("listDataQueries", { query: { limit: 200 } })
      .then(r => setRows(r.items)),
    call<Stats>("getQueryStats", {}).then(setStats)
  ]);

  useEffect(() => {
    void loadMe().then(setMe);
    void reload();
    void call<{ items: Subject[] }>("listSubjects", { query: { limit: 200 } })
      .then(r => {
        /* 筛败的不再录数据 —— 对他提质疑是提给一个已经关掉的档案。 */
        const ok = r.items.filter(s => s.state !== "screen_failed");
        setSubjects(ok);
        if (ok[0]) setSubjectId(ok[0].id);
      });
  }, []);

  if (!me || !rows || !stats || !subjects) return <p className="muted">加载中…</p>;

  const canRaise = me.permissions.actions.includes("raiseQ");
  const canClose = me.permissions.actions.includes("closeQ");
  const pending = rows.filter(q => q.state === "pending_review");

  const raise = async () => {
    setBusy(true); setProblem(null); setSaid(null);
    try {
      const r = await call<{ sideEffects: { summary: string }[] }>("raiseDataQuery", {
        body: { subjectId, form, fieldName: field.trim(), detail: text.trim() }
      });
      await reload();
      setField(""); setText("");
      setSaid(r.sideEffects[0]?.summary ?? "已发起");
    } catch (e) {
      if (e instanceof ApiError) setProblem(e.problem); else throw e;
    } finally { setBusy(false); }
  };

  const judge = async () => {
    if (!judging) return;
    setBusy(true); setProblem(null); setSaid(null);
    try {
      const r = await call<{ sideEffects: { summary: string }[] }>(
        judging.kind === "close" ? "closeDataQuery" : "returnDataQuery",
        { params: { id: judging.q.id }, body: { reason: reason.trim() } });
      await reload();
      setJudging(null); setReason("");
      setSaid(r.sideEffects[0]?.summary ?? `${judging.q.code} 已更新`);
    } catch (e) {
      if (e instanceof ApiError) setProblem(e.problem); else throw e;
    } finally { setBusy(false); }
  };

  return (
    <>
      <div className="page-head">
        <h2>数据管理工作台</h2>
        <p data-testid="dm-summary">
          {stats.load.total} 条质疑：<b>{stats.load.open} 条待中心回复</b>
          {stats.load.pendingReview > 0 && <>，<b>{stats.load.pendingReview} 条待我关闭</b></>}
          {stats.load.stale > 0 && <>，{stats.load.stale} 条挂起超过 7 天</>}。
        </p>
      </div>

      <div className="derive" style={{ marginBottom: 14 }}>
        此前系统里<b>没有数据管理这个角色</b> —— 质疑凭空产生、凭空关闭，
        没有人对它负责。现在补齐了闭环的两端：
        <b>发起</b>（DM 与 CRA 都可以，受 <span className="mono">raiseQ</span> 约束 ——
        CRA 的 SDV 产出恰恰就是质疑）、
        <b>关闭</b>（只有 DM，<span className="mono">closeQ</span> ——
        中心回复了不等于问题解决了）。
      </div>

      <div className="stats" style={{ marginBottom: 16 }}>
        <Stat label="待中心回复" v={String(stats.load.open)}
          note="球在中心那边" bad={stats.load.open > 0} />
        <Stat label="挂起超 7 天" v={String(stats.load.stale)}
          note={stats.load.stale ? "该打电话了" : "无"} bad={stats.load.stale > 0} />
        <Stat label="已回复待我关闭" v={String(stats.load.pendingReview)}
          note="回复合格才能关" />
        <Stat label="平均挂起"
          v={stats.load.meanAgeDays === null
            ? "—" : `${stats.load.meanAgeDays.toFixed(1)} 天`}
          note={`目标 ≤ ${TARGET} 天`} bad={stats.load.meetsTarget === false} />
      </div>

      {stats.load.staleReview > 0 && (
        <div className="problem" style={{ marginBottom: 14 }} data-testid="dm-my-debt">
          <b>{stats.load.staleReview} 条已回复的，在我这里压了超过 {TARGET} 天。</b>
          {" "}这一格堆积<b>是数据管理自己的欠账</b>，不是中心不回复 ——
          放在同一个「挂起超 7 天」里数，会把账算到中心头上。
        </div>
      )}

      {problem && (
        <div className="problem stack" data-testid="dm-problem" style={{ marginBottom: 12 }}>
          <strong>{problem.title}</strong>
          {problem.detail && <div>{problem.detail}</div>}
        </div>
      )}
      {said && <p className="muted" data-testid="dm-said">{said}</p>}

      {/* ── 发起 ─────────────────────────────────────────────────── */}
      <div className="card stack" data-testid="dm-raise" style={{ marginBottom: 16 }}>
        <div className="spread">
          <h3>发起数据质疑</h3>
          <span className="muted" style={{ fontSize: 13 }}>质疑不该凭空出现 —— 发起人要留名</span>
        </div>
        {!canRaise
          ? <p className="muted" style={{ margin: 0 }} data-testid="dm-cannot-raise">
              你的角色没有 <span className="mono">raiseQ</span> 动作权限，发不了质疑。
            </p>
          : <>
              <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
                <label className="field" style={{ minWidth: 220 }}>
                  <span>受试者</span>
                  <select value={subjectId} data-testid="dm-subject"
                    onChange={e => setSubjectId(e.target.value)}>
                    {subjects.map(s => (
                      <option key={s.id} value={s.id}>
                        {s.screeningNo ?? s.id} · {s.siteCode}
                        {s.crcName ? ` · ${s.crcName}` : "（无责任 CRC）"}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field" style={{ minWidth: 200 }}>
                  <span>表单</span>
                  <select value={form} data-testid="dm-form"
                    onChange={e => setForm(e.target.value)}>
                    {FORMS.map(f => <option key={f}>{f}</option>)}
                  </select>
                </label>
                <label className="field" style={{ minWidth: 180 }}>
                  <span>字段</span>
                  <input value={field} data-testid="dm-field" placeholder="例：起始日期"
                    onChange={e => setField(e.target.value)} />
                </label>
              </div>
              <label className="field">
                <span>质疑内容</span>
                <textarea rows={2} value={text} data-testid="dm-text"
                  placeholder="例：CM 起始日期早于知情同意签署日期，请核实源数据。"
                  onChange={e => setText(e.target.value)} />
              </label>
              <div className="row">
                <button className="btn primary" data-testid="dm-raise-submit"
                  disabled={busy || field.trim().length < 2 || text.trim().length < 10}
                  onClick={() => void raise()}>发起质疑</button>
                <span className="muted" style={{ fontSize: 12 }}>
                  <b>责任 CRC 在这一刻固化</b>，取自受试者 ——
                  此后交接不改写它，否则「这条挂了 21 天是谁的 21 天」没有答案。
                </span>
              </div>
            </>}
      </div>

      {/* ── 待关闭 ───────────────────────────────────────────────── */}
      <div className="card stack" style={{ marginBottom: 16 }}>
        <div className="spread">
          <h3>待关闭 {pending.length}</h3>
          <span className="muted" style={{ fontSize: 13 }}>
            中心已回复 —— <b>回复是否解决了问题，由 DM 判定</b>
          </span>
        </div>
        {pending.length === 0
          ? <p className="muted" style={{ margin: 0 }} data-testid="dm-no-pending">
              没有待判定的回复。
            </p>
          : pending.map(q => (
            <div className="stack" key={q.id} data-testid="dm-pending-row"
              style={{ borderTop: "1px solid var(--line, #e5e5e5)", paddingTop: 10 }}>
              <div className="spread">
                <span className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  <span className="mono muted" style={{ fontSize: 12 }}>{q.code}</span>
                  {q.screeningNo && <span className="mono">{q.screeningNo}</span>}
                  <span className="chip flat">{q.form}</span>
                  <span className="muted" style={{ fontSize: 12 }}>{q.hospital}</span>
                </span>
                <span className={q.ageDays > 7 ? "chip crit" : "chip warn"}>
                  挂起 {q.ageDays} 天
                </span>
              </div>
              <div style={{ fontSize: 13 }}>{q.detail}</div>
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                责任 CRC {q.ownerName ?? "—"}｜字段「{q.fieldName}」
              </p>
              <p style={{ margin: 0, fontSize: 13 }} data-testid="dm-answer">
                <b>中心回复（{q.answeredOn}）：</b>{q.answer}
              </p>
              {canClose && (
                <div className="row">
                  <button className="btn primary" data-testid={`dm-close-${q.id}`}
                    onClick={() => { setJudging({ q, kind: "close" }); setReason(""); setProblem(null); }}>
                    回复合格，关闭
                  </button>
                  <button className="btn" data-testid={`dm-return-${q.id}`}
                    onClick={() => { setJudging({ q, kind: "return" }); setReason(""); setProblem(null); }}>
                    回复不充分，退回
                  </button>
                </div>
              )}
            </div>
          ))}
        {!canClose && pending.length > 0 && (
          <p className="muted" style={{ margin: 0 }} data-testid="dm-cannot-close">
            关闭要 <span className="mono">closeQ</span> —— 你的角色没有它。
            <b>回复了不等于问题解决了</b>，这一步不是给回复的人自己走的。
          </p>
        )}
      </div>

      {judging && (
        <div className="card stack" data-testid="dm-judge-form" style={{ marginBottom: 16 }}>
          <h3>
            {judging.kind === "close" ? "关闭" : "退回"}{" "}
            <span className="mono">{judging.q.code}</span>
          </h3>
          <label className="field">
            <span>{judging.kind === "close" ? "判定说明" : "退回理由"}</span>
            <textarea rows={2} value={reason} data-testid="dm-reason"
              placeholder={judging.kind === "close"
                ? "例：已核对源数据，更正与说明均充分。"
                : "例：回复未提供源数据依据，请附原始病历页码。"}
              onChange={e => setReason(e.target.value)} />
          </label>
          <div className="derive" style={{ margin: 0 }}>
            {judging.kind === "close"
              ? <>关闭之后这条质疑进历史。<b>关闭理由是核查时唯一能看到的判断依据</b> ——
                  写「已处理」等于什么也没写。</>
              : <><b>退回必须说明为什么。</b> 不说理由的退回，
                  是把「凭空」的毛病搬到闭环的另一端 ——
                  CRC 只知道弹回来了，不知道要补什么。</>}
          </div>
          <div className="row">
            <button className="btn primary" data-testid="dm-judge-submit"
              disabled={busy || reason.trim().length < 4} onClick={() => void judge()}>
              {busy ? "…" : "确认"}
            </button>
            <button className="btn" onClick={() => setJudging(null)}>取消</button>
          </div>
        </div>
      )}

      {/* ── 中心分布 ─────────────────────────────────────────────── */}
      <div className="card stack">
        <div className="spread">
          <h3>每例质疑数</h3>
          <span className="muted" style={{ fontSize: 13 }}>
            高不一定是中心差 —— 看它集中在哪几个表单
          </span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>中心</th><th className="num">质疑总数</th><th className="num">入组例数</th>
                <th className="num">每例质疑</th><th className="num">待回复</th>
                <th className="num">平均挂起</th><th>主要表单</th><th>归因</th>
              </tr>
            </thead>
            <tbody>
              {stats.sites.map(s => (
                <tr key={s.studySiteId} data-testid="dm-site-row">
                  <td>
                    <span className="mono">{s.siteCode}</span>
                    <div className="muted" style={{ fontSize: 12 }}>{s.hospital}</div>
                  </td>
                  <td className="num">{s.total}</td>
                  <td className="num">{s.enrolled}</td>
                  <td className="num" data-testid="dm-density"
                    style={s.band === "bad" ? { color: "var(--crit, #c0392b)", fontWeight: 600 }
                      : s.band === "watch" ? { color: "var(--warn, #b8860b)", fontWeight: 600 }
                      : undefined}>
                    {/* **入组 0 例不是 0 条/例。** 显示成 0 会让这个中心
                        在按密度排序时落到最干净的一端 —— 而它只是还没开始录。 */}
                    {s.perSubject === null
                      ? <span className="muted" data-testid="dm-no-density">未入组</span>
                      : s.perSubject.toFixed(2)}
                  </td>
                  <td className="num">{s.open}</td>
                  <td className="num">
                    {s.meanAgeDays === null ? "—" : `${s.meanAgeDays.toFixed(1)} 天`}
                  </td>
                  <td>
                    {s.topForm ?? "—"}
                    {s.topFormShare !== null && (
                      <div className="muted" style={{ fontSize: 12 }}>
                        占 {Math.round(s.topFormShare * 100)}%
                      </div>
                    )}
                  </td>
                  <td style={{ fontSize: 12 }} data-testid="dm-verdict">
                    {VERDICT[s.verdict]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="derive" style={{ margin: 0 }}>
          质疑密度高的中心有两种，<b>要做的事完全相反</b>：
          扎堆在一个表单上是<b>这张表难填</b>（改 eCRF 或培训材料，换一家中心照样出）；
          散在七八个表单上才是<b>这家中心的录入质量</b>（改人）。
          所以这张表把密度和集中度一起给 —— 只给密度，
          「高不一定是中心差」就只是一句免责声明。
          <span className="muted mono" style={{ marginLeft: 8, fontSize: 12 }}>
            口径 {stats.calcVersion}
          </span>
        </div>
      </div>
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
