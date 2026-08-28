import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { ApiError, setQueueOwner } from "../api/client.js";
import { subscribe } from "../api/outbox.js";
import { startReplay } from "../api/replay.js";
import { loadToken, logout, recallWho, type CachedWho } from "../features/login/session.js";
import { loadMe, forgetMe, type Me } from "../features/login/me.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { FactoryPasswordBanner } from "./FactoryPasswordBanner.js";
import { navFor } from "./modules.js";

/* 侧栏原来是这六项写死的：今天 / 我的中心 / 交接 / 工时 / 质量台账 / 费率卡。
   而**谁看得到哪些模块**库里早有答案（role_module，随 /v1/me 下发）——
   经营层在库里是 19 个模块，界面上只给 6 个；45 个模块里有 33 个
   压根没有入口。写死的数组等于把那张表的结论丢掉重猜一遍，且猜得更少。

   离线时（拿不到 /v1/me）退回一份最小集合：那几页是真的建好了的，
   而且不带权限判断也不会出错 —— 服务端才是边界。 */
const OFFLINE_MODULES = ["crc", "mysite", "handover", "time", "qa"];

/** 当前高亮哪一项 —— **只亮一项**。
 *
 *  两个坑，第二个是第一个的补丁引出来的：
 *
 *  ① 不能用裸的 `startsWith(path)`：那会让 `/sites` 在 `/sitesomething`
 *     上也亮。所以比到**路径段**为止（下一个字符必须是斜杠）。
 *
 *  ② 但段比较仍然不够：`/inst` 和 `/inst/qc` 是登记表里两个不同的模块
 *     （机构工作台、机构质控）。人在 `/inst/qc` 上时两条都"匹配"，
 *     于是侧栏**两项一起亮** —— 而高亮的全部意义就是回答"我现在在哪"。
 *
 *  取最长的那一条。 */
export function activePath(here: string, paths: string[]): string | null {
  const hit = (p: string) => here === p || here.startsWith(p.endsWith("/") ? p : p + "/");
  return paths.filter(hit).sort((a, b) => b.length - a.length)[0] ?? null;
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  /** 冷启动就没网时，从缓存认出来的"上次是谁"。**只用来认领队列**，不判权限。 */
  const [offlineWho, setOfflineWho] = useState<CachedWho | null>(null);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(0);
  const loc = useLocation();
  const nav = useNavigate();

  /* 改完口令要把身份重新拉一遍 —— 红条的开关就在 /v1/me 里。
     不重拉的话，改成功了红条还挂着，人会以为没生效然后再改一次。 */
  const reload = () => loadMe().then(setMe).catch(() => { /* 失败就留着红条，比错误地撤下它安全 */ });

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
        if (e instanceof ApiError && e.problem.status === 401) {
          nav("/login", { replace: true });
          return;
        }
        /* 拿不到 /v1/me，但上一次登录还记得是谁 —— **冷启动就离线**的那种。
           在此之前这里什么也不做：没有归属人 → L2 命令入不了队 →
           人在地下室做的活直接抛错丢掉。
           现在把归属人立起来，让活能排进发件箱；**权限一律不给** ——
           me 仍然是 null，界面明说自己不知道你能做什么。 */
        const who = recallWho();
        if (who) {
          setQueueOwner({ accountId: who.accountId, accountName: who.accountName });
          setOfflineWho(who);
        }
      });
  }, []);

  /* 发件箱：入队要知道是谁排的（共用电脑上不许冒名），
     侧栏要看得见还有多少没发出去。 */
  useEffect(() => subscribe(s => setPending(s.pending.length)), []);
  useEffect(() => {
    /* 离线认出来的身份也要能重放 —— 网一回来，队列自己就发出去了，
       不必等人再登录一次。 */
    const accountId = me?.account.id ?? offlineWho?.accountId;
    if (!accountId) return;
    const stop = startReplay(() => ({ accountId }));
    /* 换人或卸载时把归属清掉：没有身份就不入队，也就没法冒名。 */
    return () => { setQueueOwner(null); stop(); };
  }, [me, offlineWho]);

  if (!ready) return <div className="main"><p className="muted">加载中…</p></div>;

  const groups = navFor(me?.permissions.modules ?? OFFLINE_MODULES);
  const here = activePath(loc.pathname, groups.flatMap(g => g.items.map(m => m.path)));

  return (
    <div className="app">
      <aside className="rail">
        <h1>临床中心台</h1>
        <nav>
          {groups.map(({ group, items }) => (
            <div key={group} className="nav-group">
              {/* 分组标题只在**不止一组**时出现。只有一组的时候它是一句废话：
                  上面写着"我的工作"，下面就是那个人的全部页面 ——
                  多出来的那一行只是把导航往下推了一格。 */}
              {groups.length > 1 && <span className="nav-group-title">{group}</span>}
              {items.map(m => (
                <NavLink key={m.key} to={m.path}
                  aria-current={m.path === here ? "page" : undefined}>
                  {m.title}
                  {/* 还没建的页照样出现在导航里 —— 权限已经生效了，
                      藏起来反而让"我到底有没有这个模块"变成猜。
                      但要标出来，免得点进去像是坏了。 */}
                  {m.todo && <span className="nav-todo" title="这一页还没建">·</span>}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        {/* 待发数量常驻侧栏 —— 「我到底发出去没有」不该由用户去猜 */}
        {pending > 0 && (
          <NavLink to="/outbox" className="outbox-badge" data-testid="outbox-badge"
            aria-current={loc.pathname.startsWith("/outbox") ? "page" : undefined}>
            发件箱 <b className="num">{pending}</b> 条待发
          </NavLink>
        )}

        {/* 离线：说清楚"我知道你是谁"和"我不知道你能做什么"是两件事。
            不这么说的话，界面看起来就像权限被收走了。 */}
        {!me && offlineWho && (
          <div className="problem" data-testid="offline-banner" style={{ margin: "8px 0" }}>
            <strong>离线</strong>
            <div className="muted">
              连不上服务端，拿不到你的权限。上次登录的是 <b>{offlineWho.accountName}</b> ——
              现在做的事会记在他名下排进发件箱，联网后自动发出去。
            </div>
          </div>
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
      {/* 边界在这里，不在更外面：一个页面炸掉时侧栏要还在 ——
          人还能换一页、还能看见待发条数、还能登出。
          key 用路径：换一页就是一次新的尝试，不必手动点重试。 */}
      <main className="main">
        {/* 出厂口令那条红条在**边界之外**：某一页炸了，警报不该跟着消失。
            也在 key 之外 —— 换页不该把它重置成"没看过"。 */}
        {me?.credentials.passwordIsInitial && (
          <FactoryPasswordBanner login={me.account.login} onDone={() => { forgetMe(); void reload(); }} />
        )}
        <ErrorBoundary scope={`page:${loc.pathname}`} key={loc.pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}
