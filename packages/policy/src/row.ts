import type { Principal, ScopeContext, SiteFacts } from "./principal.js";

/* ════════════════════════════════════════════════════════════════════
   行维度 —— 看得到哪些中心。

   **这是 app.site_visible() 的 TypeScript 孪生实现。**
   两处必须逐行等价：数据库那份是兜底（防裸 SQL），这份是主路径（查询层注入 + 前端收敛）。
   不一致就是数据泄漏，因此 test/parity.test.ts 用真实数据穷举比对两者。
   ════════════════════════════════════════════════════════════════════ */

export function canSeeSite(p: Principal, ctx: ScopeContext, site: SiteFacts): boolean {
  /* 与数据库一致的两道前置：停用账号无范围；跨租户一律不可见 */
  if (!p.active) return false;
  if (site.tenantId !== p.tenantId) return false;

  switch (p.rowRule) {
    case "all":      return true;
    case "none":     return false;
    case "team":     return p.teamId !== null && ctx.teamStudyIds.has(site.studyId);
    /* 正式派工，或者**正在接手** —— 后者是一段会自己过期的可见性：
       交接单完成/作废之后 handoverSiteIds 就空了（见迁移 0021）。
       与 app.site_visible() 的 'assigned' 分支一一对应。 */
    case "assigned": return ctx.assignedSiteIds.has(site.id)
                          || ctx.handoverSiteIds.has(site.id);
    case "hospital": return p.orgRef !== null && site.hospital === p.orgRef;
    case "pi":       return site.piAccountId !== null && site.piAccountId === p.accountId;
    default:         return false;
  }
}

export const visibleSites = <T extends SiteFacts>(
  p: Principal, ctx: ScopeContext, sites: readonly T[]
): T[] => sites.filter(s => canSeeSite(p, ctx, s));

/**
 * 查询层的范围注入。返回一个可直接拼进 WHERE 的片段与参数。
 *
 * 与 canSeeSite 同源同义：**改一处必须改另一处**，
 * parity 测试会同时比对 SQL 片段与内存判定的结果。
 */
export interface ScopeSql { sql: string; params: unknown[] }

export function siteScopeSql(p: Principal, alias = "s", start = 1): ScopeSql {
  const P: unknown[] = [];
  const $ = (v: unknown) => { P.push(v); return `$${start + P.length - 1}`; };

  if (!p.active) return { sql: "false", params: [] };
  const tenant = `${alias}.tenant_id = ${$(p.tenantId)}`;

  switch (p.rowRule) {
    case "all":
      return { sql: tenant, params: P };
    case "none":
      return { sql: "false", params: [] };
    case "team":
      if (!p.teamId) return { sql: "false", params: [] };
      return { sql: `${tenant} AND EXISTS (SELECT 1 FROM team_study ts
        WHERE ts.study_id = ${alias}.study_id AND ts.team_id = ${$(p.teamId)})`, params: P };
    case "assigned": {
      /* 两段，与 app.site_visible() 的 'assigned' 分支同一条判定：
         正式派工，或者正在接手（交接单还没完成）。 */
      const me = $(p.accountId);
      return { sql: `${tenant} AND (EXISTS (SELECT 1 FROM site_assignment sa
        WHERE sa.study_site_id = ${alias}.id AND sa.account_id = ${me}
          AND sa.effective @> CURRENT_DATE)
        OR EXISTS (SELECT 1 FROM handover h
             JOIN handover_site hs ON hs.handover_id = h.id
            WHERE hs.study_site_id = ${alias}.id AND h.to_account_id = ${me}
              AND h.status = 'pending'))`, params: P };
    }
    case "hospital":
      if (!p.orgRef) return { sql: "false", params: [] };
      return { sql: `${tenant} AND ${alias}.hospital = ${$(p.orgRef)}`, params: P };
    case "pi":
      return { sql: `${tenant} AND ${alias}.pi_account_id = ${$(p.accountId)}`, params: P };
    default:
      return { sql: "false", params: [] };
  }
}
