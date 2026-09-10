import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { requestLink, redeem, devLogin, passwordLogin } from "./session.js";
import { ApiError } from "../../api/client.js";
import { IS_DEMO } from "../../shell/env.js";

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
   一键部署之后没有开发登录，这条路径就是唯一的入口，所以它必须成立。

   ══════════════════════════════════════════════════════════════════
   ── 一个页面，两张脸 ───────────────────────────────────────────────
   演示台与生产台**不共用同一张登录页**（判据见 shell/env.ts）：

     · 生产：左边一面深色品牌墙 + 右边表单。信任感来自克制 ——
       一句定位、三条事实，没有一句营销话。这一屏要让人觉得
       "这是一套有人在维护的系统"，而不是"这是某人搭的后台"。
     · 演示：单栏居中 + 顶上一条**说清是演示**的横幅 + 身份直选。
       演示台的主操作本来就是"换个人看看"，所以它是第一位的内容，
       不该像生产台那样折叠在"另一条路"里。

   两边共用字体、控件、色板、品牌标记 —— 它们是同一个产品，
   只是**回答的问题不同**：一个问"你是谁"，一个问"你想以谁的身份看"。
   ══════════════════════════════════════════════════════════════════ */

const DEV_LOGINS = [
  { login: "wutong", who: "吴桐", role: "CRC · 现场" },
  { login: "linmin", who: "林敏", role: "CRA · 监查" },
  { login: "lingyuan", who: "凌远", role: "经营层" },
  { login: "chenguod", who: "陈国栋", role: "PI · 外部" },
  { login: "zhanghm", who: "张慧敏", role: "机构办 · 外部" }
];

