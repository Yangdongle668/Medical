import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { ApiError, setQueueOwner } from "../api/client.js";
import { subscribe } from "../api/outbox.js";
import { startReplay } from "../api/replay.js";
import { loadToken, logout } from "../features/login/session.js";
import { loadMe, type Me } from "../features/login/me.js";

const NAV = [
  { to: "/today", label: "今天" },
  { to: "/sites", label: "我的中心" },
  { to: "/handovers", label: "交接" },
  { to: "/timesheets", label: "工时" },
  { to: "/quality", label: "质量台账" },
  { to: "/rate-cards", label: "费率卡" }
];

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(0);
  const loc = useLocation();
  const nav = useNavigate();

  useEffect(() => {
    loadToken();
    loadMe()
      .then(m => {
        /* 归属人要在**子页面挂载之前**定下来。
           React 的子组件 effect 先于父组件 effect 执行 ——
           放在下面那个 useEffect 里的话，启动清单页第一次读发件箱时
           还不知道自己是谁，本人排的那几行就显示不出"待发"，
           而且要等到队列下一次写入才会补上。 */
        setQueueOwner({ accountId: m.account.id, accountName: m.account.displayName });
        setMe(m); setReady(true);
      })
      .catch(e => {
        setReady(true);
        /* 401 才跳登录。其它错误留在页面上 ——
           把网络故障也当成「未登录」，会让人一直在登录页打转。 */
        if (e instanceof ApiError && e.problem.status === 401) nav("/login", { replace: true });
      });
  }, []);

  /* 发件箱：入队要知道是谁排的（共用电脑上不许冒名），
     侧栏要看得见还有多少没发出去。 */
  useEffect(() => subscribe(s => setPending(s.pending.length)), []);
  useEffect(() => {
    if (!me) return;
    const stop = startReplay(() => ({ accountId: me.account.id }));
    /* 换人或卸载时把归属清掉：没有身份就不入队，也就没法冒名。 */
    return () => { setQueueOwner(null); stop(); };
  }, [me]);

  if (!ready) return <div className="main"><p className="muted">加载中…</p></div>;

  return (
    <div className="app">
      <aside className="rail">
        <h1>临床中心台</h1>
        <nav>
          {NAV.map(n => (
            <NavLink key={n.to} to={n.to}
              aria-current={loc.pathname.startsWith(n.to) ? "page" : undefined}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        {/* 待发数量常驻侧栏 —— 「我到底发出去没有」不该由用户去猜 */}
        {pending > 0 && (
          <NavLink to="/outbox" className="outbox-badge" data-testid="outbox-badge"
            aria-current={loc.pathname.startsWith("/outbox") ? "page" : undefined}>
            发件箱 <b className="num">{pending}</b> 条待发
          </NavLink>
        )}

        <div className="who">
          {me ? <>
            <div data-testid="who">{me.account.displayName} · {me.account.role.name}</div>
            <div data-testid="scope">{me.scopeLabel}</div>
            <button className="btn" data-testid="logout" style={{ marginTop: 8 }}
              onClick={() => void logout().then(() => nav("/login", { replace: true }))}>
              登出
            </button>
          </> : "未登录"}
        </div>
      </aside>
      <main className="main"><Outlet /></main>
    </div>
  );
}
