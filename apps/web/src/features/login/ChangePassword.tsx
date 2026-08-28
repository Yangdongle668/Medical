import { useState } from "react";
import { changePassword } from "./session.js";
import { ApiError } from "../../api/client.js";

/* ════════════════════════════════════════════════════════════════════
   改口令。

   它有两个入口，长得一样但心情不同：
     · 顶上那条红条（还在用出厂口令）—— 这是**警报**，不能被折叠掉；
     · 「组织与权限」页里的一块 —— 这是日常。

   所以组件只管表单，"要不要吼"由调用方决定。
   ════════════════════════════════════════════════════════════════════ */

export function ChangePassword(
  { hasPassword, onDone }: { hasPassword: boolean; onDone?: () => void }
) {
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  /* 两次不一致在**本地**就拦下来。送到服务端去拦的话，
     服务端得知道"第二遍"这个概念 —— 而那是个纯界面概念，
     后端多一个它不该有的字段，还得决定不一致时算 400 还是 422。 */
  const mismatch = again.length > 0 && next !== again;

  async function submit() {
    setBusy(true); setErr(null);
    try {
      await changePassword(cur, next);
      /* 明文一件不留。这一步很容易忘 —— 忘了的话，
         改完密码的那个表单还在内存里拿着新旧两个口令。 */
      setCur(""); setNext(""); setAgain(""); setOk(true);
      onDone?.();
    } catch (e) {
      setErr(e instanceof ApiError ? (e.problem.detail ?? e.problem.title) : String(e));
    } finally { setBusy(false); }
  }

  if (ok) return (
    <p className="muted" data-testid="pw-changed">
      口令已更新，其余会话已全部断开 —— 当前这一个还在，不必重新登录。
    </p>
  );

  return (
    <div className="stack">
      {hasPassword && (
        <label className="field">
          <span>当前口令</span>
          <input type="password" value={cur} data-testid="cur-password"
            autoComplete="current-password" onChange={e => setCur(e.target.value)} />
        </label>
      )}
      <label className="field">
        <span>新口令（至少 8 位）</span>
        <input type="password" value={next} data-testid="new-password"
          autoComplete="new-password" onChange={e => setNext(e.target.value)} />
      </label>
      <label className="field">
        <span>再打一遍</span>
        <input type="password" value={again} data-testid="new-password-again"
          autoComplete="new-password" onChange={e => setAgain(e.target.value)} />
        {mismatch && <span className="muted" data-testid="pw-mismatch">两次输入不一样</span>}
      </label>
      <button className="btn primary" data-testid="change-password"
        disabled={busy || next.length < 8 || mismatch || next !== again || (hasPassword && !cur)}
        onClick={() => void submit()}>
        更新口令
      </button>
      {err && <div className="problem" data-testid="pw-error">{err}</div>}
    </div>
  );
}
