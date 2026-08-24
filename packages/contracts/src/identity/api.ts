import { z } from "zod";
import { define } from "../kernel/registry.js";
import { Uuid } from "../kernel/primitives.js";
import { PageQuery, page } from "../kernel/pagination.js";
import { commandResult, WithReason } from "../kernel/command.js";
import { Account, Principal, Role, AuditEntry, RowRule, ActionKey } from "./model.js";
import { FieldKey } from "../kernel/fields.js";

const CTX = "identity";
const ById = z.object({ id: Uuid });

define({
  id: "getMe", method: "get", path: "/v1/me", layer: "L1", context: CTX,
  summary: "当前主体与权限",
  description:
    "前端启动时的第一个调用。导航、字段遮罩、按钮可用性全部由它驱动。\n" +
    "**前端不得自行推断权限** —— 它只负责按这里给的结果收敛 UI；服务端会独立再强制一次。",
  response: Principal
});

define({
  id: "listAccounts", method: "get", path: "/v1/accounts", layer: "L1", context: CTX,
  summary: "账号列表",
  description: "外部角色只看得到自己 —— 由行级安全强制，不靠调用方传参过滤。",
  query: PageQuery.extend({
    status: z.enum(["active", "disabled"]).optional(),
    roleCode: z.string().optional(),
    q: z.string().max(64).optional().describe("按姓名或登录名模糊匹配")
  }),
  response: page(Account)
});

define({
  id: "createAccount", method: "post", path: "/v1/accounts", layer: "L1", context: CTX,
  summary: "新增账号", action: "manage", status: 201,
  description:
    "不设密码：内部走 OIDC（企业微信 / 飞书），外部走一次性魔法链接。\n" +
    "row_rule=hospital 的角色必须同时给出 orgRef，否则账号能登录却一行数据都看不到。",
  body: z.object({
    login: z.string().regex(/^[a-z][a-z0-9_]{2,31}$/,
      "3–32 位小写字母 / 数字 / 下划线，且以字母开头"),
    displayName: z.string().min(1).max(64),
    roleId: Uuid,
    teamId: Uuid.nullable().optional(),
    orgRef: z.string().max(128).nullable().optional()
  }),
  response: Account,
  errors: ["invariant-violated"]
});

define({
  id: "disableAccount", method: "post", path: "/v1/accounts/{id}:disable",
  layer: "L2", context: CTX, summary: "停用账号", action: "manage",
  description:
    "停用不删除 —— 审计轨迹必须能追溯到人。\n" +
    "**仍带着中心的人不能直接停用**：必须先发起交接，否则那些中心会失去负责人而无人察觉。",
  params: ById,
  body: WithReason,
  response: commandResult(Account),
  errors: ["gate-not-satisfied", "conflict-version"]
});

define({
  id: "listRoles", method: "get", path: "/v1/roles", layer: "L1", context: CTX,
  summary: "角色与三维权限",
  response: z.object({ items: z.array(Role) })
});

define({
  id: "updateRolePermissions", method: "patch", path: "/v1/roles/{id}",
  layer: "L1", context: CTX, summary: "调整角色权限", action: "manage",
  description:
    "行 / 列 / 动作三个维度可分别调整，改完对该角色的所有账号**立即生效**。\n" +
    "每次调整都写审计，且 isSensitive=true —— 「谁给谁开了什么」是核查必查项。",
  params: ById,
  body: z.object({
    rowRule: RowRule.optional(),
    visibleFields: z.array(FieldKey).optional(),
    allowedActions: z.array(ActionKey).optional(),
    modules: z.array(z.string()).optional()
  }).extend(WithReason.shape),
  response: Role,
  errors: ["conflict-version"]
});

define({
  id: "listAuditEntries", method: "get", path: "/v1/audit-entries", layer: "L1", context: CTX,
  summary: "审计轨迹",
  description: "只追加、不可改删。外部方只看得到本院中心相关的条目。",
  query: PageQuery.extend({
    studySiteId: Uuid.optional(),
    actorLogin: z.string().optional(),
    targetType: z.string().optional(),
    targetId: z.string().optional(),
    sensitiveOnly: z.coerce.boolean().optional().describe("只看权限类变更"),
    since: z.iso.datetime({ offset: true }).optional()
  }),
  response: page(AuditEntry)
});
