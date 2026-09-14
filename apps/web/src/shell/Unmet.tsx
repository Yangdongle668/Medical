import { Link } from "react-router-dom";
import { moduleOf } from "./modules.js";

/* ════════════════════════════════════════════════════════════════════
   「还差什么」那张清单 —— **每一条都要给得出去处**。

   ── 现场报来的原话 ────────────────────────────────────────────────
     「我找不到这个对应的入口，我想 CRC 每一步点击如果被阻塞了，
       除了要有文字的提示，应该还要有一个跳转的链接，
       这样不用特地去找对应的入口和功能了。」

   这话说的是一条通则，不是某一页的毛病。在此之前**五个页面各自**把
   未满足项渲染成 `<li>{u.message}</li>` —— 纯文字，一个链接都没有：

     预筛登记 / 组织与权限 / 交接 / 访视详情 / 中心详情

   只有中心详情后来接上了链接，而那是**在那一页里单独写的**。
   于是"被拦下来要说得出去哪儿办"这件事，取决于写那一页的人当时想没想到。

   ── 所以把它做成一个东西，而不是五份写法 ──────────────────────────
   服务端每条未满足项本来就带着 `module` —— 模块 → 路径的对应表在
   shell/modules.ts 里。两者一接，链接是**自动**的：
   往后新加的闸门只要带上 module，它自己就有去处。

   ── 认不出的 module 不画链接，但那是个 bug ────────────────────────
   服务端曾经发过 `clinical` 与 `regulatory` 两个**根本不在模块表里**的
   键（见 apps/api/test/gate-module.test.ts 那条守卫）。认不出来时这里
   只画文字 —— 画一个指向 /undefined 的链接更糟。
   但它不该发生，所以那条守卫盯着服务端那一侧。
   ════════════════════════════════════════════════════════════════════ */

export interface UnmetItem {
  code: string;
  message: string;
  /** 去哪儿办这件事 —— `role_module` 的键（见 shell/modules.ts）。 */
  module?: string;
}

export function UnmetList({ items, testid, hrefFor, renderExtra }: {
  items: readonly UnmetItem[];
  testid?: string;
  /** 少数几条要带上下文 id（比如启动清单要带中心 id）。
   *  返回 undefined 就退回按模块出的那条路。 */
  hrefFor?: (u: UnmetItem) => string | undefined;
  /** 极少数几条给的不是链接，是**当场就能填的表**（中心详情页的
   *  「登记立项材料递交」就是）。那种情况下这一条塞在同一个 li 里 ——
   *  不给它口子的话，那一页只能整段另写一份，而链接那几行就有了两份。 */
  renderExtra?: (u: UnmetItem) => React.ReactNode;
}) {
  return (
    <ul className="unmet" {...(testid ? { "data-testid": testid } : {})}>
      {items.map((u, i) => (
        <li key={u.code || i}>
          {/* 角标显示**模块的中文名**，不是 `subj` / `instac` 这种键 ——
              键是给程序看的。原来这里直接把键画出来了。 */}
          {u.module && moduleOf(u.module) && (
            <span className="chip flat">{moduleOf(u.module)!.title}</span>
          )}
          <span>{u.message}</span>
          <UnmetGo u={u} href={hrefFor?.(u)} />
          {renderExtra?.(u)}
        </li>
      ))}
    </ul>
  );
}

/** 「去 XXX」那个链接 —— **一处实现，两个调用方**（UnmetList 与中心详情页）。
 *  两处各写一份的话，哪天改了标签写法，只有一处会跟上。 */
export function UnmetGo({ u, href }: { u: UnmetItem; href?: string | undefined }) {
  const m = u.module ? moduleOf(u.module) : undefined;
  const to = href ?? m?.path;
  if (!to) return null;
  return (
    <Link to={to} className="btn go" data-testid={`go-${u.module ?? u.code}`}>
      去{m?.title ?? "处理"}
    </Link>
  );
}
