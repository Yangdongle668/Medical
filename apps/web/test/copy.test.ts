import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* ════════════════════════════════════════════════════════════════════
   界面上的字是写给干活的人看的，不是写给做系统的人看的。

   ── 这条测试是为什么写的 ──────────────────────────────────────────
   不变量编号（I3、I8′、I10……）是设计文档里的索引，在代码注释里很有用；
   写到界面上，CRC 读到的是「筛败不是失败，是收入（I8′）」——
   括号里那个东西她不认识，也没有地方可以查。
   同理还有表名、列名（`site_assignment`、`pi_account_id`）和
   「行范围」「幂等键」「后端」这类只有开发才用的词。

   这些字都是一段一段加进来的，每一段单看都说得通。没有一条护栏的话，
   下一段还会这样加进来。

   ── 怎么量 ────────────────────────────────────────────────────────
   剥掉注释（块注释与行注释，包括 JSX 里花括号包着的那种）之后，
   剩下的是会被渲染的文字、字符串和代码。
   ① 不变量编号：**所有页面**都不许出现；
   ② 开发用词：只管一线每天打开的那些页。「组织与权限」这类
      管理员页面里，「行范围」本身就是管理员要配置的东西，不在此列。
   ════════════════════════════════════════════════════════════════════ */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "../src");

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(dir, e.name))
      : e.name.endsWith(".tsx") ? [path.join(dir, e.name)] : []);
}

/** 把注释换成等长空白 —— 行号不动，报错时指得准。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "))
    /* `//` 前面是冒号的是 URL（http://），不是注释 */
    .replace(/(^|[^:])\/\/.*$/gm, (m, p: string) => p + " ".repeat(m.length - p.length));
}

function hits(file: string, re: RegExp): string[] {
  const rel = path.relative(SRC, file);
  return stripComments(fs.readFileSync(file, "utf8")).split("\n")
    .flatMap((l, i) => re.test(l) ? [`${rel}:${i + 1}  ${l.trim().slice(0, 100)}`] : []);
}

/** 一线（CRC / CRA）每天打开的页面。 */
const FRONTLINE = [
  "features/today", "features/visit", "features/subject", "features/dataquery/QueryPage.tsx",
  "features/isf", "features/material", "features/ethics", "features/handover",
  "features/cost/TimesheetPage.tsx", "features/quality", "features/oversight/MonPage.tsx",
  "features/sites", "features/site", "features/outbox", "features/workbench/SchedulePage.tsx",
  "shell/App.tsx", "shell/Rail.tsx"
].map(p => path.join(SRC, p));

const inFrontline = (f: string) => FRONTLINE.some(p => f === p || f.startsWith(p + path.sep));

describe("界面文字", () => {
  const files = walk(SRC).filter(f => !f.includes(`${path.sep}mocks${path.sep}`));

  it("不出现不变量编号（I3、I8′、I10 …）", () => {
    const bad = files.flatMap(f => hits(f, /(^|[^A-Za-z0-9_])I\d+['′]?(?![A-Za-z0-9_])/));
    expect(bad, `这些编号用户不认识，写成它的意思：\n${bad.join("\n")}`).toEqual([]);
  });

  it("一线页面不出现表名、列名和开发用词", () => {
    const re = /site_assignment|pi_account_id|role_module|行范围|幂等|后端/;
    const bad = files.filter(inFrontline).flatMap(f => hits(f, re));
    expect(bad, `换成一线听得懂的说法：\n${bad.join("\n")}`).toEqual([]);
  });

  it("护栏自己是好的：注释里的编号不算，字符串里的算", () => {
    const tmp = path.join(HERE, "__copy_probe.tsx");
    fs.writeFileSync(tmp, [
      "/* I8′ 在注释里 */",
      "const a = 1; // I3 也在注释里",
      "const url = \"http://x\"; const b = \"按 I10 处理\";"
    ].join("\n"));
    try {
      const got = hits(tmp, /(^|[^A-Za-z0-9_])I\d+['′]?(?![A-Za-z0-9_])/);
      expect(got).toHaveLength(1);
      expect(got[0]).toContain(":3");
    } finally { fs.unlinkSync(tmp); }
  });
});
