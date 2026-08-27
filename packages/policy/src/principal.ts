/* 全部 `import type`：这三个在本文件里只出现在类型位置。
   写成值导入会给这个包添一条它并不需要的运行时依赖 ——
   而"纯函数、可被前后端共用"正是它存在的前提。 */
import type { FieldKey, ROW_RULES, ACTION_KEYS } from "@sitedesk/contracts";

/* ════════════════════════════════════════════════════════════════════
   主体与判定所需的事实。
   **这个包不允许 import 任何 IO** —— 由 CI 的依赖图断言强制。
   纯函数是它能被前后端共用、也能被穷举测试的前提。
   ════════════════════════════════════════════════════════════════════ */

/* 行规则与动作权限**从契约派生**，不在这里手写第二份。
   手写那份曾经落后契约五个动作，而 guards.ts 里的 `as ActionKey`
   把编译期的抗议一并盖住了 —— 一个需要强制转换才能用的联合类型，
   基本可以断定它已经不对了。 */
export type RowRule = (typeof ROW_RULES)[number];
export type ActionKey = (typeof ACTION_KEYS)[number];

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
  /** 正在接手的中心 —— 交接单还没完成，正式派工还没转过来。
   *
   *  它和 `assignedSiteIds` **必须分开**：这是一段会自己过期的临时可见性
   *  （单子一完成或作废就没了），而派工是正式的。合成一个集合之后，
   *  "他为什么看得见这个中心"就再也答不出来了。 */
  handoverSiteIds: ReadonlySet<string>;
}

export const EMPTY_SCOPE: ScopeContext = {
  assignedSiteIds: new Set(), teamStudyIds: new Set(), handoverSiteIds: new Set()
};

/** 判定一个中心是否可见所需的四项事实 —— 与 app.site_visible() 的四个入参一一对应 */
export interface SiteFacts {
  id: string;
  tenantId: string;
  studyId: string;
  hospital: string;
  piAccountId: string | null;
}
