import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { allEndpoints } from "@sitedesk/contracts";

/* ════════════════════════════════════════════════════════════════════
   写端点必须有人调，没人调的要**写明为什么**。

   ── 这条测试是为哪次盘点写的 ────────────────────────────────────
   契约里 132 个端点，其中 75 个是写端点（post / patch / put / delete）。
   清点了一遍前端到底调了哪些：**60 个已接，15 个在服务端跑着
   但界面上没有任何入口** —— 完整的 controller、service、审计、幂等键，
   `db/test` 里还有针对性的测试，就是没有一个按钮打得到它。

   漏掉的那些有一条清楚的规律：**每条流程"处理/判定"那一端都接了，
   "发起"那一端没接。** 可以判定一份立项申请，但提不了；
   可以受理一份机构材料，但交不了；可以确认、执行、交报告一次监查访视，
   但排不了。于是系统只能处理已经在库里的记录 ——
   任何一件事都没法从界面上开一个头。

   ── 这件事此前同样没有任何东西会报警 ────────────────────────────
   `tools/arch-check.mjs` 断言"端点与契约一一对应"，
   但它比的是**契约与后端实现**，不管前端有没有调。
   于是一个端点可以写完、测完、上线，然后在那里放一年。

   ── 所以：豁免要写理由 ──────────────────────────────────────────
   一个端点暂时没接不是错。**没人说得出为什么没接**才是。
   ════════════════════════════════════════════════════════════════════ */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "../src");

/** 递归读 apps/web/src 下的全部 ts / tsx，**排除 mocks/** ——
 *  mock 里出现一个端点名只说明它有假响应，不说明界面上打得到它。 */
function sources(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name !== "mocks") sources(path.join(dir, e.name), acc);
    } else if (/\.tsx?$/.test(e.name)) acc.push(path.join(dir, e.name));
  }
  return acc;
}

const CODE = sources(SRC).map(f => fs.readFileSync(f, "utf8")).join("\n");

/* 按**词**匹配，不是子串。`call("createBid")`、
   `op: "createBid" | "decideBid"`（当成变量传下去的那种）、
   feature 里的 api.ts 包装 —— 三种写法都要认得出。
   只用 `call("…")` 那一种正则的话会漏掉后两种，
   而第一次盘点正是这么把 60 个数成了 38 个的。 */
const referenced = (op: string) =>
  new RegExp(`\\b${op}\\b`).test(CODE);

const WRITE = new Set(["post", "patch", "put", "delete"]);
const writes = allEndpoints()
  .filter(e => WRITE.has(e.method))
  .map(e => e.id)
  .sort();

/** 服务端有、界面上暂时没有入口的写端点。**每一条都要写清楚为什么。**
 *  接上一个就从这里删一行 —— 这张表只许变短。
 *
 *  **现在它空了：75 个写端点全都有界面入口。**
 *  空着不等于这条测试没用了 —— 契约新增一个写端点时，
 *  上面那条断言会立刻响，而那正是要有人来决定"它归哪一页"的时刻。
 *  往这里加一行是允许的，但得写清楚为什么。 */
const NOT_YET: Record<string, string> = {};

describe("写端点接线", () => {
  it("每个写端点要么被前端引用，要么在 NOT_YET 里写明理由", () => {
    const orphan = writes.filter(id => !referenced(id) && !(id in NOT_YET));
    expect(orphan, "服务端写了、前端没接，也没写理由").toEqual([]);
  });

  it("NOT_YET 只许变短：接上了就把那一行删掉", () => {
    /* 留在表里的"已经接了"比漏掉一个更坏 ——
       它会让人以为那件事还没做，然后再做一遍。 */
    const stale = Object.keys(NOT_YET).filter(referenced);
    expect(stale, "这些已经接上了，从 NOT_YET 里删掉").toEqual([]);
  });

  it("NOT_YET 里的都还是真端点 —— 契约改名时这条先响", () => {
    const gone = Object.keys(NOT_YET).filter(id => !writes.includes(id));
    expect(gone, "契约里已经没有这些写端点了").toEqual([]);
  });

  it("盘点的分母对得上：75 个写端点", () => {
    /* 分母写死。契约新增一个写端点时这条会响 ——
       那正是要有人来决定"它归哪一页"的时刻。 */
    expect(writes.length).toBe(75);
  });
});
