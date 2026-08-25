import { z } from "zod";
import { ACTION_KEYS, ActionKey } from "../kernel/actions.js";
import { Uuid, Code, DateOnly, Timestamp } from "../kernel/primitives.js";
import { FieldKey } from "../kernel/fields.js";

/* ════════════════════════════════════════════════════════════════════
   Identity & Access —— 权限是三维的：行 × 列 × 动作
   ════════════════════════════════════════════════════════════════════ */

/** 与数据库 row_rule 表一一对应 */
export const ROW_RULES = ["all", "team", "assigned", "hospital", "pi", "none"] as const;
export const RowRule = z.enum(ROW_RULES).meta({
  id: "RowRule",
  description:
    "行范围规则。all=全部｜team=本组承接的项目｜assigned=被指派的中心｜" +
    "hospital=本院承接的项目｜pi=本人担任研究者的中心｜none=无。" +
    "**由身份推导，绝不由用户选择。**"
});

/* 动作权限住在 kernel（registry 要用它给 action 定型），这里只作再导出，
   好让既有的 `from "./identity/model.js"` 与桶文件路径都不用改。 */
export { ACTION_KEYS, ActionKey };

export const AccountStatus = z.enum(["active", "disabled"]).meta({ id: "AccountStatus" });

export const RoleRef = z.object({
  id: Uuid, code: Code, name: z.string(), isExternal: z.boolean()
}).meta({ id: "RoleRef" });

export const Role = RoleRef.extend({
  rowRule: RowRule,
  /** 只列出 visible=true 的字段。**外部角色默认为空数组** —— 白名单加回，不是黑名单关掉。 */
  visibleFields: z.array(FieldKey),
  allowedActions: z.array(ActionKey),
  modules: z.array(z.string()).describe("可访问模块。收敛导航用，不是安全边界。")
}).meta({ id: "Role" });

export const TeamRef = z.object({
  id: Uuid, code: Code, name: z.string()
}).meta({ id: "TeamRef" });

export const Account = z.object({
  id: Uuid,
  login: z.string(),
  displayName: z.string(),
  role: RoleRef,
  team: TeamRef.nullable(),
  isExternal: z.boolean(),
  orgRef: z.string().nullable()
    .describe("外部方所属机构。row_rule=hospital 的账号必填，否则行范围为空。"),
  status: AccountStatus,
  joinedOn: DateOnly.nullable(),
  disabledAt: Timestamp.nullable(),
  disabledReason: z.string().nullable(),
  lastLoginAt: Timestamp.nullable()
}).meta({ id: "Account" });

/**
 * 当前主体 —— 前端最重要的一个响应。
 * 导航、字段遮罩、按钮可用性全部由它驱动，**前端不得自行推断权限**。
 */
export const Principal = z.object({
  account: Account,
  /** 行范围的可读说明，如「4 个中心 · 4 个项目」。数量由服务端算，前端不重算。 */
  scopeLabel: z.string(),
  visibleSiteIds: z.array(Uuid)
    .describe("当前可见的中心 id 全集。前端用于本地过滤；**服务端仍会独立强制一次**。"),
  permissions: z.object({
    rowRule: RowRule,
    fields: z.array(FieldKey),
    actions: z.array(ActionKey),
    modules: z.array(z.string())
  })
}).meta({ id: "Principal" });

export const AuditEntry = z.object({
  id: Uuid,
  at: Timestamp,
  actorLogin: z.string(),
  actorRoleCode: z.string().describe("当时的角色快照，不随后来改角色而变"),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  studySiteId: Uuid.nullable(),
  reason: z.string().nullable(),
  isSensitive: z.boolean()
}).meta({
  id: "AuditEntry",
  description: "只追加。四个 W：谁 / 何时 / 改了什么 / 为什么。第四个由约束强制。"
});
