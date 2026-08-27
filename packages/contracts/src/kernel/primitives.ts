import { z } from "zod";

/* ════════════════════════════════════════════════════════════════════
   基础类型 —— 全系统只在这里定义一次。
   规约 9（单一定义源）：前端类型、后端 DTO、OpenAPI 文档全部由此生成。
   ════════════════════════════════════════════════════════════════════ */

export const Uuid = z.uuid();

/** 人类可读编号（SS-01 / HJ-2024-017）。主键是 uuid，这个只是业务标识。 */
export const Code = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

/** 日历日期。访视目标日、伦理批件日都是日历概念 ——
 *  带时区会在跨时区时错一天，而"错一天"在访视窗口上就是一次方案偏离。 */
export const DateOnly = z.iso.date();

/** 带时区时间戳。审计时间、提交时间用它。 */
export const Timestamp = z.iso.datetime({ offset: true });

/** 金额：**整数分**，不是元、更不是浮点。
 *
 *  为什么是分而不是 numeric(14,2) 的元：
 *  ① 计算引擎前后端共用（架构原则 P1），整数运算不需要十进制库；
 *  ② JSON 里 numeric 会变成字符串，前端一旦 Number() 就回到浮点；
 *  ③ 现实上限：5 亿元 = 5e10 分，远在 Number.MAX_SAFE_INTEGER (9e15) 之内。
 *
 *  展示层负责除以 100 并按万元/元排版；契约层不做展示换算。 */
export const Cents = z.int().min(-1_000_000_000_000).max(1_000_000_000_000)
  .describe("金额，单位：分（整数）");
export const CentsNonNeg = Cents.min(0);

/** 比率：0–1 的小数。百分比在展示层换算，契约层不出现 "35%" 这种字符串。 */
export const Ratio = z.number().min(0).max(1);

/** 游标。不用 offset —— 数据一直在变，翻页会重复或漏掉。 */
export const Cursor = z.string().min(1).max(512);

/** 查询串里的布尔。
 *
 *  **不要用 `z.coerce.boolean()`** —— 它走的是 `Boolean(v)`，
 *  于是 `?flag=false` 会被解析成 `true`（非空字符串一律为真）。
 *  只传 `?flag=true` 的地方看不出问题，但只要有一处让人传 false，
 *  它就会安静地做反 —— 而"筛选器点了没反应"是最难被报上来的一种 bug。
 *
 *  这里认三种写法（`true` / `1` / `yes`，及其反面），其余一律报错：
 *  把 `?flag=ture` 当成 false 也是在猜，而猜错时同样是安静的。 */
export const QueryBool = z.union([
  z.boolean(),
  z.enum(["true", "1", "yes", "on"]).transform(() => true),
  z.enum(["false", "0", "no", "off"]).transform(() => false)
]).describe("布尔查询参数：true/1/yes 或 false/0/no");

/** 幂等键。所有 L2 命令必填，见 kernel/command.ts。 */
export const IdempotencyKey = z.uuid()
  .describe("幂等键。24 小时内重放同一键返回首次结果。CRC 离线重放的生命线。");

export type Cents = z.infer<typeof Cents>;
export type DateOnly = z.infer<typeof DateOnly>;
export type Timestamp = z.infer<typeof Timestamp>;
