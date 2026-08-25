/* @sitedesk/policy —— 权限判定的纯函数实现。
   前端用它收敛 UI，后端用它强制 —— **但前端那一份永远不是安全边界**。
   本包不得 import 任何 IO（由 CI 依赖图断言强制）。 */
export * from "./principal.js";
export * from "./row.js";
export * from "./field.js";
export * from "./action.js";
