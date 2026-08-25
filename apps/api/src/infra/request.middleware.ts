import { Injectable, NestMiddleware, Inject } from "@nestjs/common";
import type { Request, Response, NextFunction } from "express";
import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { POOL } from "./db.js";
import { runInCtx, type RequestCtx } from "./ctx.js";
import { loadPrincipal } from "../auth/principal.loader.js";

/* ════════════════════════════════════════════════════════════════════
   每个请求：取连接 → BEGIN → 认证 → SET LOCAL app.account_id → 装载主体。

   为什么整个请求跑在一个事务里：
   RLS 靠 `SET LOCAL app.account_id` 生效，而 SET LOCAL 的作用域就是事务。
   用连接级 set_config 在连接池下是灾难 —— 一个请求设的身份会漏给下一个请求。

   为什么认证放在中间件而不是 Guard：
   Guard 在中间件之后运行，而装载主体本身就需要一个已经设好身份的连接。
   ════════════════════════════════════════════════════════════════════ */

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

@Injectable()
export class RequestMiddleware implements NestMiddleware {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  async use(req: Request & { ctx?: RequestCtx }, res: Response, next: NextFunction) {
    const client = await this.pool.connect();
    const c: RequestCtx = {
      requestId: randomUUID(), client, principal: null,
      scope: { assignedSiteIds: new Set(), teamStudyIds: new Set() },
      operationId: null, finalized: false
    };
    (req as Request & { requestId?: string }).requestId = c.requestId;
    req.ctx = c;

    /* 兜底：Guard 抛异常时拦截器不会运行，连接不能就这么泄漏出去 */
    const release = () => {
      if (c.finalized) return;
      c.finalized = true;
      client.query("ROLLBACK").catch(() => {}).finally(() => client.release());
    };
    res.on("close", release);

    try {
      await client.query("BEGIN");

      const auth = req.headers.authorization;
      const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
      if (token) {
        const { rows } = await client.query<{ id: string | null }>(
          "SELECT app.resolve_session($1) AS id", [sha256(token)]);
        const accountId = rows[0]?.id ?? null;
        if (accountId) {
          await client.query("SELECT set_config('app.account_id', $1, true)", [accountId]);
          const loaded = await loadPrincipal(client, accountId);
          c.principal = loaded.principal;
          c.scope = loaded.scope;
        }
      }
      runInCtx(c, () => next());
    } catch (e) {
      release();
      next(e);
    }
  }
}
