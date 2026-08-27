import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { requestLink, redeem, devLogin, passwordLogin } from "./session.js";
import { ApiError } from "../../api/client.js";

/* 登录有两条路径，各有各的用处，谁也不是谁的备份：

   ① **一次性链接** —— 面向机构老师与 PI 这类一周登录两次的人。
      15 分钟有效、只能用一次、兑换在数据库里原子完成。

   ② **口令** —— 面向内部账号，尤其是**出厂管理员**。
      它存在的理由很窄：一次干净部署跑完，库里零个账号，
      而建账号要求调用方先登录 —— 装完了没人打得开门。
      口令是那把开机的钥匙（见迁移 0025 / 0026）。

   界面上链接在前、口令折叠在后，是因为对大多数人来说前者才是常态；
   反过来摆的话，人人都会去设一个密码，而那正是当初不做密码的原因。

   开发登录是另一条，且刻意不进公开契约：它只在后端
   SITEDESK_DEV_LOGIN=1 时存在，生产环境直接 404。

   ── 为什么这个页面必须认 `?token=` ──────────────────────────────────
   发出去的链接长这样：`https://台/login?token=…`。用户点开就落在这里。
   在此之前这个页面**只认自己刚要来的那个令牌**（开发环境回显的那个）——
   于是真正从邮件点进来的人，看到的是一张空白的登录表单，什么也没发生。
   开发环境永远正常，因为开发环境根本不走链接。
   一键部署之后没有开发登录，这条路径就是唯一的入口，所以它必须成立。 */

const DEV_LOGINS = [
  { login: "wutong", who: "吴桐 · CRC" },
  { login: "linmin", who: "林敏 · CRA" },
  { login: "lingyuan", who: "凌远 · 经营层" },
  { login: "chenguod", who: "陈国栋 · PI（外部）" },
  { login: "zhanghm", who: "张慧敏 · 机构办（外部）" }
];

export function LoginPage() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [login, setLogin] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [devToken, setDevToken] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /* 「这条链接不能用了」和「你还没申请过链接」是两回事，页面上要分得开。 */
  const [linkDead, setLinkDead] = useState(false);
  const [pwLogin, setPwLogin] = useState("");
  const [pw, setPw] = useState("");

  const doPasswordLogin = () => go(async () => {
    await passwordLogin(pwLogin.trim(), pw);
    /* **口令留在 state 里没有好处。** 清掉再跳 —— 跳转失败时页面还在，
       而一个填着口令的表单会一直躺在那里等着被下一个人看到。 */
    setPw("");
    nav("/today", { replace: true });
  });

  async function go(fn: () => Promise<unknown>) {
    setBusy(true); setErr(null);
    try { await fn(); }
    catch (e) { setErr(e instanceof ApiError ? (e.problem.detail ?? e.problem.title) : String(e)); }
    finally { setBusy(false); }
  }

  /* 从链接进来：直接兑换。
     兑换成功就 replace 掉这条历史记录 —— 令牌虽然一次性，
     但把它留在地址栏和浏览历史里没有任何好处（还会随 Referer 外泄）。
     失败也要把它从 URL 上摘掉，否则用户一刷新就再撞一次同一个死令牌，
     看到的还是同一句"已过期"，会以为是系统坏了。

     用 ref 挡住重复执行：StrictMode 下 effect 会跑两遍，
     而令牌是**一次性**的 —— 第一次兑换成功，第二次必然失败，
     于是明明登进去了却弹一句"链接无效"。这个坑只在开发构建里出现，
     正好是最容易被当成偶发问题放过去的那种。 */
  const redeeming = useRef(false);
  useEffect(() => {
    const t = params.get("token");
    if (!t || redeeming.current) return;
    redeeming.current = true;
    void go(async () => {
      try { await redeem(t); nav("/today", { replace: true }); }
      catch (e) { setLinkDead(true); nav("/login", { replace: true }); throw e; }
    });
    /* 只看首次进入时地址栏上的那个令牌 */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ maxWidth: 420, margin: "12vh auto", padding: "0 20px" }}>
      <h1 style={{ fontSize: 20, marginBottom: 6 }}>临床中心台</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        常规入口是一次性链接 —— 不必记密码，也就没有写在便利贴上的密码。
        内部账号也可以用口令登录（下面那一栏）。
      </p>

      {/* 从一条已经失效的链接进来时的引导。
          在此之前这里只有一句服务端原话（"链接无效、已过期或已被使用"），
          没有下一步 —— 而链接是生产环境唯一的入口，
          一个走到死胡同的人除了关掉页面没有别的事可做。 */}
      {linkDead && (
        <div className="problem stack" data-testid="link-expired" style={{ marginTop: 18 }}>
          <strong>这条链接已经不能用了</strong>
          <p className="muted" style={{ margin: 0 }}>
            一次性链接 15 分钟有效、而且只能用一次 —— 已经点开过、或者放久了，
            都会走到这里。<b>在下面填你的登录名，重新要一条。</b>
          </p>
        </div>
      )}

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
            setLinkDead(false);
            setDevToken(r.devToken ?? null);
          })}>
          {linkDead ? "重新发一条登录链接" : "发送登录链接"}
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

      <details style={{ marginTop: 16 }} data-testid="password-panel">
        <summary className="muted" style={{ cursor: "pointer" }}>用口令登录</summary>
        <div className="card stack" style={{ marginTop: 10 }}>
          <p className="muted" style={{ margin: 0 }}>
            内部账号可以设口令。出厂管理员是 <b className="mono">admin</b>，
            初始口令也是 <b className="mono">admin</b> —— <b>登进去第一件事就是改掉它</b>。
          </p>
          <label className="field">
            <span>登录名</span>
            <input value={pwLogin} data-testid="pw-login" autoComplete="username"
              onChange={e => setPwLogin(e.target.value)} placeholder="admin" />
          </label>
          <label className="field">
            <span>口令</span>
            <input type="password" value={pw} data-testid="pw-password"
              autoComplete="current-password"
              onChange={e => setPw(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && pwLogin.trim() && pw) void doPasswordLogin(); }} />
          </label>
          <button className="btn primary" data-testid="pw-submit"
            disabled={busy || !pwLogin.trim() || !pw}
            onClick={() => void doPasswordLogin()}>
            登录
          </button>
        </div>
      </details>

      <details style={{ marginTop: 16 }} data-testid="dev-panel">
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
