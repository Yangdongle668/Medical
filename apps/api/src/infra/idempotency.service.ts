import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { ctx } from "./ctx.js";
import { ProblemException } from "./problem.js";

/* ════════════════════════════════════════════════════════════════════
   幂等 —— CRC 离线重放的生命线。

   在地下室提交一次访视，信号断了，客户端重发。
   不能记两笔工时、不能生成两条方案偏离、不能发两次受试者补偿。

   三种情形：
     ① 同键 + 同请求体 + 已完成 → 直接返回上次的结果
     ② 同键 + 同请求体 + 进行中 → 409（另一个请求正在处理，让客户端稍后重试）
     ③ 同键 + 不同请求体      → 409。这是客户端 bug，必须报错，
                                 静默返回上一次的结果会让人以为新操作成功了
   ════════════════════════════════════════════════════════════════════ */
export interface Replayed { status: number; body: unknown }

@Injectable()
export class IdempotencyService {
  private hash = (v: unknown) =>
    createHash("sha256").update(JSON.stringify(v ?? null)).digest("hex");

  /** 返回上次结果表示应当重放；返回 null 表示这是首次，可以继续执行。 */
  async begin(key: string, body: unknown): Promise<Replayed | null> {
    const c = ctx();
    const p = c.principal!;
    const h = this.hash(body);
    const endpoint = c.operationId ?? "unknown";

    const existing = await c.client.query<{
      request_hash: string; response_status: number | null; response_body: unknown;
      completed_at: Date | null;
    }>(`SELECT request_hash, response_status, response_body, completed_at
          FROM idempotency_key WHERE key = $1 AND account_id = $2`, [key, p.accountId]);

    const row = existing.rows[0];
    if (row) {
      if (row.request_hash !== h)
        throw new ProblemException("idempotency-key-reused", {
          detail: "同一个幂等键被用于不同的请求体。这通常是客户端复用了键，请为新操作生成新键。" });
      if (!row.completed_at)
        throw new ProblemException("conflict-version", {
          detail: "同一请求正在处理中，请稍后重试" });
      return { status: row.response_status ?? 200, body: row.response_body };
    }

    await c.client.query(
      `INSERT INTO idempotency_key (key, account_id, endpoint, request_hash)
       VALUES ($1,$2,$3,$4)`, [key, p.accountId, endpoint, h]);
    return null;
  }

  async complete(key: string, status: number, body: unknown): Promise<void> {
    const c = ctx();
    await c.client.query(
      `UPDATE idempotency_key SET response_status = $3, response_body = $4, completed_at = now()
        WHERE key = $1 AND account_id = $2`,
      [key, c.principal!.accountId, status, JSON.stringify(body)]);
  }
}
