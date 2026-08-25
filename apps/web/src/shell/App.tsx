import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { ApiError } from "../api/client.js";
import { loadToken, logout } from "../features/login/session.js";
import { loadMe, type Me } from "../features/login/me.js";

const NAV = [
  { to: "/today", label: "今天" },
  { to: "/sites", label: "我的中心" },
  { to: "/handovers", label: "交接" },
  { to: "/quality", label: "质量台账" }
];

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const loc = useLocation();
  const nav = useNavigate();

  useEffect(() => {
    loadToken();
    loadMe()
      .then(m => { setMe(m); setReady(true); })
      .catch(e => {
        setReady(true);
        /* 401 才跳登录。其它错误留在页面上 ——
           把网络故障也当成「未登录」，会让人一直在登录页打转。 */
        if (e instanceof ApiError && e.problem.status === 401) nav("/login", { replace: true });
      });
  }, []);

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
