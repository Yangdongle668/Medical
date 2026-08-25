import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import { call } from "../api/client.js";

interface Me {
  account: { displayName: string; role: { name: string } };
  scopeLabel: string;
}

const NAV = [
  { to: "/today", label: "今天" },
  { to: "/sites", label: "我的中心" },
  { to: "/quality", label: "质量台账" }
];

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const loc = useLocation();

  useEffect(() => { call<Me>("getMe").then(setMe).catch(() => setMe(null)); }, []);

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
            <div>{me.account.displayName} · {me.account.role.name}</div>
            <div>{me.scopeLabel}</div>
          </> : "未登录"}
        </div>
      </aside>
      <main className="main"><Outlet /></main>
    </div>
  );
}
