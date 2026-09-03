import { useEffect, useState } from "react";
import { ApiError, type ProblemDetails } from "../../api/client.js";
import { call } from "../../api/client.js";
import {
  listSubjects, createSubject, signIcf, screenFail, enroll,
  STATE_LABEL, anonymous, today, type Subject
} from "./api.js";
import { SCREEN_FAIL_LABEL } from "../enrollment/api.js";

/* ════════════════════════════════════════════════════════════════════
   预筛登记。

   ── 这一页管的是漏斗最上面那两格 ──────────────────────────────────
       登记预筛 → 签知情（进筛选期）→ 入组 / 筛败

   为什么值得单独一页：**预筛量不足和筛败率过高是两个完全不同的问题**
   （见「筛选漏斗与筛败」）。而要分得出来，前提是预筛这一格真的有人记 ——
   只在入组那一刻才建档的话，漏斗最上面两格永远是空的，
   于是"入组慢"就只剩一种解释。

   ── 三个动作的顺序不是界面定的，是库定的 ──────────────────────────
   · 签知情日**不能早于中心的伦理批件日** —— 批件之前签的知情是严重违背；
   · 入组要求筛选期访视已由 PI 确认锁定 —— 入排标准没人签字就随机化，
     是核查必查的一条。
   前端不重复判定这两条：点下去，让后端说不行，并把它说的话原样摆出来。
   两边各判一次，迟早长出分歧，而界面那一份总是更宽松的那个。
   ════════════════════════════════════════════════════════════════════ */

interface Site { id: string; code: string; hospital: string }

