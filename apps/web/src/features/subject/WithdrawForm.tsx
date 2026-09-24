import { useState, type CSSProperties } from "react";
import { WITHDRAW_REASONS } from "@sitedesk/contracts";
import { call, ApiError, type ProblemDetails } from "../../api/client.js";
import { WITHDRAW_LABEL } from "../enrollment/api.js";
import type { Subject } from "./api.js";

/* 登记脱落 —— 受试者列表与受试者详情两处共用这一份表单。
   两处各写一份的话，「按下去之前说清两个后果」那一段迟早只剩一处有。 */
export function WithdrawForm({ subject, onCancel, onDone, style }: {
  subject: Subject;
  onCancel: () => void;
  /** 成功后给一句回执（取自服务端的 sideEffects）。 */
  onDone: (summary: string) => void;
  style?: CSSProperties;
}) {
  const [reason, setReason] = useState("");
  const [on, setOn] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);

  const withdraw = async () => {
    setBusy(true); setProblem(null);
    try {
      const r = await call<{ sideEffects: { summary: string }[] }>("withdrawSubject", {
        params: { id: subject.id },
        body: { reason, withdrawnOn: on, note: note.trim() }
      });
      onDone(r.sideEffects[0]?.summary ?? "已登记脱落");
    } catch (e) {
      if (e instanceof ApiError) setProblem(e.problem); else throw e;
    } finally { setBusy(false); }
  };

  /* 这一步有两个不显形的后果，都要在按下去之前说出来：
     ① 收入按**已完成访视比例**计，不按整例；
     ② 剩余未完成的访视**一并作废** —— 不作废的话，
        这一例会永远刷红超窗，而超窗每天都在往方案偏离上走。 */
  return (
        <section className="card" data-testid="wd-form" style={style ?? { marginTop: 18 }}>
          <div className="card-h">
            <h3>登记脱落</h3>
            <span className="sub">
              {subject.screeningNo ?? "受试者"} · {subject.siteCode} ·
              已完成 {subject.visitsDone}/{subject.visitsPlanned} 次访视
            </span>
            <span className="sp" />
            <button className="btn link" onClick={onCancel}>取消</button>
          </div>
          <div className="card-b stack">
            {problem && (
              <div className="problem" data-testid="wd-problem">
                <strong>{problem.title}</strong>
                {problem.detail && <div>{problem.detail}</div>}
              </div>
            )}
            <div className="grid-form">
              <label className="field">
                <span>脱落原因</span>
                <select value={reason} data-testid="wd-reason"
                  onChange={e => setReason(e.target.value)}>
                  <option value="">— 选一个 —</option>
                  {WITHDRAW_REASONS.map(r => (
                    <option key={r} value={r}>{WITHDRAW_LABEL[r] ?? r}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>脱落日期</span>
                <input type="date" value={on} data-testid="wd-date"
                  onChange={e => setOn(e.target.value)} />
              </label>
            </div>
            <label className="field">
              <span>说明 <span className="t-mut">· 至少 4 字</span></span>
              <textarea rows={2} value={note} data-testid="wd-note"
                placeholder="例：受试者第 3 周期出现 III 度肝损伤，研究者判断需终止治疗，已完成末次安全性随访。"
                onChange={e => setNote(e.target.value)} />
            </label>
            <div className="derive" data-testid="wd-consequence">
              <b>这一下有两个后果，都不显形：</b>
              <br />
              ① 这一例的收入按<b>已完成访视比例</b>计 ——
              {subject.visitsPlanned > 0 && <>
                {" "}也就是 {subject.visitsDone}/{subject.visitsPlanned}，
                不是整例。
              </>}
              <br />
              ② 剩余 <b>{Math.max(0, subject.visitsPlanned - subject.visitsDone)}</b> 次
              未完成的访视<b>一并作废</b> —— 不作废的话，
              这一例会永远刷红超窗，而超窗每天都在往方案偏离上走。
            </div>
            <div className="row">
              <button className="btn btn-p" data-testid="wd-submit"
                disabled={busy || !reason || !on || note.trim().length < 4}
                onClick={() => void withdraw()}>
                {busy ? "登记中…" : "登记脱落"}
              </button>
            </div>
          </div>
        </section>
  );
}
