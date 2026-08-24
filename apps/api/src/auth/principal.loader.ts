import type { PoolClient } from "pg";
import type { Principal, ScopeContext, RowRule, ActionKey } from "@sitedesk/policy";
import type { FieldKey } from "@sitedesk/contracts";

/* 装载主体与行判定所需的事实。一个请求只查一次。 */
export async function loadPrincipal(
  client: PoolClient, accountId: string
): Promise<{ principal: Principal; scope: ScopeContext }> {
  const { rows } = await client.query<{
    id: string; login: string; tenant_id: string; team_id: string | null;
    org_ref: string | null; is_external: boolean; status: string;
    role_code: string; row_rule: string;
    fields: string[]; actions: string[]; modules: string[];
  }>(`
    SELECT a.id, a.login, a.tenant_id, a.team_id, a.org_ref, a.is_external, a.status,
           r.code AS role_code, r.row_rule,
           coalesce((SELECT array_agg(rf.field_key) FROM role_field rf
                      WHERE rf.role_id = r.id AND rf.visible), '{}') AS fields,
           coalesce((SELECT array_agg(ra.action_key) FROM role_action ra
                      WHERE ra.role_id = r.id AND ra.allowed), '{}') AS actions,
           coalesce((SELECT array_agg(rm.module_key ORDER BY rm.sort_order) FROM role_module rm
                      WHERE rm.role_id = r.id), '{}') AS modules
      FROM account a JOIN role r ON r.id = a.role_id
     WHERE a.id = $1`, [accountId]);

  const a = rows[0];
  if (!a) throw new Error(`账号不存在或不可见：${accountId}`);

  const [assigned, teamStudies] = await Promise.all([
    client.query<{ study_site_id: string }>(
      `SELECT study_site_id FROM site_assignment
        WHERE account_id = $1 AND effective @> CURRENT_DATE`, [accountId]),
    a.team_id
      ? client.query<{ study_id: string }>(
          `SELECT study_id FROM team_study WHERE team_id = $1`, [a.team_id])
      : Promise.resolve({ rows: [] as { study_id: string }[] })
  ]);

  return {
    principal: {
      accountId: a.id, tenantId: a.tenant_id, login: a.login,
      roleCode: a.role_code, rowRule: a.row_rule as RowRule,
      isExternal: a.is_external, active: a.status === "active",
      teamId: a.team_id, orgRef: a.org_ref,
      fields: a.fields as FieldKey[],
      actions: a.actions as ActionKey[],
      modules: a.modules
    },
    scope: {
      assignedSiteIds: new Set(assigned.rows.map(r => r.study_site_id)),
      teamStudyIds: new Set(teamStudies.rows.map(r => r.study_id))
    }
  };
}
