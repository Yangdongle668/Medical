import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { Observable, catchError, tap, throwError } from "rxjs";
import { ctx } from "./ctx.js";

/** 处理成功则提交，抛错则回滚。中间件里的 res.on("close") 是最后一道兜底。 */
@Injectable()
export class TxInterceptor implements NestInterceptor {
  intercept(_: ExecutionContext, next: CallHandler): Observable<unknown> {
    const c = ctx();
    const done = async (ok: boolean) => {
      if (c.finalized) return;
      c.finalized = true;
      try { await c.client.query(ok ? "COMMIT" : "ROLLBACK"); }
      finally { c.client.release(); }
    };
    return next.handle().pipe(
      tap({ next: () => void done(true) }),
      catchError(err => { void done(false); return throwError(() => err); })
    );
  }
}
