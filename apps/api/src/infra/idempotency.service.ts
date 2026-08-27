import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { ctx } from "./ctx.js";
import { ProblemException } from "./problem.js";

/* ════════════════════════════════════════════════════════════════════
   幂等 —— CRC 离线重放的生命线。

   在地下室提交一次访视，信号断了，客户端重发。
   不能记两笔工时、不能生成两条方案偏离、不能发两次受试者补偿。

   四种情形（第 ④ 条是补上的一个真洞，见下）：
     ① 同键 + 同请求体 + 已完成 → 直接返回上次的结果
     ② 同键 + 同请求体 + 进行中 → 409（另一个请求正在处理，让客户端稍后重试）
     ③ 同键 + 不同请求体      → 409。这是客户端 bug，必须报错，
                                 静默返回上一次的结果会让人以为新操作成功了
     ④ 同键 + **不同端点**    → 409。

   `endpoint` 这一列一直记着，却从来没有被比对过，而 begin() 查行只用
   (key, account_id)。于是只要两个端点碰巧哈希出同样的载荷，
   一把钥匙就真的开了另一扇门：

     completeStartupItem  载荷 { id }   动作权限：无
     completeHandover     载荷 { id }   动作权限：无

   同一个人把启动清单项的 id 拿去调交接完成、复用同一把键 —— 哈希一致、
   已完成，于是在**处理器跑起来之前**就返回了上一次的响应体。
   实测：本该 404 的请求返回 201，body 是那条清单项。

   表注释里本来就写着「request_hash 用于识别『同一把钥匙开不同的门』」——
   但 request_hash 比的是请求体，比不了门。现在门也比。
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
      endpoint: string; request_hash: string;
      response_status: number | null; response_body: unknown;
      completed_at: Date | null;
    }>(`SELECT endpoint, request_hash, response_status, response_body, completed_at
          FROM idempotency_key WHERE key = $1 AND account_id = $2`, [key, p.accountId]);

    const row = existing.rows[0];
    if (row) {
      /* 先比门，再比请求体。顺序有意义：门不对的时候，请求体一致
         恰恰是最危险的情形 —— 它会安安静静地返回另一个操作的结果。 */
      if (row.endpoint !== endpoint)
        throw new ProblemException("idempotency-key-reused", {
          detail: `这把幂等键已经用在端点「${row.endpoint}」上了，不能再用于「${endpoint}」。` +
            "一把键只对应一次操作 —— 换一个操作请生成新键。" });
      if (row.request_hash !== h)
        throw new ProblemException("idempotency-key-reused", {
          detail: "同一个幂等键被用于不同的请求体。这通常是客户端复用了键，请为新操作生成新键。" });
      if (!row.completed_at)
        throw new ProblemException("conflict-version", {
          detail: "同一请求正在处理中，请稍后重试" });
      /* status 交给调用方去比对（见 infra/command.ts）：响应码本身由路由
         元数据决定，这里返回它是为了让"端点改过状态码"这件事被发现。 */
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