export function PrescreenPage() {
  const [sites, setSites] = useState<Site[]>([]);
  const [subs, setSubs] = useState<Subject[] | null>(null);
  const [siteId, setSiteId] = useState("");
  const [no, setNo] = useState("");
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [acting, setActing] = useState<{ id: string; kind: "icf" | "fail" | "enroll" } | null>(null);

  const reload = () => listSubjects({ state: ["prescreen", "screening"] })
    .then(r => setSubs(r.items));

  useEffect(() => {
    void (async () => {
      const s = await call<{ items: Site[] }>("listStudySites", { query: { limit: 200 } });
      setSites(s.items);
      if (s.items.length === 1) setSiteId(s.items[0]!.id);
      await reload();
    })();
  }, []);

  const run = async (what: string, fn: () => Promise<unknown>) => {
    setProblem(null); setSaid(null);
    try { await fn(); await reload(); setSaid(what); setActing(null); }
    catch (e) { if (e instanceof ApiError) setProblem(e.problem); else throw e; }
  };

  if (!subs) return <p className="muted">加载中…</p>;

  const masked = subs.length > 0 && subs.every(anonymous);
  const prescreen = subs.filter(s => s.state === "prescreen");
  const screening = subs.filter(s => s.state === "screening");

  return (
    <>
      <div className="page-head">
        <h2>预筛登记</h2>
        <p>
          漏斗最上面两格：登记预筛 → 签知情（进筛选期）→ 入组 / 筛败。
          <b>不记预筛，"入组慢"就只剩一种解释。</b>
        </p>
      </div>

      <div className="stats" style={{ marginBottom: 14 }}>
        <Stat label="待签知情" v={prescreen.length} note="已登记预筛，还没签 ICF" />
        <Stat label="筛选中" v={screening.length} note="已签知情，等入组或筛败结论" />
      </div>

      <div className="card stack" style={{ marginBottom: 12 }}>
        <div className="spread">
          <h3>登记一位预筛受试者</h3>
          <span className="muted">此刻只有筛选号 —— 签知情之后才生成筛选期访视</span>
        </div>
        <div className="grid-form">
          <label className="field"><span>中心</span>
            <select value={siteId} data-testid="pre-site" onChange={e => setSiteId(e.target.value)}>
              <option value="">— 选一个 —</option>
              {sites.map(s => <option key={s.id} value={s.id}>{s.code} · {s.hospital}</option>)}
            </select></label>
          <label className="field"><span>筛选号</span>
            <input value={no} data-testid="pre-no" className="mono"
              onChange={e => setNo(e.target.value)} placeholder="例：SS-01-P042" /></label>
        </div>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button className="btn primary" data-testid="pre-create"
            disabled={!siteId || !no.trim()}
            onClick={() => void run(`已登记 ${no.trim()}`, async () => {
              await createSubject(siteId, no.trim());
              setNo("");
            })}>
            登记
          </button>
        </div>
      </div>

      {problem && (
        <div className="problem stack" data-testid="pre-problem" style={{ marginBottom: 12 }}>
          <strong>{problem.title}</strong>
          {problem.detail && <div>{problem.detail}</div>}
          {Array.isArray(problem.unmet) && (
            <ul className="unmet">
              {(problem.unmet as { message: string }[]).map((u, i) => <li key={i}>{u.message}</li>)}
            </ul>
          )}
        </div>
      )}
      {said && <p className="muted" data-testid="pre-said">{said}</p>}

      {masked && (
        <div className="problem" data-testid="pre-masked" style={{ marginBottom: 12 }}>
          你的角色看不到筛选号 —— 这一页对你没有可操作的内容。
        </div>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {!masked && <th>筛选号</th>}
              <th>中心</th><th>状态</th><th>知情签署日</th><th>下一步</th>
            </tr>
          </thead>
          <tbody>
            {subs.map(s => (
              <tr key={s.id} data-testid="pre-row">
                {!masked && <td className="mono">{s.screeningNo ?? "—"}</td>}
                <td className="mono">{s.siteCode}</td>
                <td>
                  <span className={`chip ${s.state === "screening" ? "warn" : "flat"}`}>
                    {STATE_LABEL[s.state] ?? s.state}
                  </span>
                </td>
                <td className="mono muted">{s.icfSignedOn ?? "—"}</td>
                <td>
                  <div className="row" style={{ gap: 4 }}>
                    {s.state === "prescreen" && (
                      <button className="btn" data-testid={`icf-${s.id}`}
                        onClick={() => setActing({ id: s.id, kind: "icf" })}>签知情</button>
                    )}
                    {s.state === "screening" && <>
                      <button className="btn primary" data-testid={`enroll-${s.id}`}
                        onClick={() => setActing({ id: s.id, kind: "enroll" })}>入组</button>
                      <button className="btn" data-testid={`fail-${s.id}`}
                        onClick={() => setActing({ id: s.id, kind: "fail" })}>筛败</button>
                    </>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {acting?.kind === "icf" && (
        <DateForm title="登记知情同意签署" testid="icf-form" label="签署日"
          hint="**不能晚于今天，也不能早于中心的伦理批件日** —— 批件之前签的知情是严重违背。这两条由库判，不由这张表单判。"
          onCancel={() => setActing(null)}
          onGo={d => void run("已登记知情签署，筛选期访视已按 SOA 生成",
            () => signIcf(acting.id, d))} />
      )}

      {acting?.kind === "enroll" && (
        <EnrollForm onCancel={() => setActing(null)}
          onGo={(no, d) => void run("已入组", () => enroll(acting.id, no, d))} />
      )}

      {acting?.kind === "fail" && (
        <FailForm onCancel={() => setActing(null)}
          onGo={(reason, d, note) => void run("已登记筛败 —— 它按 I8′ 计入收入",
            () => screenFail(acting.id, reason, d, note))} />
      )}

      <div className="derive" style={{ marginTop: 14 }}>
        <b>筛败不是失败，是收入。</b> 筛败例数 × 单价 × 筛败费率计入收入（I8′）——
        不记录筛败，会把本来赚钱的高筛败中心算成亏损。
        所以原因是受控取值，不是自由文本：自由文本统计不出
        「入排标准与病源不匹配」这件事。
        <br />
        签知情日与入组的两条前置由<b>数据库</b>判，这张表单不重复判 ——
        两边各判一次，迟早长出分歧，而界面那一份总是更宽松的那个。
      </div>
    </>
  );
}

function Stat({ label, v, note }: { label: string; v: number; note: string }) {
  return (
    <div className="stat">
      <div className="stat-l">{label}</div>
      <div className="stat-v">{v}</div>
      <div className="stat-n">{note}</div>
    </div>
  );
}

function DateForm({ title, testid, label, hint, onCancel, onGo }: {
  title: string; testid: string; label: string; hint: string;
  onCancel: () => void; onGo: (d: string) => void;
}) {
  const [d, setD] = useState(today());
  return (
    <div className="card stack" data-testid={testid} style={{ marginTop: 12 }}>
      <div className="spread"><h3>{title}</h3>
        <button className="btn" onClick={onCancel}>取消</button></div>
      <p className="muted" style={{ margin: 0 }}>{hint}</p>
      <label className="field" style={{ maxWidth: 220 }}><span>{label}</span>
        <input type="date" value={d} data-testid={`${testid}-date`}
          onChange={e => setD(e.target.value)} /></label>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn primary" data-testid={`${testid}-go`}
          disabled={!d} onClick={() => onGo(d)}>确认</button>
      </div>
    </div>
  );
}

function EnrollForm({ onCancel, onGo }:
  { onCancel: () => void; onGo: (no: string, d: string) => void }) {
  const [no, setNo] = useState("");
  const [d, setD] = useState(today());
  return (
    <div className="card stack" data-testid="enroll-form" style={{ marginTop: 12 }}>
      <div className="spread"><h3>入组（随机化）</h3>
        <button className="btn" onClick={onCancel}>取消</button></div>
      <p className="muted" style={{ margin: 0 }}>
        筛选期访视必须已由 PI 确认锁定才入组 ——
        入排标准还没人签字就随机化，是核查必查的一条。没锁的话下面这一下会被挡回来。
      </p>
      <div className="grid-form">
        <label className="field"><span>随机号</span>
          <input value={no} data-testid="enroll-no" className="mono"
            onChange={e => setNo(e.target.value)} placeholder="例：R-0142" /></label>
        <label className="field"><span>入组日</span>
          <input type="date" value={d} data-testid="enroll-date"
            onChange={e => setD(e.target.value)} /></label>
      </div>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn primary" data-testid="enroll-go"
          disabled={!no.trim() || !d} onClick={() => onGo(no.trim(), d)}>确认入组</button>
      </div>
    </div>
  );
}

function FailForm({ onCancel, onGo }:
  { onCancel: () => void; onGo: (reason: string, d: string, note?: string) => void }) {
  const [reason, setReason] = useState("");
  const [d, setD] = useState(today());
  const [note, setNote] = useState("");
  return (
    <div className="card stack" data-testid="fail-form" style={{ marginTop: 12 }}>
      <div className="spread"><h3>登记筛败</h3>
        <button className="btn" onClick={onCancel}>取消</button></div>
      <p className="muted" style={{ margin: 0 }}>
        <b>筛败不是失败，是收入</b>（I8′）。原因是受控取值 ——
        自由文本统计不出「入排标准与病源不匹配」。
      </p>
      <div className="grid-form">
        <label className="field"><span>原因</span>
          <select value={reason} data-testid="fail-reason" onChange={e => setReason(e.target.value)}>
            <option value="">— 选一个 —</option>
            {Object.entries(SCREEN_FAIL_LABEL).map(([k, v]) =>
              <option key={k} value={k}>{v}</option>)}
          </select></label>
        <label className="field"><span>筛败日</span>
          <input type="date" value={d} data-testid="fail-date"
            onChange={e => setD(e.target.value)} /></label>
      </div>
      <label className="field"><span>补充说明（可选）</span>
        <textarea rows={2} value={note} data-testid="fail-note"
          onChange={e => setNote(e.target.value)}
          placeholder="例：ECOG 2 分，方案要求 0–1" /></label>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn primary" data-testid="fail-go"
          disabled={!reason || !d}
          onClick={() => onGo(reason, d, note.trim() || undefined)}>确认筛败</button>
      </div>
    </div>
  );
}
