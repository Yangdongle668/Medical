import { z } from "zod";

/* ════════════════════════════════════════════════════════════════════
   错误 —— RFC 9457 Problem Details。
   type 是稳定 URI，永不改；title 可改（面向人），code 供程序分支。
   ════════════════════════════════════════════════════════════════════ */

export const ERROR_BASE = "https://sitedesk.dev/problems/";

export const ERRORS = {
  "validation-failed":      { status: 422, title: "请求校验未通过" },
  "unauthenticated":        { status: 401, title: "未认证" },
  "forbidden-action":       { status: 403, title: "无此动作权限" },
  /** 行范围之外的资源一律 404，**绝不是 403**。
   *  403 等于确认"这个资源存在，只是你不能碰" —— 对竞争对手的项目编号来说，
   *  这个确认本身就是泄漏。范围外 = 不存在。 */
  "not-found":              { status: 404, title: "资源不存在" },
  "conflict-version":       { status: 409, title: "版本冲突：资源已被他人修改" },
  "idempotency-key-reused": { status: 409, title: "幂等键被不同的请求体复用" },
  "invariant-violated":     { status: 422, title: "违反业务不变量" },
  "gate-not-satisfied":     { status: 422, title: "前置条件未满足" },
  "rate-limited":           { status: 429, title: "请求过于频繁" },
  /** 就绪探针专用。**必须是 503 而不是 200 + 一个字段** ——
   *  编排器看的是 HTTP 状态码，body 它不读。
   *  回 200 的就绪探针等于没有：它会把一个连不上库的实例放进负载均衡。 */
  "service-unavailable":    { status: 503, title: "服务暂时不可用" },
  /** 请求处理超过了截止时间，服务端主动收尾。
   *  **504 而不是 500**：500 的意思是"我出错了"，而这里是"我还没做完，
   *  但已经不能再占着这条数据库连接了" —— 客户端拿它去重试是合理的，
   *  拿 500 去重试通常不是。 */
  "request-timeout":        { status: 504, title: "请求处理超时" },
  "internal":               { status: 500, title: "服务内部错误" }
} as const;

export type ErrorCode = keyof typeof ERRORS;
export const ErrorCode = z.enum(Object.keys(ERRORS) as [ErrorCode, ...ErrorCode[]]);

/** 单个字段的校验失败 */
export const FieldIssue = z.object({
  path:    z.string().describe("JSON Pointer，如 /hours"),
  message: z.string()
}).meta({ id: "FieldIssue" });

/** 闸门未满足的具体条目 —— 对应中心关闭的七项前置条件。
 *  只说"不能关闭"是没用的；必须说清还差什么、去哪里处理。 */
export const GateUnmet = z.object({
  code:    z.string().describe("如 open-queries / ip-imbalance"),
  message: z.string().describe("面向人的说明，如「3 条数据质疑未关闭」"),
  module:  z.string().optional().describe("处理入口所属模块，供前端给出「去处理」跳转")
}).meta({ id: "GateUnmet" });

export const Problem = z.object({
  type:     z.string().describe(`${ERROR_BASE}{code}`),
  title:    z.string(),
  status:   z.int(),
  code:     ErrorCode,
  detail:   z.string().optional(),
  instance: z.string().optional().describe("出错的请求路径"),
  traceId:  z.string().optional(),
  /** validation-failed 时出现 */
  issues:   z.array(FieldIssue).optional(),
  /** gate-not-satisfied 时出现 */
  unmet:    z.array(GateUnmet).optional(),
  /** invariant-violated 时出现，值形如 "I8" —— 对应架构文档 §2.3 */
  invariant: z.string().optional()
}).meta({
  id: "Problem",
  description: "RFC 9457 Problem Details。所有非 2xx 响应都是这个形状。"
});

export type Problem = z.infer<typeof Problem>;
