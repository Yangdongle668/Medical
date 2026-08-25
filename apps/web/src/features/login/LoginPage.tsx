import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { requestLink, redeem, devLogin } from "./session.js";
import { ApiError } from "../../api/client.js";

/* 登录只有一条路径：**一次性链接**。没有密码，也就没有「密码写在便利贴上」。
   链接 15 分钟有效、只能用一次、兑换在数据库里原子完成。

   开发登录是另一条，且刻意不进公开契约：它只在后端
   SITEDESK_DEV_LOGIN=1 时存在，生产环境直接 404。 */

const DEV_LOGINS = [
  { login: "wutong", who: "吴桐 · CRC" },
  { login: "linmin", who: "林敏 · CRA" },
  { login: "lingyuan", who: "凌远 · 经营层" },
  { login: "chenguod", who: "陈国栋 · PI（外部）" },
  { login: "zhanghm", who: "张慧敏 · 机构办（外部）" }
];

export function LoginPage() {
  const nav = useNavigate();
  const [login, setLogin] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [devToken, setDevToken] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function go(fn: () => Promise<unknown>) {
    setBusy(true); setErr(null);
    try { await fn(); }
    catch (e) { setErr(e instanceof ApiError ? (e.problem.detail ?? e.problem.title) : String(e)); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ maxWidth: 420, margin: "12vh auto", padding: "0 20px" }}>
      <h1 style={{ fontSize: 20, marginBottom: 6 }}>临床中心台</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        登录只用一次性链接 —— 没有密码，也就没有写在便利贴上的密码。
      </p>

      <div className="card stack" style={{ marginTop: 18 }}>
        <label className="field">
          <span>登录名</span>
          <input value={login} data-testid="login-input" autoComplete="username"
            onChange={e => setLogin(e.target.value)} placeholder="例如 wutong" />
        </label>
        <button className="btn primary" data-testid="request-link"
          disabled={busy || !login.trim()}
          onClick={() => void go(async () => {
            const r = await requestLink(login.trim());
            setSent(r.message);
            setDevToken(r.devToken ?? null);
          })}>
          发送登录链接
        </button>

        {sent && <p className="muted" data-testid="link-sent">{sent}</p>}

        {devToken && (
          <div className="stack">
            <p className="muted">
              开发环境回显了链接令牌（生产环境**不会**回显，它只走邮件/短信）：
            </p>
            <button className="btn" data-testid="redeem"
              onClick={() => void go(async () => { await redeem(devToken); nav("/today"); })}>
              用这个令牌登录
            </button>
          </div>
        )}
      </div>

      <details style={{ marginTop: 16 }}>
        <summary className="muted" style={{ cursor: "pointer" }}>开发登录（生产不存在）</summary>
        <div className="stack" style={{ marginTop: 10 }}>
          {DEV_LOGINS.map(d => (
            <button key={d.login} className="btn" data-testid={`dev-${d.login}`}
              disabled={busy}
              onClick={() => void go(async () => { await devLogin(d.login); nav("/today"); })}>
              {d.who}
            </button>
          ))}
        </div>
      </details>

      {err && <div className="problem" data-testid="login-error" style={{ marginTop: 14 }}>{err}</div>}
    </div>
  );
}
