import { NavLink } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import type { Group, ModuleDef } from "./modules.js";

/* ════════════════════════════════════════════════════════════════════
   侧栏。**它对不同的人是两个不同的东西**，所以这里有两套行为。

   ── 量出来的问题 ────────────────────────────────────────────────
   模块登记表接上 `role_module` 之后，侧栏从写死的六项变成了"库里有多少
   给多少"。对大多数人这是对的（CRC 14 条、PM 13 条、CRA 10 条，
   一屏放得下），但管理员拿到的是 **41 条链接 + 11 个分组标题**：

     侧栏内容高 2093px，可视 900px —— 要滚 1193px；
     不滚动只看得到 19 条，剩下 22 条要滚才够得着。

   经营层 19 条也刚好溢出。**一条要滚动才够得着的导航，
   等于把"这个系统有哪些页"变成了一件要费力气才知道的事。**

   ── 处置：多到看不完的时候才折叠 ────────────────────────────────
   分组折叠对 41 条是解药，对 5 条是无谓的多一次点击。所以
   **超过 DENSE 条才折叠**（判据见下），九个身份里只有 admin 会进这条路，
   其余八个看到的侧栏和以前一模一样。

   折叠时默认展开**你当前所在的那一组** —— 导航首先要回答"我在哪"，
   然后才是"还有什么"。手动开合记在 localStorage 里：
   一个人常在哪两组之间来回，系统记住比每次问他一遍好。

   ── 还要一个不靠折叠的入口 ──────────────────────────────────────
   折叠解决"看不完"，解决不了"我知道那一页叫什么，但它在哪一组"。
   所以密的时候另给一个过滤框，敲 `/` 直接聚焦。
   过滤时**忽略折叠**：找的时候不该还要先想一层它归哪一组。
   ════════════════════════════════════════════════════════════════════ */

/** 折叠从多少条起。
 *
 *  **判据不是"会不会溢出"，是"溢出到什么程度"。** 要滚一点是正常的 ——
 *  每一页都要滚；而要滚超过一整屏、一半的条目根本不在视野里，是另一回事。
 *  1440×900 实测：链接约 32px 一条、分组标题约 41px 一行，
 *  经营层 19 条约 1003px（超出 103px，滚一下就到），
 *  管理员 41 条 2093px（超出 1193px，19 条可见、22 条要滚）。
 *
 *  线画在这两者之间：约一屏半（≈1350px），换算过来是二十来条。
 *  取 24 —— 九个演示身份里只有管理员越线，其余八个看到的侧栏
 *  与折叠这件事出现之前**一模一样**。
 *  折叠是给"多到看不完"的解药，不该让"多一点点"的人也吃。 */
export const DENSE = 24;

const KEY = "sitedesk.rail.open";

function loadOpen(): Record<string, boolean> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return v && typeof v === "object" ? v as Record<string, boolean> : {};
  } catch { return {}; }        // 存过坏数据、或者根本读不到，都不该让侧栏崩掉
}

function saveOpen(v: Record<string, boolean>) {
  try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* 无痕模式写不进去 */ }
}

/** 手机上侧栏是**横着**的一条（见 styles.css 的 720px 断点）：
 *  它本来就靠横向滚动，分组标题在那边是 `display:none`。
 *  折叠是给竖着那一列的答案 —— 搬到横条上只会多出一排点不明白的按钮。
 *  所以折叠与过滤框都只在宽屏出现，窄屏一切照旧。
 *
 *  `matchMedia` 在 jsdom 里可能没有：拿不到就当宽屏，
 *  因为宽屏才是这个组件要负责的那一侧。 */
const WIDE = "(min-width: 721px)";

