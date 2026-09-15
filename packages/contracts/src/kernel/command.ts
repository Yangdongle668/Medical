import { z } from "zod";
import { Uuid, CentsNonNeg, IdempotencyKey } from "./primitives.js";

/* ════════════════════════════════════════════════════════════════════
   L2 命令层信封 —— 本阶段冻结的核心契约。
   M3（钱）依赖它才能验证「访视完成 → 成本归集」的闭环，
   所以它必须先于 ClinicalOps 的具体实现定下来。

   为什么需要命令层而不是 REST 的 PATCH：
   「完成一次访视」一次性触发七件事 —— 记工时、归集成本、生成受试者补偿、
   超窗则生成方案偏离、转 PI 确认、推进 seq、按 SOA 生成下一次窗口。
   拆成七个 REST 调用，任何一个失败都会留下不一致的状态。
   ════════════════════════════════════════════════════════════════════ */

/**
 * 副作用类型。**这是契约的一部分，不是调试信息。**
 *
 * 一线提交后必须立刻知道「这次操作还顺带生成了一条方案偏离」——
 * 否则他会以为自己只是打了个卡，而系统已经替他记下了一次质量事件。
 *
 * 演进规则（写进 CI 门禁）：
 *   · 新增一个 type 是**非破坏性**的 —— 客户端必须忽略不认识的 type
 *   · 修改或删除已有 type 的字段是**破坏性**的
 */
/* ── 这张表曾经只有十四条，而服务端在发四十三种 ────────────────────
   补登这一版之前，`apps/api` 里有 **26 个 type 字面量不在这张表里** ——
   五条数据质疑、四条监查访视、三条内部稽查、三条立项、两条投递通道…
   一路长到了这张表之外。

   它不报错，因为响应不按这个枚举校验；枚举又声明了 `x-extensible`
   （「客户端必须忽略不认识的 type」），所以连拿 OpenAPI 做校验的
   调用方也只是**静静地丢掉那一条**。症状是少了一句话，不是一次失败。

   而少的那句话恰恰是本文件开头说的那件事：「这次操作还顺带生成了
   一条方案偏离」。一个只认得十四种 type 的前端，遇到
   `DataQueryRaised` 时画不出任何东西 —— 提质疑的人按完按钮，
   屏幕上什么也没说。

   `tools/arch-check.mjs` 现在反查：服务层里写出来的每一个
   side effect 的 type 字面量，都必须在这张表里。 */
