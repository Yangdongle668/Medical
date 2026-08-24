import { CanActivate, ExecutionContext, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { canAct, type ActionKey } from "@sitedesk/policy";
import { ctx } from "../infra/ctx.js";
import { ProblemException, forbidden } from "../infra/problem.js";

export const PUBLIC = "sitedesk:public";
export const Public = () => SetMetadata(PUBLIC, true);

export const ACTION = "sitedesk:action";
/** 声明本端点需要的动作权限。**服务端强制**，与前端是否隐藏按钮无关。 */
export const RequireAction = (a: ActionKey) => SetMetadata(ACTION, a);

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
    const need = this.reflector.getAllAndOverride<ActionKey>(
      ACTION, [x.getHandler(), x.getClass()]);
    if (!need) return true;
    const p = ctx().principal;
    if (!p || !canAct(p, need)) throw forbidden(need);
    return true;
  }
}
