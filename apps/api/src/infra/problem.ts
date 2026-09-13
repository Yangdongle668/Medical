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

/* ── 数据库说"不行"的那几种，都不该出口成 500 ────────────────────────
   pg 的约束违例是一个带 `code` 的普通 Error，落到兜底分支就是
   「服务内部错误」—— 而那句话教会用户的是**重试**，
   重试一万次结果都一样。

   这一条是被真事故逼出来的：CRC 登记递交立项材料时撞上一条**自己看不见的**
   受理记录（唯一约束按租户建，而行策略只放行看得见的那些），
   服务层的 pre-check 因此查回 0 行、一路放行，最后撞在约束上 → 500。
   那一次的根因在 acceptance.service 里补了（迁移 0049），
   但**同一个形状在别处还会再长出来**：每一条唯一约束、排他约束、
   CHECK 都是一次潜在的 500。

   所以这里兜一道：约束违例一律落 422，并把**约束名**说出来。
   约束名在这个仓库里就是文档（`acceptance_accepted_shape`、
   `site_assignment` 上那条 EXCLUDE…），运维看到它能直接定位；
   而**不带出 detail / 表名 / 列值** —— 那里面会有真实数据。 */
const PG_CONSTRAINT: Record<string, string> = {
  "23505": "有一条记录已经占住了这个值（唯一约束）",
  "23P01": "这一条和已有的记录在时间上重叠了（排他约束）",
  "23514": "这一行不满足一条数据约束（CHECK）",
  "23503": "引用了一条不存在的记录（外键）"
};
function pgConstraint(err: unknown): { title: string; name?: string } | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { code?: string; constraint?: string };
  const t = e.code ? PG_CONSTRAINT[e.code] : undefined;
  return t ? { title: t, ...(e.constraint ? { name: e.constraint } : {}) } : null;
}

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
    else if (pgConstraint(err)) {
      const k = pgConstraint(err)!;
      code = "invariant-violated";
      extra = {
        detail: `${k.title}。这不是一次可以重试成功的失败 —— 改一处再来。` +
          (k.name ? `（约束：${k.name}）` : ""),
        ...(k.name ? { invariant: k.name } : {})
      };
      /* **照样进日志。** 出口不再是 500，但它仍然是一处"服务层本该先拦下来"
         的地方：每一条走到这里的约束违例，都意味着某个 pre-check 漏了。 */
      emit("warn", "Problem",
        `约束违例出口成 422，但它本该在服务层被拦下：${k.name ?? "（未命名）"}`,
        { method: req.method, path: req.originalUrl.split("?")[0] });
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
