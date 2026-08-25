import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { Observable, map } from "rxjs";
import { fieldGates } from "@sitedesk/contracts";
import { maskFields } from "@sitedesk/policy";
import { ctx } from "./ctx.js";

/* ════════════════════════════════════════════════════════════════════
   列维度脱敏 —— 在**序列化层**做，而不是让每个 service 自己记得删字段。

   放在这里的理由：service 里做，就意味着新写一个接口的人必须记得做；
   忘一次就是一次泄漏，而且不会有任何报错。
   放在出口处统一做，忘不了。
   ════════════════════════════════════════════════════════════════════ */
@Injectable()
export class MaskInterceptor implements NestInterceptor {
  private readonly gates = fieldGates();

  intercept(_: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map(body => {
      const p = ctx().principal;
      return p ? maskFields(p, this.gates, body) : body;
    }));
  }
}
