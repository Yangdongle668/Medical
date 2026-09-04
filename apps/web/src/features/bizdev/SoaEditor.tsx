import { useEffect, useState } from "react";
import { useToast } from "@sitedesk/ui/react";
import { call, ApiError, type ProblemDetails } from "../../api/client.js";
import { yuan } from "../cost/money.js";

/* ════════════════════════════════════════════════════════════════════
   访视计划表（SOA）—— 一个项目到底有哪几次访视。

   ── 为什么它此前没有界面 ────────────────────────────────────────
   `getSoa` 与 `replaceSoa` 都在服务端跑着，前端一个都没调。
   于是「这个项目有几次访视、窗口多宽、每次做什么」只有读库才知道 ——
   而 CRC 每天在「今天」那一页上看到的任务清单，正是从这里落下来的。

   ── 改它不影响已排出去的访视 ───────────────────────────────────
   访视在排期那一刻从模板**落成行**（连 visitCode、windowDays 一起抄下来），
   此后与 SOA 无关。所以这一页要说清楚：改完只影响之后才排出来的那些。

   ── 已经排出去的删不掉，锚点也改不了 ────────────────────────────
   删掉它，那些访视就指向了一个不存在的定义 ——
   **报表里它们还在，SOA 上它们不存在**。所以 `scheduledCount > 0` 的
   那几行，这里直接不给删除按钮，并说出原因；锚点那一栏也锁住。
   服务端当然也拦，但让人按下去再被拒，不如一开始就说不能。

   ── 只有第 0 次锚定知情日 ──────────────────────────────────────
   入组之前唯一确定的日期就是知情日。所以 seq 0 的锚点固定是 icf，
   其余固定是 enroll —— 这不是一个可以随便选的下拉。
   ════════════════════════════════════════════════════════════════════ */

interface SoaVisit {
  seq: number; visitCode: string; visitLabel: string;
  anchor: "icf" | "enroll"; offsetDays: number; windowDays: number;
  compensationCents: number; tasks: string[]; scheduledCount: number;
}
interface Soa {
  studyId: string; visits: SoaVisit[];
  lastChangedAt: string | null; lastChangedByName: string | null;
  lastReason: string | null;
}

