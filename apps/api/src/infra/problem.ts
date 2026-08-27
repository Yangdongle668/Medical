import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from "@nestjs/common";
import type { Request, Response } from "express";
import { ERRORS, ERROR_BASE, type ErrorCode } from "@sitedesk/contracts";
import { emit } from "./log.js";

/* ════════════════════════════════════════════════════════════════════
   RFC 9457 Problem Details —— 所有非 2xx 响应都是这个形状。
   ════════════════════════════════════════════════════════════════════ */

export interface ProblemExtra {
  detail?: string;
  issues?: { path: string; message: string }[];
  unmet?: { code: string; message: string; module?: string }[];
  invariant?: string;
}

export class ProblemException extends Error {
  constructor(readonly code: ErrorCode, readonly extra: ProblemExtra = {}) {
    super(extra.detail ?? ERRORS[code].title);
  }
}

/** 范围之外一律 404 —— 403 等于确认「它存在，只是你不能碰」，这个确认本身就是泄漏。 */
export const notFound = (what = "资源") =>
  new ProblemException("not-found", { detail: `${what}不存在` });
export const forbidden = (action: string) =>
  new ProblemException("forbidden-action", { detail: `当前角色无「${action}」动作权限` });

@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(err: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request & { requestId?: string }>();

    let code: ErrorCode = "internal";
    let extra: ProblemExtra = {};

    if (err instanceof ProblemException) { code = err.code; extra = err.extra; }
    else if (err instanceof HttpException) {
      const s = err.getStatus();
      code = s === 401 ? "unauthenticated" : s === 403 ? "forbidden-action"
           : s === 404 ? "not-found" : s === 429 ? "rate-limited"
           : s === 422 ? "validation-failed" : "internal";
      extra = { detail: err.message };
    } else {
      /* 未预期的异常：细节只进日志，不进响应体 —— 堆栈里常有连接串与内部路径。
         requestId 由 emit 从请求上下文里自动带上，于是响应体里那个 traceId
         和这条日志能对上 —— 用户报一个号，日志里就能捞出这一条堆栈。 */
      emit("error", "Problem", err instanceof Error ? err.stack ?? err.message : String(err),
        { method: req.method, path: req.originalUrl.split("?")[0] });
    }

    const { status, title } = ERRORS[code];
    /* 响应已经发出去了 —— 只可能是请求被截止时间收尾之后，卡住的处理器
       才醒过来抛了个错。再写一次会得到 ERR_HTTP_HEADERS_SENT，
       而那个异常抛在一个没人接的回调里，比原来的错误更难查。 */
    if (res.headersSent) return;
    res.status(status).type("application/problem+json").json({
      type: ERROR_BASE + code, title, status, code,
      ...(extra.detail ? { detail: extra.detail } : {}),
      instance: req.originalUrl,
      ...(req.requestId ? { traceId: req.requestId } : {}),
      ...(extra.issues ? { issues: extra.issues } : {}),
      ...(extra.unmet ? { unmet: extra.unmet } : {}),
      ...(extra.invariant ? { invariant: extra.invariant } : {})
    });
  }
}
