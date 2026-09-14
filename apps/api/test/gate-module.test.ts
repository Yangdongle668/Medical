import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* ════════════════════════════════════════════════════════════════════
   每条未满足项上的 `module`，必须是**模块表里真有的那个键**。

   ── 现场报来的原话 ────────────────────────────────────────────────
     「我找不到这个对应的入口，我想 CRC 每一步点击如果被阻塞了，
       除了要有文字的提示，应该还要有一个跳转的链接。」

   界面正是**按这个键**出跳转链接的（shell/Unmet.tsx → shell/modules.ts）。
   键认不出来就只画文字 —— 而那时界面看起来完全正常：
   一条没有链接的提示和一条不该有链接的提示长得一模一样。

   ── 查出来的时候，十条里有八条是错的 ──────────────────────────────
   服务端当时发的是：

     clinical   × 5   ← 模块表里没有这个键
     regulatory × 1   ← 没有
     quality    × 1   ← 没有（真键是 `qa`）
     instac / startup / handover ✓

   也就是说**关闭中心那八项前置条件，一条都跳不过去**，
   而每一条都在告诉人去别的地方办一件事。

   ── 为什么这条守卫扫源码，而不是调接口 ────────────────────────────
   要把八项闸门全部走到 unmet，得先造出八种卡住的中心 —— 那是一整套夹具，
   而它验的还只是被走到的那几条。这里直接扫源码里所有
   `module: "xxx"` 与 `counted(..., "xxx", ...)` 的字面量，
   一条都不漏，也不需要数据库。

   代价是它认的是写法。写法变了（比如改成变量），这条会**漏过**而不是
   误报 —— 所以下面同时钉住"至少抓到 N 条"：抓不到那么多，
   说明这条守卫已经形同虚设。
   ════════════════════════════════════════════════════════════════════ */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "../src");
const WEB_MODULES = path.resolve(HERE, "../../web/src/shell/modules.ts");

function sources(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sources(p, acc);
    else if (e.name.endsWith(".ts")) acc.push(p);
  }
  return acc;
}

/** 模块表里的键 —— **从 apps/web 那一份读**，不在这里抄一遍。
 *  抄一份的话，这条守卫验的是那份副本，而不是界面真正用的那张表。 */
function moduleKeys(): Set<string> {
  const src = fs.readFileSync(WEB_MODULES, "utf8");
  return new Set([...src.matchAll(/key: "([a-z]+)"/g)].map(m => m[1]!));
}

describe("未满足项的 module 必须是真模块键", () => {
  const keys = moduleKeys();

  it("模块表读得出来，而且不止几个 —— 读空了这条规则就恒真了", () => {
    expect(keys.size, "没从 shell/modules.ts 里读到模块键").toBeGreaterThan(30);
    /* 抽查几个：写法变了（key 不再是字面量）时这里先红。 */
    for (const k of ["startup", "instac", "material", "ethics", "subj", "qa"])
      expect(keys.has(k), `模块表里应当有 ${k}`).toBe(true);
  });

  it("**服务端发出去的每一个 module 都在表里**", () => {
    const found: { file: string; key: string }[] = [];
    for (const f of sources(SRC)) {
      const src = fs.readFileSync(f, "utf8");
      for (const m of src.matchAll(/module:\s*"([a-z]+)"/g))
        found.push({ file: path.relative(SRC, f), key: m[1]! });
      /* 计数型闸门把模块当第二个位置参数传（gate.ts 的 `counted`）。 */
      for (const m of src.matchAll(/counted\(\s*"[a-z-]+",\s*"([a-z]+)"/g))
        found.push({ file: path.relative(SRC, f), key: m[1]! });
    }

    expect(found.length,
      "一条 module 都没抓到 —— 写法变了，这条守卫已经形同虚设")
      .toBeGreaterThanOrEqual(10);

    const bad = found.filter(x => !keys.has(x.key));
    expect(bad.map(x => `${x.file}: "${x.key}"`),
      "这些键不在 shell/modules.ts 的模块表里 —— " +
      "界面据它出跳转链接，认不出来就只画文字，" +
      "而「没有链接」和「不该有链接」在界面上长得一模一样")
      .toEqual([]);
  });
});
