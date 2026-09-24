import { NavLink, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import { Drawer } from "@sitedesk/ui/react";
import type { Group, ModuleDef } from "./modules.js";

/* ════════════════════════════════════════════════════════════════════
   手机底部的页签条（只在 ≤720px 出现，见 styles.css）。

   原来手机上侧栏是横着的一条：CRC 的 15 项首尾相连地横滚，
   要找「交接」得左右划着找，而当前在哪一页常常被划出屏外。
   CRC 一半时间是拿着手机在医院走廊上用这套系统的。

   现在：拇指够得着的底部，四个最常用的 + 「更多」。
   四个取的是侧栏主入口的前四个（role_module 顺序，迁移 0054），
   不在这里另排一份。「更多」拉起一个抽屉，按分组列出全部页面。
   ════════════════════════════════════════════════════════════════════ */

/** 底部只有五分之一屏宽，放不下「受试者访视窗口」—— 给常用的几项起个短名。 */
const SHORT: Record<string, string> = {
  crc: "今天", cra: "今天", subj: "受试者", sched: "日程", query: "质疑",
  mysite: "中心", mysites: "中心", sites: "中心", capa: "质量", qa: "质量",
  mon: "监查", pm: "工作台", dash: "驾驶舱", approve: "审批", time: "工时"
};
const short = (m: ModuleDef) => SHORT[m.key] ?? m.title;

export const TAB_COUNT = 4;

export function TabBar({ tabs, groups, pending }: {
  tabs: ModuleDef[];
  groups: { group: Group; items: ModuleDef[] }[];
  pending: number;
}) {
  const [more, setMore] = useState(false);
  const loc = useLocation();
  /* 从抽屉里点了一页就收起来 —— 留着它，人会以为自己没点中 */
  useEffect(() => { setMore(false); }, [loc.pathname]);

  const inTabs = tabs.some(t => loc.pathname === t.path || loc.pathname.startsWith(t.path + "/"));

  return (
    <>
      <nav className="tabbar" data-testid="tabbar" aria-label="主要页面">
        {tabs.map(m => (
          <NavLink key={m.key} to={m.path} data-testid={`tab-${m.key}`}>{short(m)}</NavLink>
        ))}
        {/* 当前页不在前四个里时，「更多」是亮的 —— 否则底部一项都不亮，说不出人在哪 */}
        <button type="button" data-testid="tab-more" aria-expanded={more}
          className={inTabs ? "" : "active"} onClick={() => setMore(true)}>
          更多{pending > 0 && <b className="tab-badge num">{pending}</b>}
        </button>
      </nav>

      <Drawer open={more} onClose={() => setMore(false)} title="全部页面">
        <div className="stack" data-testid="more-sheet">
          {pending > 0 && (
            <NavLink to="/outbox" className="outbox-badge">发件箱 <b className="num">{pending}</b> 条待发</NavLink>
          )}
          {groups.map(g => (
            <section key={g.group} className="more-group">
              <h4>{g.group}</h4>
              {g.items.map(m => (
                <NavLink key={m.key} to={m.path}>{m.title}</NavLink>
              ))}
            </section>
          ))}
        </div>
      </Drawer>
    </>
  );
}
