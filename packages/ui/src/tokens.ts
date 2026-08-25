/* ════════════════════════════════════════════════════════════════════
   令牌的 TypeScript 视图 —— 由 tokens.css 解析而来，**不是另抄一份**。

   抄一份的后果不是不一致告警，是**两份都对不上而没人知道哪份是真的**。
   这里在构建/测试时读同一个 .css 文件，所以它们不可能分叉。
   ════════════════════════════════════════════════════════════════════ */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Mode = "light" | "dark";

const CSS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "tokens.css");

/** 从 tokens.css 里读出某一模式的全部自定义属性。 */
export function readTokens(mode: Mode = "light"): Record<string, string> {
  const css = fs.readFileSync(CSS, "utf8");

  /* 亮色是 :root{...}；暗色有两处等价定义（媒体查询与 data-theme），
     取 data-theme 那份 —— 它是显式选择，媒体查询那份是同一套值。 */
  const block = mode === "light"
    ? css.slice(css.indexOf(":root{"), css.indexOf("@media"))
    : css.slice(css.indexOf(':root[data-theme="dark"]{'));

  const out: Record<string, string> = {};
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)/gi))
    out[m[1]!] = m[2]!.trim();
  return out;
}

/* ── 对比度 ──────────────────────────────────────────────────────── */

const srgbToLinear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;

/** WCAG 相对亮度 */
export function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
  const [r, g, b] = [0, 2, 4].map(i =>
    srgbToLinear(parseInt(full.slice(i, i + 2), 16) / 255));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG 对比度，1–21。normal text AA 要 4.5，large text / UI 组件 AA 要 3。 */
export function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1! + 0.05) / (l2! + 0.05);
}

/**
 * CIELAB 色度 C*。**「有多鲜艳」要用感知量，不能用 HSV 饱和度。**
 *
 * HSV 说 #8A5B00（深琥珀）饱和度是 1.00，和 #FFD600（信号黄）一样满 ——
 * 因为它只看「离灰有多远」，不看亮到什么程度。
 * 而这两个颜色摆在界面上，一个是沉住的警示，一个是刺眼的红绿灯。
 * C* 能分开它们：52 对 87。
 */
export function chroma(hex: string): number {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
  const [r, g, b] = [0, 2, 4].map(i =>
    srgbToLinear(parseInt(full.slice(i, i + 2), 16) / 255));
  const X = 0.4124 * r! + 0.3576 * g! + 0.1805 * b!;
  const Y = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  const Z = 0.0193 * r! + 0.1192 * g! + 0.9505 * b!;
  const f = (t: number) => t > 216 / 24389 ? Math.cbrt(t) : 841 / 108 * t + 4 / 29;
  const [fx, fy, fz] = [f(X / 0.95047), f(Y), f(Z / 1.08883)];
  const a = 500 * (fx - fy), bb = 200 * (fy - fz);
  return Math.hypot(a, bb);
}
