/* @sitedesk/calc —— 业务口径的唯一实现。
   界面上出现的每一个业务数字都来自这里，且带口径版本号。
   纯函数，不碰 IO（tools/arch-check.mjs 强制）。 */
export * from "./kernel.js";
export * from "./revenue.js";
export * from "./cost.js";
export * from "./quality.js";
