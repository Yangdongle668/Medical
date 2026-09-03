/* @sitedesk/calc —— 业务口径的唯一实现。
   界面上出现的每一个业务数字都来自这里，且带口径版本号。
   纯函数，不碰 IO（tools/arch-check.mjs 强制）。 */
export * from "./kernel.js";
export * from "./revenue.js";
export * from "./cost.js";
export * from "./quality.js";
export * from "./feasibility.js";
export * from "./quote.js";
export * from "./bizdev.js";
export * from "./cash.js";
export * from "./query.js";
export * from "./monitor.js";
export * from "./audit.js";
export * from "./intake.js";
