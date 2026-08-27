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

  { name: "PostVisitTimesheet", what: "按费率卡生成工时与成本快照（I1 / I2）",
    context: "Timesheet & Cost", effect: "TimesheetPosted", delivered: true },

  /* 这一条挂了五个阶段，而它其实**一直是成立的** —— 只是没有人去确认。
     入组漏斗（getSiteFunnel）与单中心损益（getSitePnl）都是**读时计算**：
     直接从 subject / subject_visit / timesheet_entry 聚合，
     没有物化视图、没有投影表、没有缓存。于是"刷新"这个动作没有对象：
     事务一提交，下一次查询看到的就是新数字。

     这不等于可以把它从册子上划掉。两件事让它继续有意义：
     ① 下面的测试**实测**完成一次访视之后漏斗与损益真的动了 ——
        "读时计算所以自动刷新"如果没人验，它和一个 pending 标记一样空；
     ② 另一条测试断言库里**没有物化视图**。哪天有人为了性能加了一张
        投影表，这一条就重新变成真活 —— 而那时测试会先红，
        不会等到某个月的驾驶舱数字对不上才被发现。 */
  { name: "RefreshProjections", what: "刷新入组漏斗、单中心 P&L、驾驶舱投影",
    context: "Analytics", effect: null, delivered: true }
];

/** 完成访视时，尚未接上的订阅者 —— 进响应的 `pending` 字段，一线看得到。 */
export const pendingSubscribers = () =>
  VISIT_COMPLETED_SUBSCRIBERS.filter(s => !s.delivered);
