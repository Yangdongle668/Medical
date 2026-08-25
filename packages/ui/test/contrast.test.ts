import { describe, it, expect } from "vitest";
import { readTokens, contrast, chroma } from "../src/tokens.js";

/* ════════════════════════════════════════════════════════════════════
   Phase 5 退出标准①：**明暗双模式对比度实测**。

   「看着够清楚」在暗色模式下几乎总是错的 —— 同一组灰在亮底上分得开，
   在暗底上就糊成一片。而这类问题不会有人报 bug，只会让人少看一眼看板。

   所以这里逐对实测，不靠肉眼。
   ════════════════════════════════════════════════════════════════════ */

const AA_TEXT = 4.5;        // 正文
const AA_LARGE = 3;         // 大字 / UI 组件边界

/** 正文级：必须 ≥ 4.5 */
const TEXT_PAIRS: [string, string][] = [
  ["--ink", "--surface"], ["--ink", "--ground"], ["--ink", "--surface-2"],
  ["--ink-2", "--surface"], ["--ink-2", "--ground"],
  ["--accent", "--surface"], ["--accent", "--ground"],
  ["--good", "--good-soft"], ["--warn", "--warn-soft"], ["--crit", "--crit-soft"],
  ["--good", "--surface"], ["--crit", "--surface"],
  ["--accent-ink", "--accent"]
];

/** 辅助级：≥ 3 即可（次要说明文字、分隔线、图元） */
const SUPPORT_PAIRS: [string, string][] = [
  ["--ink-3", "--surface"], ["--ink-3", "--ground"],
  ["--plan", "--surface"], ["--warn", "--surface"],
  ["--s1", "--surface"], ["--s2", "--surface"], ["--s3", "--surface"]
];

for (const mode of ["light", "dark"] as const) {
  describe(`对比度（${mode === "light" ? "亮色" : "暗色"}）`, () => {
    const t = readTokens(mode);

    it("令牌解析出来了 —— 解析不到会让下面每条断言都变成空转", () => {
      expect(Object.keys(t).length).toBeGreaterThan(20);
      for (const k of ["--ink", "--surface", "--accent", "--crit"])
        expect(t[k], `缺令牌 ${k}`).toMatch(/^#[0-9A-Fa-f]{3,8}$/);
    });

    it.each(TEXT_PAIRS)("%s on %s ≥ 4.5（正文）", (fg, bg) => {
      const r = contrast(t[fg]!, t[bg]!);
      expect(r, `${fg}(${t[fg]}) on ${bg}(${t[bg]}) = ${r.toFixed(2)}`)
        .toBeGreaterThanOrEqual(AA_TEXT);
    });

    it.each(SUPPORT_PAIRS)("%s on %s ≥ 3（辅助）", (fg, bg) => {
      const r = contrast(t[fg]!, t[bg]!);
      expect(r, `${fg}(${t[fg]}) on ${bg}(${t[bg]}) = ${r.toFixed(2)}`)
        .toBeGreaterThanOrEqual(AA_LARGE);
    });
  });
}

describe("这套语言的两条自我约束", () => {
  it("暗色不是把亮色反过来 —— 强调色在两个模式下是不同的值", () => {
    /* 直接反色会让强调色在暗底上刺眼，而语义色会失去彼此的区分度。 */
    expect(readTokens("light")["--accent"]).not.toBe(readTokens("dark")["--accent"]);
    expect(readTokens("light")["--crit"]).not.toBe(readTokens("dark")["--crit"]);
  });

  /* 参照点写死在测试里，不给一个凭空的阈值 ——
     「比信号色沉」是可陈述的意图，「C* < 70」不是。 */
  const SIGNAL = { "--crit": "#FF0000", "--good": "#00C853", "--warn": "#FFD600" };

  it("语义色比对应的信号色沉 —— 绝不做红绿灯", () => {
    for (const mode of ["light", "dark"] as const) {
      const t = readTokens(mode);
      for (const [key, signal] of Object.entries(SIGNAL)) {
        const c = chroma(t[key]!), s = chroma(signal);
        expect(c, `${mode} ${key}(${t[key]}) C*=${c.toFixed(0)} ` +
          `不该比信号色 ${signal} 的 C*=${s.toFixed(0)} 更鲜艳`).toBeLessThan(s);
      }
    }
  });

  it("强调色才是最鲜艳的那个 —— 一屏里「活着」的地方只该有它", () => {
    /* 语义色比强调色还跳，看板就变成了背景噪音，
       而真正要紧的那一项反而看不见了。 */
    for (const mode of ["light", "dark"] as const) {
      const t = readTokens(mode);
      const accent = chroma(t["--accent"]!);
      for (const key of ["--crit", "--good", "--warn"])
        expect(chroma(t[key]!), `${mode} ${key} 比强调色还鲜艳`)
          .toBeLessThan(accent);
    }
  });
});
