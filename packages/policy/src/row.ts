import type { Principal, ScopeContext, SiteFacts, StudyFacts } from "./principal.js";

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

/* ════════════════════════════════════════════════════════════════════
   项目范围 —— 与 study_scope 策略（迁移 0005，0041 改）逐行等价。

   **它不是「有没有一个可见的中心」的同义词，而这正是它必须单独存在
   的理由。** 那个写法有一个它自己答不出来的问句：

     一个刚刚批下来、还一个中心都没有的项目，谁看得见？

   答案是"没有人"—— EXISTS 在空集上恒为假。于是新项目从诞生那一刻
   起就不在项目列表里，而**建中心、登记可行性、递交立项材料、
   提合同变更这四个表单，第一栏全都是「选项目」**：
   项目要有中心才看得见，中心要先选中项目才建得出来。
   这不是权限收紧，是一个死锁 —— 系统里永远只剩得下 seed 灌进去的项目。

   数据库那份策略里 `row_rule = 'all'` 的短路一直是对的（迁移 0005），
   漏掉它的是应用层手写的那句 WHERE。两处不一致时，
   更严的那一处赢 —— 于是 boss 和管理员也一起被锁在外面。

   ── team 这一条为什么要直接问 team_study ────────────────────────
   `team_study` 的定义就是"本组承接的项目"，它挂在**项目**上，
   与中心无关。绕道 study_site 去问同一件事，在有中心时答案相同，
   在没有中心时答案是错的 —— 而"还没有中心"恰恰是项目组最需要
   看见它的那一段时间：可行性调查是在建中心之前做的。

   ── assigned / hospital / pi 保持原样 ───────────────────────────
   这三条的范围本来就由中心定义（派工、本院、本人担任 PI）。
   一个还没有中心的项目对他们确实还不存在，这不是死锁：
   等中心建出来、派工下来，它自然出现。
   ════════════════════════════════════════════════════════════════════ */

export function canSeeStudy(p: Principal, ctx: ScopeContext, study: StudyFacts,
                            sites: readonly SiteFacts[]): boolean {
  if (!p.active) return false;
  if (study.tenantId !== p.tenantId) return false;

  switch (p.rowRule) {
    case "all":  return true;
    case "none": return false;
    case "team": return p.teamId !== null && ctx.teamStudyIds.has(study.id);
    /* 其余三条经由中心 —— 与 SQL 那一支的 EXISTS 同一句话 */
    default:     return sites.some(s => s.studyId === study.id && canSeeSite(p, ctx, s));
  }
}

export function studyScopeSql(p: Principal, alias = "st", start = 1): ScopeSql {
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
        WHERE ts.study_id = ${alias}.id AND ts.team_id = ${$(p.teamId)})`, params: P };
    default: {
      /* 内层的参数编号要接着外层往下排 —— 这里错一位不会报错，
         只会安静地把别人的 tenant_id 当成 account_id 去比。 */
      const inner = siteScopeSql(p, "ss", start + P.length);
      P.push(...inner.params);
      return { sql: `${tenant} AND EXISTS (SELECT 1 FROM study_site ss
        WHERE ss.study_id = ${alias}.id AND ${inner.sql})`, params: P };
    }
  }
}