export const SIDE_EFFECT_TYPES = [
  /* ── 临床作业 ──────────────────────────────────────────────────── */
  "TimesheetPosted",     // 记了一条工时
  "TimesheetApproved",   // 工时获批，成本随之落到中心上
  "CostPosted",          // 成本归集到了某个中心
  "CompensationDue",     // 产生一笔待发放的受试者补偿
  "DeviationDetected",   // 生成了方案偏离质量事件
  "SaeReportedLate",     // SAE 超过 24 小时才报 —— 这是要上报的事
  "QualityEventOpened",  // 生成了其他质量事件
  "CapaPlanned",         // 质量事件有了整改措施与责任人
  "NextVisitScheduled",  // 按 SOA 生成了下一次访视窗口
  "SoaRevised",          // 访视计划表改版 —— 在途受试者的窗口跟着变
  "SubjectEnrolled",     // 受试者由筛选期转为已入组
  /* 做完 SOA 上的全部访视 → 出组。**`completed` 此前是个到不了的状态**：
     契约定义了它、漏斗专门数它，而没有一行代码写它，于是「已出组」永远是 0。 */
  "SubjectCompleted",    // 受试者做完整条 SOA，出组
  "SpecimenClosed",      // 样本链闭环（收 / 存 / 运 / 到达都有记录）
  "CloseoutApproved",    // 结题报告获批 —— 中心关闭的最后一项前置

  /* ── 数据质疑 ──────────────────────────────────────────────────── */
  "DataQueryRaised",     // 提了一条质疑
  "DataQueryAnswered",   // 中心回了一条质疑
  "DataQueryReturned",   // 回答不成立，退回中心重答
  "DataQueryChased",     // 逾期未回，催了一次
  "DataQueryClosed",     // 质疑关闭

  /* ── 监查与稽查 ────────────────────────────────────────────────── */
  "MonitorVisitPlanned",    // 排了一次监查访视
  "MonitorVisitPerformed",  // 监查访视执行完毕
  "MonitorVisitConfirmed",  // 中心确认监查访视已发生
  "MonitorReportSubmitted", // 监查报告递交，跟进项随之生成
  "InternalAuditOpened",    // 开了一次内部稽查
  "AuditFindingAdded",      // 稽查发现项落账
  "AuditFindingClosed",     // 稽查发现项关闭

  /* ── 立项 · 受理 · 商务 ────────────────────────────────────────── */
  "IntakeSubmitted",     // 递了一份立项申请
  "IntakeApproved",      // 立项获批 —— 项目建档，归到提交人所在的组
  "IntakeReturned",      // 立项被退回
  "SiteAccepted",        // 机构予以受理
  "AcceptanceAmendRequested", // 机构发出补正通知，缺的那几份已列名
  "EthicsTaskCreated",   // 生成了伦理递交待办
  "SiteStateChanged",    // 中心状态机推进
  "FeasibilityOverride", // 评分不够却入选了一个候选中心 —— 理由已入审计
  "FeasibilityBias",     // 实际入组与当初预测差得离谱 —— 评分口径该校准了
  "BidDecided",          // 开标结果回写，且价格偏差值得一看
  "ScopeCreepRecorded",  // 一张变更单没要到钱 —— 那部分工作量白做了
  "MilestoneReached",    // 里程碑达成，进入待开票队列

  /* ── 谁看得见什么 ──────────────────────────────────────────────────
     这一组不是业务事件的副产品，**它们就是权限本身在动**。
     点完那一下必须当场被告知，否则他不会知道自己刚给谁开了门。 */
  "StudyTeamChanged",       // 项目换了承接组 —— 原来那个组的 PM 当场看不见它
  "SiteAssignmentChanged",  // 派工或 PI 变了 —— 那个人的可见中心当场增减
  "AccountEnabled",         // 账号重新启用 —— 他又能登进来了
  /* 名册那一行 —— 它不改可见范围，但决定这个人**存不存在于名单上**：
     没有它，派工的下拉里没有他、填工时被拒、备案名册上也没有他。 */
  "StaffRecordChanged",     // 登记或修改了员工名册（工种 / 级别 / 城市 / 证书）

  /* ── 系统配置 ──────────────────────────────────────────────────── */
  "StartupTemplateReplaced", // 发布了新一版启动清单模板（只对此后建档的中心生效）
  "MailTransportChanged",    // 换了投递通道 —— 登录链接从此走另一台服务器
  "MailTransportTested"      // 试发了一封，结果在响应里
] as const;
export const SideEffectType = z.enum(SIDE_EFFECT_TYPES).meta({
  id: "SideEffectType",
  "x-extensible": true,
  description:
    "副作用类型。**新增取值是非破坏性变更** —— 客户端必须忽略不认识的 type。" +
    "破坏性变更门禁据此放行本枚举的新增。"
});

export const SideEffect = z.object({
  type:       SideEffectType,
  /** 面向人的一句话。前端直接展示，不需要自己拼文案。 */
  summary:    z.string(),
  /** 被创建或改变的对象 id，供前端跳转 */
  ref:        Uuid.optional(),
  /** 涉及金额时给出（分）。例如成本归集、补偿、里程碑 */
  amountCents: CentsNonNeg.optional(),
  /** 涉及中心时给出，供前端定位 */
  studySiteId: Uuid.optional()
}).meta({
  id: "SideEffect",
  description: "命令执行时被连带触发的领域事件。客户端必须忽略不认识的 type。"
});

/** 命令响应信封：主体 + 副作用清单 */
export const commandResult = <T extends z.ZodType>(data: T) =>
  z.object({
    data,
    sideEffects: z.array(SideEffect)
      .describe("本次命令连带触发的事件。为空数组表示没有连带影响。")
  });

/** 所有 L2 命令共有的请求头 */
export const CommandHeaders = z.object({
  "idempotency-key": IdempotencyKey
});

/** 需要留痕原因的命令（停用账号、修改关键日期、调整权限）共用这个片段。
 *  审计的第四个 W —— 为什么 —— 最容易被省掉，所以由契约强制。 */
export const WithReason = z.object({
  reason: z.string().trim().min(4).max(500)
    .describe("变更原因。会写入审计轨迹；核查时真正被问的就是这一栏。")
});

export type SideEffect = z.infer<typeof SideEffect>;
