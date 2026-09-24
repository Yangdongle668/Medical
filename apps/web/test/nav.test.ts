import { describe, it, expect } from "vitest";
import { navFor, splitNav, PRIMARY, MODULES, GROUP_ORDER } from "../src/shell/modules.js";
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

  it("**一页都不剩了** —— 45 个模块全部有页", () => {
    /* 这条断言的用处不是"数得对"，是**两个方向都会红**：
       建好了一页却忘了删 todo → 导航照旧把人带到一张说明页；
       删了 todo 却没在 main.tsx 里登记 → 点进去落回 ComingSoon。
       两种错都不报错、不变红，只是界面上少了点什么。

       现在它空了。**留着这条断言**：往后再加模块时，
       占位的那一页会立刻在这里显形，而不是等谁点进去才发现。 */
    expect(MODULES.filter(m => m.todo).map(m => m.key).sort()).toEqual([]);
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

describe("splitNav：一线的主入口 / 更多", () => {
  const CRC = ["crc", "subj", "sched", "query", "mysite", "capa",
    "startup", "prescreen", "ethics", "instac", "handover", "isf", "material", "pay", "time"];

  it("前六项按库里的顺序平铺，不按分组重排", () => {
    /* navFor 按 GROUP_ORDER 排；主入口不行 —— 它的意义就是"每天用的那几项在最上面"，
       按分组一排，「质量与 SAE」又沉回底下去了。 */
    const s = splitNav("crc", CRC)!;
    expect(s.primary.map(m => m.key)).toEqual(["crc", "subj", "sched", "query", "mysite", "capa"]);
    expect(s.more.flatMap(g => g.items)).toHaveLength(CRC.length - PRIMARY);
  });

  it("「更多」里仍按分组排，一项不丢", () => {
    const s = splitNav("crc", CRC)!;
    const all = [...s.primary, ...s.more.flatMap(g => g.items)].map(m => m.key).sort();
    expect(all).toEqual([...CRC].sort());
    expect(s.more.map(g => g.group)).toEqual(["项目周期", "现场", "资源", "机构办公室"]);
  });

  it("先去重再数六项 —— qa 与 capa 是同一页，不能占两个位置", () => {
    const s = splitNav("cra", ["cra", "sched", "capa", "qa", "mon", "mysites", "query",
      "isf", "ethics", "time"])!;
    expect(s.primary.map(m => m.key)).toEqual(["cra", "sched", "capa", "mon", "mysites", "query"]);
    expect(s.more.flatMap(g => g.items).map(m => m.key)).not.toContain("qa");
  });

  it("只对一线；经营层、项目总监照旧按分组铺", () => {
    expect(splitNav("boss", ["dash", "intake", "sites", "enr", "screen", "client", "cash",
      "bid", "change", "staff", "pnl"])).toBeNull();
    expect(splitNav(undefined, CRC)).toBeNull();
  });

  it("总共就七八项的时候不拆 —— 为省两行多一次点击不值得", () => {
    expect(splitNav("crc", CRC.slice(0, PRIMARY + 2))).toBeNull();
    expect(splitNav("crc", CRC.slice(0, PRIMARY + 3))).not.toBeNull();
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
