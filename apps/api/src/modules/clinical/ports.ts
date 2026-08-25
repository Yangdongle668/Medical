/* ════════════════════════════════════════════════════════════════════
   ClinicalOps 对外部上下文的**出口**。

   「完成一次访视」要顺带记一条工时，而工时属于 Timesheet & Cost。
   直接 import 对方的 service 是最省事的写法，也是最贵的：
   半年后想把成本核算拆成独立服务时，会发现两边已经缠在一起了。

   所以这里只声明**需要什么**，不关心谁来做。装配在 app.module 里完成，
   ClinicalOps 一行都不 import 对方（tools/arch-check.mjs 强制）。
   ════════════════════════════════════════════════════════════════════ */

export interface VisitTimesheetPort {
  /**
   * 为一次已完成的访视记一条工时并归集成本。
   * 返回 null 表示**没有入账**（通常是当日没有生效的费率卡）——
   * 调用方必须把这件事说出来，不能当作成功。
   */
  postVisitTimesheet(input: {
    studySiteId: string; visitId: string; subjectId: string;
    actualDate: string; hours: number;
  }): Promise<{ id: string; costCents: number } | null>;
}

/** DI 令牌。实现由 app.module 绑定。 */
export const VISIT_TIMESHEET_PORT = Symbol("VisitTimesheetPort");
