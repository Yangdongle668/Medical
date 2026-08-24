import { z } from "zod";

/* ════════════════════════════════════════════════════════════════════
   列维度权限 —— 架构原则 P2 的契约侧落地。
   ════════════════════════════════════════════════════════════════════ */

/** 与数据库 field_key 表一一对应。改这里必须同时改迁移，反之亦然。 */
export const FIELD_KEYS = ["cost", "margin", "price", "subject", "staff"] as const;
export const FieldKey = z.enum(FIELD_KEYS);
export type FieldKey = (typeof FIELD_KEYS)[number];

export const FIELD_LABEL: Record<FieldKey, string> = {
  cost:    "成本与人天",
  margin:  "毛利与利润率",
  price:   "报价与合同金额",
  subject: "受试者筛选号",
  staff:   "员工薪资口径"
};

/**
 * 标记一个字段受列维度权限管辖。
 *
 * **无权限时该字段从响应里消失，不是返回 null。**
 * 返回 null 本身就泄漏了"这个字段存在"这件事 —— 对机构办来说，
 * 知道我们有"毛利率"这个字段，和知道它的值，是两个不同的泄漏等级。
 *
 * 因此 gated 字段在契约里一律是 optional：
 * 客户端必须能处理"它不在"，而不是"它是 null"。
 */
export const gated = <T extends z.ZodType>(schema: T, field: FieldKey) =>
  schema.optional().meta({
    "x-gated-by": field,
    description: `【${FIELD_LABEL[field]}】无权限时该字段不出现在响应中（不是 null）`
  });
