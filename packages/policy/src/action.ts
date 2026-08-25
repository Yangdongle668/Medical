import type { Principal, ActionKey } from "./principal.js";

/* ════════════════════════════════════════════════════════════════════
   动作维度 —— 能对它做什么。
   看得到不等于能操作：QA 能关闭质量事件，CRC 看得到同一条但只能整改。
   ════════════════════════════════════════════════════════════════════ */

export const canAct = (p: Principal, a: ActionKey): boolean =>
  p.active && p.actions.includes(a);

/** 模块可见性只用于收敛导航，**不是安全边界** —— 安全边界是行/列/动作三维。 */
export const canModule = (p: Principal, m: string): boolean =>
  p.active && p.modules.includes(m);

/**
 * 必须留下变更原因的动作。
 * 审计的第四个 W —— 为什么 —— 最容易被省掉，所以由清单强制而不是靠自觉。
 * 核查员看到「访视目标日从 08-18 改成 08-25」，
 * 要问的从来不是"改了吗"，而是"为什么改"。
 */
export const SENSITIVE_ACTIONS = new Set<string>([
  "disableAccount",
  "enableAccount",
  "updateRolePermissions",
  "changeAccountRole",
  "advanceStudySite",
  "updateVisitTargetDate",
  "overrideFeasibility",
  "voidTimesheet"
]);
export const needsReason = (operationId: string): boolean =>
  SENSITIVE_ACTIONS.has(operationId);
