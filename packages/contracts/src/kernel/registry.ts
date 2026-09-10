import { z } from "zod";
import { Problem, ERRORS, type ErrorCode } from "./errors.js";
import type { ActionKey } from "./actions.js";

/* ════════════════════════════════════════════════════════════════════
   端点注册表 —— 契约的唯一登记处，OpenAPI 由它生成。
   路由实现、前端 client、MSW mock 都从这里派生，不允许各写一份。
   ════════════════════════════════════════════════════════════════════ */

export type Layer = "L1" | "L2" | "L3";

export interface Endpoint {
  /** 稳定操作 id。**永不修改** —— 前端生成的方法名由它决定 */
  id: string;
  method: "get" | "post" | "patch" | "delete";
  path: string;
  layer: Layer;
  context: string;
  summary: string;
  description?: string;
  /** 需要的动作权限（action_key）。缺省表示只需通过行范围。
   *  **定型为 ActionKey**：写错一个字母、或用了一个没登记的动作，
   *  在 `define()` 那一行就编译不过 —— 而不是等到运行时全员 403。 */
  action?: ActionKey;
  query?: z.ZodType;
  params?: z.ZodType;
  body?: z.ZodType;
  /** 204 之类没有响应体的端点省略它 —— 空 schema 与「没有 content」在 OpenAPI 里是两回事 */
  response?: z.ZodType;
  status?: number;
  /** 除通用错误外，本端点特有的错误 */
  errors?: ErrorCode[];
  /** 契约已冻结但尚未实现 —— 前端可据此 mock，后端在对应模块实现 */
  planned?: boolean;
}

const endpoints: Endpoint[] = [];

export function define(e: Endpoint): Endpoint {
  if (endpoints.some(x => x.id === e.id))
    throw new Error(`操作 id 重复：${e.id}`);
  if (e.layer === "L2" && e.method !== "post")
    throw new Error(`${e.id}：L2 命令必须是 POST`);
  if (e.layer === "L2" && !e.path.includes(":"))
    throw new Error(`${e.id}：L2 命令路径须形如 /v1/xxx/{id}:action`);
  if (!e.response && e.status !== 204)
    throw new Error(`${e.id}：只有 204 可以没有响应体`);
  endpoints.push(e);
  return e;
}

export const allEndpoints = (): readonly Endpoint[] => endpoints;

/** 按 id 取一个端点。写错 id 立刻抛，而不是拿到 undefined 再往下走。 */
export function endpointOf(id: string): Endpoint {
  const e = endpoints.find(x => x.id === id);
  if (!e) throw new Error(`没有登记这个操作：${id}`);
  return e;
}

/** 取某个端点的请求体 schema —— **路由层不许再写一份**。
 *
 *  写第二份的代价不是"多几行"，是它会安静地和契约分叉：
 *  createStudySite 的 `code` 在契约里改成了可选，而路由层那份副本
 *  仍然要求必填 —— 于是接口返回 422「请求参数不符合契约」，
 *  而它自己就是那份契约的实现。这种错没有任何测试拦得住，
 *  因为两边各自都是自洽的。 */
export function bodyOf(id: string): z.ZodType {
  const e = endpointOf(id);
  if (!e.body) throw new Error(`${id} 没有请求体，取不到 body schema`);
  return e.body;
}

/** 每个端点都可能返回的错误，不必逐个声明 */
export const COMMON_ERRORS: ErrorCode[] = [
  "unauthenticated", "forbidden-action", "not-found", "validation-failed",
  "rate-limited", "internal"
];

export { Problem, ERRORS };
