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

/** body-parser 的 413。**按形状认，不按类型认** —— 那个类是它内部的，
 *  import 过来等于把一个私有实现钉进异常处理里。 */
function isTooLarge(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { status?: number; statusCode?: number; type?: string };
  return e.type === "entity.too.large" || e.status === 413 || e.statusCode === 413;
}

@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(err: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request & { requestId?: string }>();

    let code: ErrorCode = "internal";
    let extra: ProblemExtra = {};

    if (err instanceof ProblemException) { code = err.code; extra = err.extra; }
    /* ── 请求体超过解析上限 ────────────────────────────────────────
       body-parser 抛的 `PayloadTooLargeError` **不是 HttpException** ——
       它是一个带 `status = 413` / `type = 'entity.too.large'` 的普通
       Error，于是掉进最下面那个兜底分支，出口是一句「服务内部错误」。

       这一条原来碰不到（全仓库的请求体都远在 100 KB 以下）。上传受理
       意向函那条端点一开，它每天都会被走到 —— 而 500 教会用户的是重试，
       不是换一份小一点的文件。 */
    else if (isTooLarge(err)) {
      code = "validation-failed";
      extra = { detail:
        "请求体太大，超过了服务端的解析上限 —— " +
        "如果传的是文件，换一份小一点的（受理意向函的上限是 10 MB）。" };
    }
    else if (err instanceof HttpException) {
      const s = err.getStatus();
      code = s === 401 ? "unauthenticated" : s === 403 ? "forbidden-action"
           : s === 404 ? "not-found" : s === 429 ? "rate-limited"
           : s === 413 ? "validation-failed"
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
