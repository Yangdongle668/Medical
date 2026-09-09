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
 * 必须留下变更原因的动作 —— **这里放的是 operationId**。
 * 审计的第四个 W —— 为什么 —— 最容易被省掉，所以由清单强制而不是靠自觉。
 *
 * ── 这张表曾经有三条对不上任何端点 ────────────────────────────────
 * `changeAccountRole` / `overrideFeasibility` / `updateVisitTargetDate` ——
 * 契约里都没有这三个 id。`needsReason()` 是拿 operationId 去 Set 里查，
 * **查不到就返回 false，不报错**：于是「谁把谁调成了什么角色」写进了轨迹，
 * 却没被标成敏感，而审计页默认只看敏感那一档（AuditPage 的 useState(true)）——
 * 核查员打开的第一屏里根本没有它。
 *
 * 讽刺的是上面那句注释举的例子（访视目标日）就是三条死名字之一，
 * 而那个端点从来没建过。
 *
 * 现在由 `tools/arch-check.mjs` 逐条比对契约：写一个不存在的 id 立刻红。
 *
 * ── 有一类敏感不在这张表上 ────────────────────────────────────────
 * 「低分入选可行性」是**按负载判定**的：同一个 `decideFeasibility`，
 * 高分入选不必写理由，低于 65 分入选必须写。这种条件敏感表达不进
 * 一张按 operationId 查的表里 —— 由服务自己在写审计时显式标记
 * （`AuditInput.sensitive`，见 infra/audit.service.ts）。
 */
export const SENSITIVE_ACTIONS = new Set<string>([
  "disableAccount",
  "enableAccount",
  "updateAccount",          // 改角色 / 分组 / 所属机构 —— 原来写成了 changeAccountRole
  "updateRolePermissions",
  /* 这两条是**接管别人账号**的两条路，和停用账号同一档：
     能给别人设口令，就能以他的身份进来；能改收件地址，
     就能把他的一次性登录链接收到自己手里。两者的契约本来就要求写理由，
     缺的只是"标成敏感"这一下 —— 也就是核查员第一屏看不看得见。 */
  "setAccountPassword",
  "setLoginAddress",
  "advanceStudySite",
  "voidTimesheet"
]);
export const needsReason = (operationId: string): boolean =>
  SENSITIVE_ACTIONS.has(operationId);
