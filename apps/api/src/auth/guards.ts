import { CanActivate, ExecutionContext, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { canAct, type ActionKey } from "@sitedesk/policy";
import { allEndpoints } from "@sitedesk/contracts";
import { ctx } from "../infra/ctx.js";
import { ProblemException, forbidden } from "../infra/problem.js";

export const PUBLIC = "sitedesk:public";
export const Public = () => SetMetadata(PUBLIC, true);

/** operationId → 契约声明的动作权限。
 *
 *  **权限来自契约，不在控制器上另抄一遍。**
 *  两处各写一份的后果不是不一致告警，而是**静默失守**：
 *  契约上写了 action，控制器忘了加装饰器，端点就是敞开的，
 *  而所有测试都会照常通过 —— 因为没有任何一处会发现两边不一样。
 *  （这正是 ClinicalOps 交付时踩到的：契约写了 subjRead，QA 照样拉得出名册。） */
const ACTION_OF = new Map<string, ActionKey>(
  allEndpoints().filter(e => e.action).map(e => [e.id, e.action as ActionKey]));

/** 契约里声明了动作权限的端点集合 —— 供架构测试反查。 */
export const contractActions = (): ReadonlyMap<string, ActionKey> => ACTION_OF;

export const OPERATION = "sitedesk:operation";
/** 契约里的 operationId。审计与幂等都按它归类。 */
export const Operation = (id: string) => SetMetadata(OPERATION, id);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(x: ExecutionContext): boolean {
    const c = ctx();
    c.operationId = this.reflector.getAllAndOverride<string>(
      OPERATION, [x.getHandler(), x.getClass()]) ?? null;

    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, [x.getHandler(), x.getClass()]))
      return true;
    if (!c.principal) throw new ProblemException("unauthenticated", {
      detail: "缺少或已失效的会话令牌" });
    return true;
  }
}

@Injectable()
export class ActionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(x: ExecutionContext): boolean {
    /* AuthGuard 先跑，已把 operationId 放进请求上下文 */
    const op = ctx().operationId;
    const need = op ? ACTION_OF.get(op) : undefined;
    if (!need) return true;
    const p = ctx().principal;
    if (!p || !canAct(p, need)) throw forbidden(need);
    return true;
  }
}