export function SoaEditor({ studyId, studyCode, canManage, onClose }: {
  studyId: string; studyCode: string; canManage: boolean; onClose: () => void;
}) {
  const [soa, setSoa] = useState<Soa | null>(null);
  const [edit, setEdit] = useState(false);
  const [visits, setVisits] = useState<SoaVisit[]>([]);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const say = useToast();

  useEffect(() => {
    void call<Soa>("getSoa", { params: { id: studyId } })
      .then(setSoa).catch(() => setSoa(null));
  }, [studyId]);

  if (!soa) return (
    <div className="card-b"><p className="muted">加载访视计划表…</p></div>
  );

  const rows = edit ? visits : soa.visits;
  const set = (i: number, patch: Partial<SoaVisit>) =>
    setVisits(v => v.map((x, k) => k === i ? { ...x, ...patch } : x));

  const start = () => {
    setVisits(soa.visits.map(v => ({ ...v, tasks: [...v.tasks] })));
    setReason(""); setProblem(null); setEdit(true);
  };

  const add = () => setVisits(v => {
    const seq = v.length;
    return [...v, {
      seq, visitCode: `V${seq}`, visitLabel: "",
      /* 只有第 0 次锚定知情日 —— 入组之前唯一确定的日期就是它。 */
      anchor: seq === 0 ? "icf" : "enroll",
      offsetDays: seq === 0 ? 0 : 21 * seq, windowDays: 3,
      compensationCents: 0, tasks: [], scheduledCount: 0
    }];
  });

  /* 已经排出去的删不掉。**这里直接不给按钮**，而不是让人按下去再被拒。 */
  const del = (i: number) => setVisits(v =>
    v.filter((_, k) => k !== i).map((x, k) => ({ ...x, seq: k })));

  const ready = visits.length >= 1
    && visits.every(v => v.visitCode.trim() && v.visitLabel.trim())
    && reason.trim().length >= 4;

  async function publish() {
    setBusy(true); setProblem(null);
    try {
      const r = await call<{ data: Soa; sideEffects: { summary: string }[] }>(
        "replaceSoa", {
          params: { id: studyId },
          body: {
            visits: visits.map((v, k) => ({
              seq: k, visitCode: v.visitCode.trim(), visitLabel: v.visitLabel.trim(),
              anchor: k === 0 ? "icf" : "enroll",
              offsetDays: v.offsetDays, windowDays: v.windowDays,
              compensationCents: v.compensationCents,
              tasks: v.tasks.filter(t => t.trim()).map(t => t.trim())
            })),
            reason: reason.trim()
          }
        });
      setSoa(r.data); setEdit(false);
      say(r.sideEffects[0]?.summary ?? `${studyCode} 的访视计划表已修订`);
    } catch (e) {
      if (e instanceof ApiError) setProblem(e.problem); else throw e;
    } finally { setBusy(false); }
  }

  const locked = rows.filter(v => v.scheduledCount > 0).length;

  return (
    <div className="card-b stack" data-testid="soa-editor">
      <div className="spread">
        <b>访视计划表 · {rows.length} 次访视</b>
        <span className="row" style={{ gap: 8 }}>
          {canManage && (edit
            ? <button className="btn link" data-testid="soa-cancel"
                onClick={() => { setEdit(false); setProblem(null); }}>取消</button>
            : <button className="btn" data-testid="soa-edit" onClick={start}>修订</button>)}
          <button className="btn link" onClick={onClose}>收起</button>
        </span>
      </div>

      {soa.lastReason && !edit && (
        <p className="note" style={{ margin: 0 }} data-testid="soa-last">
          上次修订：{soa.lastReason}
          {soa.lastChangedByName && <>（{soa.lastChangedByName} · {soa.lastChangedAt?.slice(0, 10)}）</>}
        </p>
      )}

      <div className="derive" data-testid="soa-scope">
        <b>改它不影响已排出去的访视。</b>
        访视在排期那一刻从模板落成行（连 visitCode、windowDays 一起抄下来），
        此后与 SOA 无关 —— 所以改完只影响之后才排出来的那些。
        {locked > 0 && <>
          <br />
          其中 <b>{locked}</b> 次已经按它排出过访视：<b>删不掉，锚点也改不了</b> ——
          删掉它，那些访视就指向了一个不存在的定义，
          <b>报表里它们还在，SOA 上它们不存在</b>。
        </>}
      </div>

      {problem && (
        <div className="problem" data-testid="soa-problem">
          <strong>{problem.title}</strong>
          {problem.detail && <div>{problem.detail}</div>}
        </div>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th><th>代号</th><th>名称</th><th>锚点</th>
              <th className="ta-r">偏移</th><th className="ta-r">窗口</th>
              <th className="ta-r">补偿</th><th className="ta-r">已排</th>
              {edit && <th />}
            </tr>
          </thead>
          <tbody>
            {rows.map((v, k) => (
              <tr key={k} data-testid="soa-row">
                <td className="mono">{k}</td>
                <td>
                  {edit
                    ? <input value={v.visitCode} style={{ width: 80 }}
                        data-testid={`soa-code-${k}`} aria-label={`第 ${k} 次代号`}
                        onChange={e => set(k, { visitCode: e.target.value })} />
                    : <span className="mono">{v.visitCode}</span>}
                </td>
                <td>
                  {edit
                    ? <input value={v.visitLabel} data-testid={`soa-label-${k}`}
                        aria-label={`第 ${k} 次名称`}
                        onChange={e => set(k, { visitLabel: e.target.value })} />
                    : v.visitLabel}
                </td>
                <td>
                  {/* 锚点不是下拉：只有第 0 次锚知情日，其余锚入组日。 */}
                  <span className="chip flat">{k === 0 ? "知情日" : "入组日"}</span>
                </td>
                <td className="tnum">
                  {edit
                    ? <input type="number" value={v.offsetDays} style={{ width: 78 }}
                        data-testid={`soa-offset-${k}`} aria-label={`第 ${k} 次偏移天数`}
                        onChange={e => set(k, { offsetDays: Number(e.target.value) })} />
                    : <>{v.offsetDays > 0 ? "+" : ""}{v.offsetDays} 天</>}
                </td>
                <td className="tnum">
                  {edit
                    ? <input type="number" value={v.windowDays} style={{ width: 68 }}
                        data-testid={`soa-window-${k}`} aria-label={`第 ${k} 次窗口天数`}
                        onChange={e => set(k, { windowDays: Number(e.target.value) })} />
                    : <>±{v.windowDays} 天</>}
                </td>
                <td className="tnum">{yuan(v.compensationCents)}</td>
                <td className="tnum">
                  {v.scheduledCount > 0
                    ? <span className="chip warn" data-testid={`soa-locked-${k}`}>
                        {v.scheduledCount} 次
                      </span>
                    : <span className="t-mut">—</span>}
                </td>
                {edit && (
                  <td>
                    {v.scheduledCount > 0
                      ? <span className="t-mut" title="已经按它排出过访视，删不掉">锁定</span>
                      : <button className="btn link" data-testid={`soa-del-${k}`}
                          onClick={() => del(k)}>删除</button>}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {edit && (
        <>
          <div className="row">
            <button className="btn" data-testid="soa-add" onClick={add}>加一次访视</button>
            <span className="note">
              改 SOA 对应的是<b>一次方案修订</b> —— 前后快照进变更史。
            </span>
          </div>

          <label className="field">
            <span>修订原因 <span className="t-mut">· 至少 4 字，进变更史</span></span>
            <textarea rows={2} value={reason} data-testid="soa-reason"
              placeholder="例：方案 v3.0 修订，C3D1 起增加骨扫描，末次随访由 M6 延至 M12。"
              onChange={e => setReason(e.target.value)} />
          </label>

          <div className="row">
            <button className="btn btn-p" data-testid="soa-publish"
              disabled={!ready || busy} onClick={() => void publish()}>
              {busy ? "提交中…" : "提交修订"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
