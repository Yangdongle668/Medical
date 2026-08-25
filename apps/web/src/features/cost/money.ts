/* ════════════════════════════════════════════════════════════════════
   金额与比率的显示。

   **这里只做格式化，不做算术。** 业务数字全部来自 `@sitedesk/calc`
   （服务端算好后随响应下来）—— 前端再算一遍就等于有了第二套口径，
   两套迟早分叉，而分叉那天没人知道该信哪一个。

   唯一的除法是 `cents / 100`，那是单位换算不是口径。
   ════════════════════════════════════════════════════════════════════ */

/** 分 → 人民币。负数带号，供脱落扣减那一项使用。 */
export const yuan = (cents: number, opts: { sign?: boolean } = {}) => {
  const s = (cents / 100).toLocaleString("zh-CN",
    { style: "currency", currency: "CNY", maximumFractionDigits: 0 });
  return opts.sign && cents > 0 ? `+${s}` : s;
};

/** 比率 → 百分数。**只接受数字** —— 「没有分母」由调用方判断字段在不在，
 *  不在这里用 null 表达：受列权限管辖的字段，缺席已经有一个含义了。 */
export const pct = (r: number) =>
  r.toLocaleString("zh-CN", { style: "percent", maximumFractionDigits: 1 });

/** 人天保留一位 —— 3.5 天和 3.53 天在决策上没有区别，多出来的位只会让人误以为很精确。 */
export const days = (d: number) => d.toFixed(1);