function useWide(): boolean {
  /* 初值同步取一次，不等 effect —— 等的话手机上第一帧会先按宽屏画出
     过滤框和折叠箭头，下一帧再撤掉，看起来像界面自己抖了一下。 */
  const [wide, setWide] = useState(
    () => typeof matchMedia !== "function" || matchMedia(WIDE).matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia(WIDE);
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return wide;
}

export function Rail({ groups, here }: {
  groups: { group: Group; items: ModuleDef[] }[];
  here: string | null;
}) {
  const wide = useWide();
  const total = groups.reduce((s, g) => s + g.items.length, 0);
  const dense = wide && total > DENSE;
  const [q, setQ] = useState("");
  const [manual, setManual] = useState<Record<string, boolean>>(loadOpen);
  const find = useRef<HTMLInputElement>(null);

  /* `/` 聚焦过滤框。**要先确认光标不在别的输入框里** ——
     否则在页面上填理由时打一个斜杠，光标会跳到侧栏去。 */
  useEffect(() => {
    if (!dense) return;
    const on = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      e.preventDefault();
      find.current?.focus();
      find.current?.select();
    };
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, [dense]);

  const hereGroup = groups.find(g => g.items.some(m => m.path === here))?.group ?? null;
  /* 不密的时候不过滤 —— 过滤框那时是不显示的，
     把窗口从宽拉窄正好卡在筛了一半上的话，人就只剩一条链接
     而且没有地方把它清掉。 */
  const needle = dense ? q.trim().toLowerCase() : "";
  /* 分组名也参与匹配：敲「质量」要能一次捞出那一组的四页，
     而不是逼人去回忆每一页各自叫什么。 */
  const hit = (g: Group, m: ModuleDef) =>
    m.title.toLowerCase().includes(needle) || g.toLowerCase().includes(needle);

  const shown = needle
    ? groups.map(g => ({ ...g, items: g.items.filter(m => hit(g.group, m)) }))
        .filter(g => g.items.length > 0)
    : groups;

  /* 展开与否：不密的时候全展开（和以前一样）；过滤时也全展开；
     否则看手动记录，没记录过就按"你在不在这一组"。 */
  const isOpen = (g: Group) => !dense || !!needle || (manual[g] ?? g === hereGroup);
  const foldable = dense && !needle && groups.length > 1;

  const toggle = (g: Group) => {
    const next = { ...manual, [g]: !isOpen(g) };
    setManual(next); saveOpen(next);
  };

  return (
    <nav>
      {dense && (
        <div className="rail-find">
          <input ref={find} value={q} data-testid="rail-find" type="search"
            placeholder="跳到…（按 /）" aria-label="在导航里找一页"
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => { if (e.key === "Escape") { setQ(""); e.currentTarget.blur(); } }} />
        </div>
      )}

      {shown.map(({ group, items }) => (
        <div key={group} className="nav-group">
          {groups.length > 1 && (foldable ? (
            <button className="nav-group-h" data-testid={`nav-g-${group}`}
              aria-expanded={isOpen(group)} onClick={() => toggle(group)}>
              <span className="nav-group-title">{group}</span>
              {/* 收起来时要说清"里面有几条" —— 否则一列收起的标题
                  看不出哪一组值得展开。 */}
              <span className="nav-n">{items.length}</span>
              {/* 你所在的那一组被手动收起来时，标题上留一个记号：
                  导航的第一职责是回答"我在哪"，收起来不该把这个答案也收走。 */}
              {!isOpen(group) && group === hereGroup &&
                <span className="nav-at" title="你正在这一组里" />}
              <span className="nav-caret" aria-hidden="true">{isOpen(group) ? "▾" : "▸"}</span>
            </button>
          ) : <span className="nav-group-title">{group}</span>)}

          {isOpen(group) && items.map(m => (
            <NavLink key={m.key} to={m.path}
              aria-current={m.path === here ? "page" : undefined}
              /* 跳过去之后过滤词就该清掉 —— 留着它，侧栏会一直只剩
                 那一条，而人已经在读页面了，不会想起来是自己筛的。 */
              onClick={() => setQ("")}>
              {m.title}
              {/* 还没建的页照样出现在导航里 —— 权限已经生效了，
                  藏起来反而让"我到底有没有这个模块"变成猜。
                  但要标出来，免得点进去像是坏了。 */}
              {m.todo && <span className="nav-todo" title="这一页还没建">·</span>}
            </NavLink>
          ))}
        </div>
      ))}

      {needle && shown.length === 0 && (
        <p className="nav-none" data-testid="rail-none">
          没有叫「{q.trim()}」的页面。
        </p>
      )}
    </nav>
  );
}
