import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useToast } from "@sitedesk/ui/react";
import { call, ApiError, type ProblemDetails } from "../../api/client.js";

/* ════════════════════════════════════════════════════════════════════
   提醒设置 —— 两个开关，只管自己。

   邮件提醒的内容就是首页待办：紧急的（SAE 时限、今天关窗的访视）到点就发，
   每日摘要工作日早上一封。每一封邮件底下都指到这一页 ——
   退订要比忍着方便，否则人会去把发件人拉黑，连紧急的也一起收不到了。
   ════════════════════════════════════════════════════════════════════ */

interface Prefs { digest: boolean; urgent: boolean; hasEmail: boolean }

export function NotifyPrefsPage() {
  const [p, setP] = useState<Prefs | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const say = useToast();

  useEffect(() => { void call<Prefs>("getNotifyPrefs").then(setP); }, []);

  /* 开关先动、再存：等服务端回来才动的话，点下去那一瞬间像没点中。
     存失败就退回原样，并说出来。 */
  const save = async (next: { digest: boolean; urgent: boolean }) => {
    const before = p;
    setP(x => x && { ...x, ...next });
    setBusy(true); setProblem(null);
    try {
      setP(await call<Prefs>("setNotifyPrefs", { body: next }));
      say("已保存");
    } catch (e) {
      setP(before);
      if (e instanceof ApiError) setProblem(e.problem); else throw e;
    } finally { setBusy(false); }
  };

  if (!p) return <p className="muted">加载中…</p>;

  return (
    <>
      <div className="page-head">
        <Link to="/today" className="muted">← 今天</Link>
        <h2 style={{ marginTop: 6 }}>提醒设置</h2>
        <p>邮件提醒的内容就是你的待办。这里只改你自己的。</p>
      </div>

      <div className="stack" style={{ maxWidth: 560 }}>
        {!p.hasEmail && (
          <div className="problem" data-testid="prefs-no-email">
            <strong>你还没有登记收件邮箱</strong>
            <div>下面两个开关开着也收不到。请管理员在「组织与权限」里给你登记邮箱。</div>
          </div>
        )}
        {problem && <div className="problem"><strong>{problem.title}</strong><div>{problem.detail}</div></div>}

        <label className="card row" style={{ gap: 12, alignItems: "flex-start", cursor: "pointer" }}>
          <input type="checkbox" checked={p.urgent} disabled={busy} data-testid="prefs-urgent"
            style={{ width: "auto", marginTop: 3 }}
            onChange={e => void save({ digest: p.digest, urgent: e.target.checked })} />
          <span>
            <b>紧急提醒</b>
            <div className="muted" style={{ fontSize: 12.5 }}>
              SAE 知悉后 12 小时、20 小时、超过 24 小时各一封；访视窗口最后一天当天一封。
              同一件事同一个时点只发一次。
            </div>
          </span>
        </label>

        <label className="card row" style={{ gap: 12, alignItems: "flex-start", cursor: "pointer" }}>
          <input type="checkbox" checked={p.digest} disabled={busy} data-testid="prefs-digest"
            style={{ width: "auto", marginTop: 3 }}
            onChange={e => void save({ digest: e.target.checked, urgent: p.urgent })} />
          <span>
            <b>每日摘要</b>
            <div className="muted" style={{ fontSize: 12.5 }}>
              工作日早上 8 点后一封：已过期、今天、这几天各几件，最急的十件列出来。
              没有待办的那天不发。
            </div>
          </span>
        </label>
      </div>
    </>
  );
}
