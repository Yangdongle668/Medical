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
export const SIDE_EFFECT_TYPES = [
  "TimesheetPosted",     // 记了一条工时
  "CostPosted",          // 成本归集到了某个中心
  "CompensationDue",     // 产生一笔待发放的受试者补偿
  "DeviationDetected",   // 生成了方案偏离质量事件
  "QualityEventOpened",  // 生成了其他质量事件
  "NextVisitScheduled",  // 按 SOA 生成了下一次访视窗口
  "SubjectEnrolled",     // 受试者由筛选期转为已入组
  "MilestoneReached",    // 里程碑达成，进入待开票队列
  "EthicsTaskCreated",   // 生成了伦理递交待办
  "SiteStateChanged"     // 中心状态机推进
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