/** 品牌区。侧栏与登录页同一块 —— 登进来那一刻不该有"换了个系统"的感觉。 */
function Brand() {
  return (
    <div className="login-brand">
      <span className="brand-mark" aria-hidden="true">台</span>
      <div>
        <span className="brand-name">临床中心台</span>
        <span className="brand-sub">SiteDesk</span>
      </div>
    </div>
  );
}

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

  /* ── 两边共用的那张表单 ─────────────────────────────────────────
     一次性链接在前、口令折叠在后。演示台上这一块整体退到身份直选之后，
     但**不删掉** —— 演示台也要能演示真正的登录流程。 */
  const form = (
    <>
      {linkDead && (
        <div className="login-err" data-testid="link-expired">
          <strong>这条链接已经不能用了</strong>
          <div>
            一次性链接 15 分钟有效、而且只能用一次 —— 已经点开过、或者放久了，
            都会走到这里。<b>在下面填你的登录名，重新要一条。</b>
          </div>
        </div>
      )}

      <div className="stack" style={{ gap: 14 }}>
        <label className="field">
          <span>登录名</span>
          <input value={login} data-testid="login-input" autoComplete="username"
            onChange={e => setLogin(e.target.value)} placeholder="例如 wutong" />
        </label>
        <button className="btn btn-p login-go" data-testid="request-link"
          disabled={busy || !login.trim()} aria-busy={busy || undefined}
          onClick={() => void go(async () => {
            const r = await requestLink(login.trim());
            setSent(r.message);
            setLinkDead(false);
            setDevToken(r.devToken ?? null);
          })}>
          {linkDead ? "重新发一条登录链接" : "发送登录链接"}
        </button>

        {sent && <p className="note" data-testid="link-sent" style={{ margin: 0 }}>{sent}</p>}

        {devToken && (
          <div className="stack" style={{ gap: 10 }}>
            <p className="note" style={{ margin: 0 }}>
              开发环境回显了链接令牌（生产环境<b>不会</b>回显，它只走邮件 / 短信）：
            </p>
            <button className="btn" data-testid="redeem"
              onClick={() => void go(async () => { await redeem(devToken); nav("/today"); })}>
              用这个令牌登录
            </button>
          </div>
        )}
      </div>

      <div className="login-demo">
        <details data-testid="password-panel">
          <summary className="section-t" style={{ cursor: "pointer", margin: 0 }}>
            用口令登录
          </summary>
          <div className="stack" style={{ gap: 14, marginTop: 14 }}>
            <p className="note" style={{ margin: 0 }}>
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
            <button className="btn btn-p login-go" data-testid="pw-submit"
              disabled={busy || !pwLogin.trim() || !pw} aria-busy={busy || undefined}
              onClick={() => void doPasswordLogin()}>
              登录
            </button>
          </div>
        </details>
      </div>

      {err && <div className="login-err" data-testid="login-error"
        style={{ marginTop: 16, marginBottom: 0 }}>{err}</div>}
    </>
  );

  /* ── 演示台 ─────────────────────────────────────────────────────
     身份直选放在最前面：演示台上人们要做的第一件事就是换个身份看，
     把它折叠起来等于把演示台最主要的功能藏了。 */
  if (IS_DEMO) return (
    <div className="login is-demo" data-testid="login-demo-env">
      <div className="login-banner" data-testid="demo-banner">
        <span className="login-env demo">演示环境</span>
        <span>
          这是一份用<b>示例数据</b>跑起来的演示台，
          不连接任何真实的临床数据 —— 这里的操作不会影响任何中心、受试者或账目。
        </span>
      </div>

      <div className="login-main">
        <div className="login-box">
          <Brand />
          <h2>挑一个身份开始看</h2>
          <p className="login-sub">
            这套系统的权限是<b>三维</b>的：看得到哪些行、哪些列、能做哪些动作。
            同一个页面换一个身份，少的不只是几个按钮 —— 换一个人看一眼是最快的理解方式。
          </p>

          <div className="demo-roles" data-testid="demo-roles">
            {DEV_LOGINS.map(d => (
              <button key={d.login} className="demo-role" data-testid={`dev-${d.login}`}
                disabled={busy}
                onClick={() => void go(async () => { await devLogin(d.login); nav("/today"); })}>
                <b>{d.who}</b>
                <span>{d.role}</span>
              </button>
            ))}
          </div>

          <div className="login-demo">
            <details data-testid="real-login-panel">
              <summary className="section-t" style={{ cursor: "pointer", margin: 0 }}>
                或者走真正的登录流程
              </summary>
              <div style={{ marginTop: 14 }}>{form}</div>
            </details>
          </div>
        </div>
      </div>
    </div>
  );

  /* ── 生产台 ───────────────────────────────────────────────────── */
  return (
    <div className="login is-prod" data-testid="login-prod-env">
      <aside className="login-aside">
        <Brand />
        <div>
          <p className="login-lede">
            把一个中心从<em>立项</em>带到<em>关闭</em>，
            每一步都留得下谁、什么时候、为什么。
          </p>
          {/* 三条事实，不是三句卖点。信任感来自"说得出具体的东西"。 */}
          <ul className="login-points">
            <li><span><b>行 × 列 × 动作</b>三维权限，在数据库里执行，不在界面上装样子。</span></li>
            <li><span><b>每一次写操作都留痕</b>，敏感动作必须写明原因，事后查得到。</span></li>
            <li><span><b>断网也能继续录</b>，恢复后按原顺序补发，不会记成两笔。</span></li>
          </ul>
        </div>
        <p className="login-foot">
          受控环境 · 全部访问均记录审计轨迹
        </p>
      </aside>

      <div className="login-main">
        <div className="login-box">
          <div className="row" style={{ marginBottom: 22 }}>
            <span className="login-env" data-testid="prod-env">生产环境</span>
          </div>
          <h2>登录</h2>
          <p className="login-sub">
            常规入口是一次性登录链接 —— 不必记密码，也就没有写在便利贴上的密码。
            内部账号可以用口令登录。
          </p>
          {form}
          <p className="login-foot">
            登录即表示你接受本系统的访问被完整记录。遇到问题请联系所在项目的管理员。
          </p>
        </div>
      </div>
    </div>
  );
}
