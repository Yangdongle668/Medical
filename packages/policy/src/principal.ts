import type { FieldKey } from "@sitedesk/contracts";

/* ════════════════════════════════════════════════════════════════════
   主体与判定所需的事实。
   **这个包不允许 import 任何 IO** —— 由 CI 的依赖图断言强制。
   纯函数是它能被前后端共用、也能被穷举测试的前提。
   ════════════════════════════════════════════════════════════════════ */

export type RowRule = "all" | "team" | "assigned" | "hospital" | "pi" | "none";
export type ActionKey =
  | "approve" | "closeQA" | "raiseQ" | "closeQ" | "advance" | "manage" | "bid" | "ethics";

export interface Principal {
  accountId: string;
  tenantId: string;
  login: string;
  roleCode: string;
  rowRule: RowRule;
  isExternal: boolean;
  /** 停用账号立刻失去一切范围，但记录仍在 —— 审计要能追溯到人 */
  active: boolean;
  teamId: string | null;
  /** 外部方所属机构（医院名）。row_rule=hospital 靠它 */
  orgRef: string | null;
  fields: readonly FieldKey[];
  actions: readonly ActionKey[];
  modules: readonly string[];
}

/** 行判定要用到的、与主体绑定的事实。由查询层一次性装载。 */
export interface ScopeContext {
  /** 当前有效的派工（effective @> today） */
  assignedSiteIds: ReadonlySet<string>;
  /** 本组承接的项目 */
  teamStudyIds: ReadonlySet<string>;
}

export const EMPTY_SCOPE: ScopeContext = {
  assignedSiteIds: new Set(), teamStudyIds: new Set()
};

/** 判定一个中心是否可见所需的四项事实 —— 与 app.site_visible() 的四个入参一一对应 */
export interface SiteFacts {
  id: string;
  tenantId: string;
  studyId: string;
  hospital: string;
  piAccountId: string | null;
}
