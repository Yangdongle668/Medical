import { Injectable } from "@nestjs/common";
import { needsReason } from "@sitedesk/policy";
import { ctx } from "./ctx.js";

export interface AuditInput {
  action: string;
  targetType: string;
  targetId: string;
  before?: unknown;
  after?: unknown;
  studySiteId?: string | null;
  reason?: string | null;
}

/* ════════════════════════════════════════════════════════════════════
   审计写入 —— 与业务写在**同一个事务**里。
   分开写就会出现「业务成功、轨迹丢了」，而那正是核查时说不清的情形。
   ════════════════════════════════════════════════════════════════════ */
@Injectable()
export class AuditService {
  async write(input: AuditInput): Promise<void> {
    const c = ctx();
    const p = c.principal;
    const sensitive = c.operationId ? needsReason(c.operationId) : false;

    if (sensitive && !(input.reason && input.reason.trim().length >= 4))
      /* 数据库的 CHECK 也会拦，但在这里失败能给出更清楚的信息 */
      throw new Error(`敏感动作 ${c.operationId} 必须给出变更原因`);

    await c.client.query(
      `INSERT INTO audit_entry (actor_account_id, actor_login, actor_role_code,
         action, target_type, target_id, before_value, after_value,
         study_site_id, reason, is_sensitive)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [p?.accountId ?? null, p?.login ?? "system", p?.roleCode ?? "—",
       input.action, input.targetType, input.targetId,
       input.before === undefined ? null : JSON.stringify(input.before),
       input.after  === undefined ? null : JSON.stringify(input.after),
       input.studySiteId ?? null, input.reason ?? null, sensitive]);
  }
}
