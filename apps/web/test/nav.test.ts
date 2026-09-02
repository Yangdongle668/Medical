import { describe, it, expect } from "vitest";
import { navFor, MODULES, GROUP_ORDER } from "../src/shell/modules.js";
import { activePath } from "../src/shell/App.js";

/* ════════════════════════════════════════════════════════════════════
   侧栏。三件事值得钉住，每一件都在真实数据上出过错。
   ════════════════════════════════════════════════════════════════════ */

describe("模块登记表", () => {
  it("覆盖原型的 45 个模块，一个不多一个不少", () => {
    expect(MODULES).toHaveLength(45);
    expect(new Set(MODULES.map(m => m.key)).size).toBe(45);
  });

  it("每个模块的分组都在 GROUP_ORDER 里 —— 否则它在侧栏上直接消失", () => {
    /* navFor 按 GROUP_ORDER 过滤。分组名打错一个字，那个模块不会报错，
       它只是**不出现**了 —— 而"我明明有这个权限"是查不到原因的那种问题。 */
    for (const m of MODULES)
      expect(GROUP_ORDER, `${m.key} 的分组「${m.group}」不在 GROUP_ORDER 里`)
        .toContain(m.group);
  });

  it("路径要么以 / 开头，要么就是拼不出路由", () => {
    for (const m of MODULES) expect(m.path.startsWith("/"), m.key).toBe(true);
  });

  it("还没建的那几页，逐个点名", () => {
    /* 这条断言的用处不是"数得对"，是**两个方向都会红**：
       建好了一页却忘了删 todo → 导航照旧把人带到一张说明页；
       删了 todo 却没在 main.tsx 里登记 → 点进去落回 ComingSoon。
       两种错都不报错、不变红，只是界面上少了点什么。 */
    expect(MODULES.filter(m => m.todo).map(m => m.key).sort()).toEqual([
      "audit", "instac", "intake", "isf", "mon"
    ]);
  });

  it("todo 写的是**这一页要回答什么问题**，不是「敬请期待」", () => {
    /* 一句"功能开发中"对用户没用，对接手的人更没用 ——
       他要知道的是这一页该有什么，而那件事只有现在写得出来。 */
    for (const m of MODULES.filter(x => x.todo))
      expect(m.todo!.length, `${m.key} 的 todo 太短，多半是句占位符`)
        .toBeGreaterThan(12);
  });
});

describe("navFor", () => {
  it("同一个路径只出一行 —— 管理员同时拿着 crc 和 cra，侧栏不该有两个「我的一天」", () => {
    const items = navFor(["crc", "cra", "mysite", "mysites", "sites"]).flatMap(g => g.items);
    expect(items.map(m => m.path)).toEqual(["/today", "/sites"]);
  });

  it("按 GROUP_ORDER 排，不按传进来的顺序", () => {
    /* 传进来的是库里 role_module 的顺序（sort_order），
       而侧栏要的是稳定的分组顺序 —— 两者不是一回事。 */
    const groups = navFor(["org", "dash", "crc"]).map(g => g.group);
    expect(groups).toEqual(["我的工作", "经营", "系统"]);
  });

  it("不认得的 module_key 直接丢掉，不炸", () => {
    /* 有人在「组织与权限」里手敲了一个键，或者原型加了模块而这边没跟上。
       两种都不该让侧栏崩掉。 */
    expect(navFor(["org", "meiyouzhegemokuai"]).flatMap(g => g.items).map(m => m.key))
      .toEqual(["org"]);
  });

  it("空清单给空侧栏，不给一个报错", () => {
    expect(navFor([])).toEqual([]);
  });
});

describe("高亮：只亮一项", () => {
  const paths = MODULES.map(m => m.path);

  it("取最长的那一条 —— /inst 与 /inst/qc 是两个不同的模块", () => {
    /* 段前缀匹配会让这两条同时命中，于是侧栏两项一起亮 ——
       而高亮的全部意义就是回答"我现在在哪"。 */
    expect(activePath("/inst/qc", paths)).toBe("/inst/qc");
    expect(activePath("/inst", paths)).toBe("/inst");
  });

  it("详情页高亮它所属的列表页", () => {
    expect(activePath("/sites/abc-123", paths)).toBe("/sites");
    expect(activePath("/sites/abc-123/startup", paths)).toBe("/sites");
  });

  it("不是路径段的前缀不算命中", () => {
    expect(activePath("/sitesomething", ["/sites"])).toBe(null);
  });

  it("哪一条都不命中就一条都不亮", () => {
    expect(activePath("/outbox", paths)).toBe(null);
  });
});
