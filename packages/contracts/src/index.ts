/* @sitedesk/contracts —— 契约的唯一定义源。
   前端类型、后端 DTO、OpenAPI 文档、MSW mock 全部由此派生。 */
export * from "./kernel/primitives.js";
export * from "./kernel/fields.js";
export * from "./kernel/gates.js";
export * from "./kernel/errors.js";
export * from "./kernel/pagination.js";
export * from "./kernel/command.js";
export * from "./kernel/registry.js";
export * from "./auth/api.js";
export * from "./identity/model.js";
export * from "./site/model.js";
export * from "./site/staffing.js";

/* 端点定义有副作用（注册到 registry），必须被导入 */
import "./auth/api.js";
import "./identity/api.js";
import "./site/api.js";
