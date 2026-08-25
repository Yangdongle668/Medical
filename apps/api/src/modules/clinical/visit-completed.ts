/* ════════════════════════════════════════════════════════════════════
   「CRC 完成一次访视」在业务上触发七件事。

   七件事分属三个模块，而模块是分阶段交付的。
   于是有一个很容易犯的错：**先实现能实现的五件，剩下两件等以后**——
   然后没有任何地方记得还差两件，直到某天有人发现工时对不上。

   所以七件事在这里逐条登记，`delivered: false` 的那几条同样在册。
   下面那条测试断言「登记表覆盖架构文档里的全部七项」——
   漏掉一条，测试就红；实现了一条却忘了改标记，测试也红。

   这和闸门里的 `unavailable` 是同一个做法：
   **没做的事要留在明面上，不能靠记性。**
   ════════════════════════════════════════════════════════════════════ */

export interface Subscriber {
  /** 架构文档 §5.1 的订阅者名 */
  name: string;
  /** 做什么 */
  what: string;
  /** 所属上下文 */
  context: "ClinicalOps" | "Timesheet & Cost" | "Quality" | "External" | "Analytics";
  /** 产生哪个副作用 type；不产生可见副作用的写 null */
  effect: string | null;
  /** 已实现 = true；未实现的写明由哪个阶段交付 */
  delivered: boolean;
  pendingPhase?: string;
}

export const VISIT_COMPLETED_SUBSCRIBERS: readonly Subscriber[] = [
  { name: "AdvanceSubjectVisit", what: "按 SOA 生成下一次访视窗口",
    context: "ClinicalOps", effect: "NextVisitScheduled", delivered: true },
  { name: "DetectDeviation", what: "超窗 → 生成方案偏离质量事件（I4）",
    context: "Quality", effect: "DeviationDetected", delivered: true },
  { name: "CreateSubjectPayment", what: "生成受试者补偿待发放单",
    context: "ClinicalOps", effect: "CompensationDue", delivered: true },
  { name: "MarkEdcPending", what: "置 EDC 待录入，起算 5 个工作日及时线",
    context: "ClinicalOps", effect: null, delivered: true },
  { name: "QueuePiConfirmation", what: "进入 PI 待确认队列（I3）",
    context: "External", effect: null, delivered: true },

  /* 以下两条尚未交付。**它们不是被遗忘的，是被记着的。** */
  { name: "PostVisitTimesheet", what: "按费率卡生成工时与成本快照（I1 / I2）",
    context: "Timesheet & Cost", effect: "TimesheetPosted",
    delivered: false, pendingPhase: "Phase 4c" },
  { name: "RefreshProjections", what: "刷新入组漏斗、单中心 P&L、驾驶舱投影",
    context: "Analytics", effect: null,
    delivered: false, pendingPhase: "Phase 6" }
];

/** 完成访视时，尚未接上的订阅者 —— 进响应的 `pending` 字段，一线看得到。 */
export const pendingSubscribers = () =>
  VISIT_COMPLETED_SUBSCRIBERS.filter(s => !s.delivered);
