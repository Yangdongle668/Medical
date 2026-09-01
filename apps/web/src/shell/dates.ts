/* ════════════════════════════════════════════════════════════════════
   日期差。

   **两端必须归到同一个零点。**
   `Date.now()` 带着时分秒，拿它直接和一个 `YYYY-MM-DD` 相减，
   同一条数据在上午和下午会算出差一天的结果 ——
   而"在途 21 天"和"在途 22 天"在页面上没人看得出哪个是错的。

   后端已经为同一件事栽过一次（见 staffing.service.ts 的 atMidnight）：
   当天到期的清单项算出「逾期 0 天」，既进了逾期清单，又显示 0 天。
   **差一天的错误在访视窗口上就是一次方案偏离。**

   这里统一用 UTC 的零点：日期串本来就是 `toISOString()` 切出来的，
   两端同源才谈得上相减。
   ════════════════════════════════════════════════════════════════════ */

const utcMidnightToday = () => {
  const n = new Date();
  return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
};

/** 从 `YYYY-MM-DD` 到今天，过了几个日历日。今天 = 0，昨天 = 1。 */
export const daysSince = (isoDate: string) =>
  Math.round((utcMidnightToday() - Date.parse(isoDate + "T00:00:00Z")) / 86_400_000);

/** 今天，`YYYY-MM-DD`。 */
export const today = () => new Date().toISOString().slice(0, 10);
