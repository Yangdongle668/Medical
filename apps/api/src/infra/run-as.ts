import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { runInCtx, type RequestCtx } from "./ctx.js";
import { loadPrincipal } from "../auth/principal.loader.js";
import { emit } from "./log.js";
import { bizTz } from "./clock.js";

/* ════════════════════════════════════════════════════════════════════
   以某个账号的身份跑一段 —— 给**没有请求**的后台任务用。

   ── 为什么要有这个 ──────────────────────────────────────────────
   邮件提醒要知道「这个人现在手上有哪些急事」。那件事已经有一份答案：
   首页待办（InboxService），它按这个人的行范围、动作、列权限挑。
   另写一份「后台版」的话，两份迟早分叉 —— 提醒里说的和首页上看到的对不上。

   所以后台任务不绕过 RLS，而是**变成那个人**：与每个请求完全同一套步骤
   （取连接 → BEGIN → SET LOCAL app.account_id → 装载主体 → 放进上下文），
   只是没有 HTTP。行策略、动作判断、审计里记的主体，全都照常。

   提交之后跑 afterCommit 钩子 —— 通知就挂在那里（NotifyService.queue），
   与请求里「事务提交之后才发」同一个语义。
   ════════════════════════════════════════════════════════════════════ */

export async function runAs<T>(pool: Pool, accountId: string, job: string,
                               fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const c: RequestCtx = {
    requestId: `${job}:${randomUUID()}`, client, principal: null,
    scope: { assignedSiteIds: new Set(), teamStudyIds: new Set(), handoverSiteIds: new Set() },
    operationId: job, finalized: false, inFlight: true, queryCount: 0, dbless: false,
    afterCommit: []
  };
  let ok = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.account_id', $1, true)", [accountId]);
    await client.query("SELECT set_config('TimeZone', $1, true)", [bizTz()]);
    const loaded = await loadPrincipal(client, accountId);
    c.principal = loaded.principal;
    c.scope = loaded.scope;
    const out = await runInCtx(c, fn);
    await client.query("COMMIT");
    ok = true;
    return out;
  } finally {
    if (!ok) await client.query("ROLLBACK").catch(() => { /* 连接已坏，下面照样归还 */ });
    c.finalized = true; c.inFlight = false;
    client.release();
    if (ok) for (const h of c.afterCommit) {
      await h().catch(e => emit("error", job, "提交后的动作失败",
        { err: e instanceof Error ? e.message : String(e) }));
    }
  }
}
