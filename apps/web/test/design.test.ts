import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* ════════════════════════════════════════════════════════════════════
   设计语言不许再悄悄漂移。

   ── 这条测试是为哪次事故写的 ────────────────────────────────────
   packages/ui/src/tokens.css 的文件头写着「逐字取自 prototype」。
   那句话只对了一半：取的是 `:root{}` 里的 28 个色值，**后面 420 行
   组件样式一行都没跟过来**。于是 web 端各页各写各的 CSS ——
   量出来是原型 ~130 个类、web ~55 个，交集只有 `.btn` 和 `.card`，
   而这两个的定义还是相反的（原型的 `.card` 是"没有卡片"：
   `background:none;border:0`；web 的是带边框圆角的盒子）。

   整整三类组件在 web 端一个都没有：图表、抽屉/模态、吐司。
   全仓 0 个 `<svg>`、0 个 drawer、0 个 toast。

   **这件事没有任何东西会报警。** 当时的护栏只有两条：
   tokens.ts 的对比度测试（色值没变，照过）与 e2e 的 390px
   不横向溢出（布局塌成单列，照过）。结构走样一点感觉不到。

   ── 所以这里钉两个方向 ─────────────────────────────────────────
   ① **用了的类必须有人定义** —— 防"写了 className 但没样式"；
   ② **原型定义的类必须移植过来或显式豁免** —— 防"又一次只搬色板"。
   ════════════════════════════════════════════════════════════════════ */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");

const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

/** 从 CSS 文本里取出被定义的类名。 */
function defined(css: string): Set<string> {
  const out = new Set<string>();
  const body = css
    /* 先剥注释：注释里有整段样例代码，会被当成定义。 */
    .replace(/\/\*[\s\S]*?\*\//g, "")
    /* 再剥 URL：`fonts.googleapis.com` 里的 `.com` 不是类名。 */
    .replace(/https?:\/\/[^\s"')]+/g, "")
    .replace(/url\([^)]*\)/g, "");
  for (const m of body.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) out.add(m[1]!);
  return out;
}

/** 递归收集 apps/web/src 下的 tsx。 */
function sources(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) sources(rel, acc);
    else if (e.name.endsWith(".tsx")) acc.push(rel);
  }
  return acc;
}

const CSS = defined(
  read("packages/ui/src/components.css") +
  read("packages/ui/src/tokens.css") +
  read("apps/web/src/shell/styles.css"));

const PROTOTYPE = defined(read("prototype/parts/01-head.html"));

describe("设计语言：用了的类必须有人定义", () => {
  /* className 里可能有条件表达式（`chip ${bad ? "crit" : "good"}`），
     所以取的是整段字符串里的词，不是整个属性值。 */
  const used = new Map<string, string[]>();
  for (const file of sources("apps/web/src")) {
    const src = read(file);
    for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
      const raw = (m[1] ?? m[2] ?? "")
        /* 模板里的 `${...}` 表达式：取其中的字符串字面量，扔掉变量名。
           **但要先扔掉判断条件里的字面量** —— 它们是业务取值，不是类名：
             `${s.state === "enrolled" ? "good" : "flat"}`
             `${["screen_failed","withdrawn"].includes(s.state) ? … }`
           "enrolled" / "screen_failed" 是受试者状态，"good" / "flat" 才是类。
           不剥的话这条测试会报一串假阳性，而假阳性多了之后
           真的那条就没人看了 —— 那正是这条测试要防的事本身。 */
        .replace(/\$\{[^}]*\}/g, s => (s
          .replace(/[=!]==?\s*"[^"]*"/g, "")
          .replace(/\[[^\]]*\]\s*\.includes\([^)]*\)/g, "")
          .replace(/\.includes\(\s*"[^"]*"\s*\)/g, "")
          .match(/"[^"]*"/g) ?? []).join(" "))
        .replace(/"/g, " ");
      for (const cls of raw.split(/\s+/).filter(Boolean))
        used.set(cls, [...(used.get(cls) ?? []), file]);
    }
  }

  it("每个用到的类都在 CSS 里定义过", () => {
    const orphan = [...used].filter(([c]) => !CSS.has(c));
    expect(orphan.map(([c, f]) => `.${c} ← ${f[0]}`), "用了但没人定义").toEqual([]);
  });

  it("扫到的类不至于太少 —— 正则失效时这条会先响", () => {
    /* 上面那条断言在「一个也没扫到」时同样会通过。
       它是空集合断言的经典盲区：正则写坏了反而全绿。 */
    expect(used.size).toBeGreaterThan(40);
  });
});

