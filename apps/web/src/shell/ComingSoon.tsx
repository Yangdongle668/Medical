import { useLocation } from "react-router-dom";
import { MODULES, moduleOf } from "./modules.js";

/* ════════════════════════════════════════════════════════════════════
   还没建的那一页。

   ── 为什么不是 404，也不是一句"敬请期待" ─────────────────────────
   导航是按 `role_module` 出的 —— 库里给了这个模块，侧栏就该有它，
   否则"老板勾掉一个模块导航就少一项"这件事只对了一半（勾上不加回来）。
   于是必然有一段时间：**有入口，页面还没写**。

   这一页要做的是把那段时间说清楚，而不是掩饰它：
     · 这个模块是干什么的（一句话，来自原型的需求基线）；
     · 谁看得到它、按什么行范围切 —— 这两件事已经在库里成立了，
       只是还没有界面把它画出来。

   一句"功能开发中"对用户没用，对接手的人更没用：
   他需要的恰恰是"这一页该有什么"，而那件事只有现在写得出来。
   ════════════════════════════════════════════════════════════════════ */

export function ComingSoon() {
  const loc = useLocation();
  const m = MODULES.find(x => x.path === loc.pathname)
    /* 路径带参数时（/inst/qc 这类）退回按前缀找 */
    ?? MODULES.find(x => loc.pathname.startsWith(x.path + "/"));

  return (
    <>
      <div className="page-head">
        <h2>{m?.title ?? "这一页还没有"}</h2>
        <p data-testid="coming-soon">这一页还没建。下面是它建出来之后要回答的问题。</p>
      </div>
      <div className="card stack" style={{ maxWidth: 640 }}>
        <p style={{ margin: 0 }}>{m?.todo ?? "这个路径不在模块登记表里。"}</p>
        {m && (
          <p className="muted" style={{ margin: 0 }}>
            模块键 <span className="mono">{m.key}</span> · 分组「{m.group}」。
            权限已经在库里生效了 —— 谁看得到它由 <span className="mono">role_module</span> 决定，
            看得到哪些行由角色的行范围决定。缺的只是这张界面。
          </p>
        )}
      </div>
    </>
  );
}

/** 登记表里有、但当前身份没有的模块 —— 手敲路径进来的那种。
 *  照样渲染（服务端才是边界），但要说一句，免得人以为自己看到的是全部。 */
export const isKnownModulePath = (pathname: string) =>
  MODULES.some(m => m.path === pathname || pathname.startsWith(m.path + "/"));

export { moduleOf };