describe("设计语言：原型的组件层必须移植过来", () => {
  /* 原型里有、而 web 端不需要的类。**每一条都要写清楚为什么** ——
     没有理由的豁免就是下一次漂移的入口。 */
  const WAIVED: Record<string, string> = {
    /* 原型是单文件 HTML，自带一套演示外壳；web 端的外壳在 styles.css。 */
    content: "原型的内容区容器；web 端是 .main",
    topbar: "顶栏尚未移植 —— 面包屑/身份/项目范围三件事目前在侧栏",
    "topbar-sp": "同 topbar",
    crumb: "同 topbar",
    "demo-tag": "原型的「演示数据」角标，正式系统没有这回事",
    "view-head": "web 端是 .page-head（同一个东西，名字没跟着改）",
    nav: "原型的导航容器；web 端用 <nav> 元素本身",
    "nav-item": "web 端导航项是 <a>，样式挂在 .rail a 上",
    "nav-ic": "原型里就是 display:none —— 图标退场，分组与排版已说清层级",
    "nav-badge": "web 端的待发角标是 .outbox-badge，语义更窄",
    "rail-foot": "web 端用 .rail .who",
    brand: "侧栏品牌区是 .rail h1；登录页那处用的是 .login-brand",
    persona: "web 端身份显示在 .rail .who 里",
    /* .login-u / .lu-* 是原型「点一下换个身份」的演示入口。
       正式登录没有这一块 —— 换身份要重新登录，那是刻意的。 */
    "login-u": "原型的演示身份切换；正式登录没有这一块",
    "lu-r": "同 login-u", "lu-u": "同 login-u",
    n: "原型的 .persona .n（姓名）；web 端身份区结构不同",
    d: "原型的 .persona .d（角色说明）；同上",
    tw: "原型的表格滚动容器；web 端叫 .table-wrap（承重的那道防线，见 styles.css）",
    /* 尚未用到、但已随组件层一起移植进来的，不在这里豁免 ——
       它们在 components.css 里，下面那条断言查的就是这个。 */
  };

  it("原型定义的每个类，要么在 components.css 里，要么显式豁免", () => {
    const missing = [...PROTOTYPE].filter(c => !CSS.has(c) && !(c in WAIVED));
    expect(missing.sort(), "原型有、这边没有，也没写豁免理由").toEqual([]);
  });

  it("三类曾经整类缺席的组件都在：图表 / 悬浮层 / 反馈", () => {
    /* 这三类不是"做得不一样"，是**一个都没有**。
       单独钉一条，因为上面那条一旦被大量豁免就会失去意义。 */
    for (const c of ["chart", "gridline", "axis-t", "legend",
      "drawer", "modal", "scrim", "toast", "toasts", "tip"])
      expect(CSS.has(c), `.${c} 不见了`).toBe(true);
  });

  /* ── 这一条换过一次方向，值得写清楚为什么 ──────────────────────
     它原来钉的是「`.card` 是平面，不是盒子」（`border:0`），
     出处是原型的第一行注释「界面是一个平面，不是一摞卡片」。

     2026-09 的 UI 重构**反转了这个决定**：反馈是整屏压抑、没有层级，
     而"一个平面"正是没有层级的直接原因 —— 一屏二十个区块铺在同一层，
     眼睛不知道先看哪个。现在是底 / 面 / 浮三层，`.card` 是中间那一层。

     ── 但守卫本身留着，而且钉的是同一件事 ────────────────────────
     它当初存在的理由不是"平面比盒子好"，而是**同一个类名在两个文件里
     长出了两个相反的定义**，且没有任何东西会为此报警。那个风险没有变，
     所以这里改成钉新的决定：`.card` 是一张面（有底色、有边框），
     而且**只能有一处定义** —— styles.css 里不许再画一遍。 */
  it("`.card` 是一张面，且只有一处定义", () => {
    const ui = read("packages/ui/src/components.css");
    const rule = (ui.match(/^\.card\s*\{([^}]*)\}/m)?.[1] ?? "").replace(/\s/g, "");
    expect(rule, ".card 不再是一张面了 —— 底 / 面 / 浮三层里的中间那层没了")
      .toMatch(/background:var\(--surface\)/);
    expect(rule, ".card 没有边界，它会和底色糊在一起").toMatch(/border:1px/);

    /* 第二处定义才是当初出事的那件事。 */
    const shell = read("apps/web/src/shell/styles.css");
    expect(shell, "styles.css 又在重画 .card —— 一个类名两个定义，" +
      "而共享的只有颜色令牌").not.toMatch(/^\.card\s*\{/m);
  });
});
