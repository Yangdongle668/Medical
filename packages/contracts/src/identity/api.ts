import { z } from "zod";
import { define } from "../kernel/registry.js";
import { Uuid, QueryBool } from "../kernel/primitives.js";
import { PageQuery, page } from "../kernel/pagination.js";
import { commandResult, WithReason } from "../kernel/command.js";
import { Account, Principal, Role, Team, AuditEntry, RowRule, ActionKey } from "./model.js";
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

/* ════════════════════════════════════════════════════════════════════
   「组织与权限」这一页要用的其余几个。

   在此之前 identity 只有五个端点，而它们凑不出一张能用的管理页：
   建了账号改不了角色、看不到有哪些分组、停用之后启用不回来、
   新建的内部账号没有任何进得去的办法（要有人上服务器跑脚本登记收件地址）。

   也就是说：管理员建得出人，建出来的人用不了。
   ════════════════════════════════════════════════════════════════════ */

define({
  id: "listTeams", method: "get", path: "/v1/teams", layer: "L1", context: CTX,
  summary: "分组",
  description:
    "PM 的行范围（`team`）就是从这里推导的 —— 分组不是通讯录上的标签，\n" +
    "是「这个人看得到哪些项目」的来源。所以建账号那一步必须挑得到它。",
  response: z.object({ items: z.array(Team) })
});

define({
  id: "createTeam", method: "post", path: "/v1/teams", layer: "L1", context: CTX,
  summary: "新建分组", action: "manage", status: 201,
  body: z.object({
    code: z.string().regex(/^[A-Za-z0-9-]{2,16}$/, "2–16 位字母 / 数字 / 连字符"),
    name: z.string().min(1).max(64),
    leadAccountId: Uuid.nullable().optional()
  }),
  response: Team,
  errors: ["validation-failed"]
});

define({
  id: "updateAccount", method: "patch", path: "/v1/accounts/{id}",
  layer: "L1", context: CTX, summary: "改账号的角色 / 分组 / 所属机构", action: "manage",
  description:
    "**改角色是权限变更**，写审计且 isSensitive=true —— 「谁把谁调成了什么」是核查必查项。\n\n" +
    "改成 `row_rule=hospital` 的角色而没有 orgRef，会被拦下：\n" +
    "那种账号登得进来却一行数据都看不到，而界面上没有任何东西说得出为什么。\n\n" +
    "登录名与姓名不在这里改：登录名是审计轨迹里的那个标识，改掉等于把历史记录指向别人。",
  params: ById,
  body: z.object({
    roleId: Uuid.optional(),
    teamId: Uuid.nullable().optional(),
    orgRef: z.string().max(128).nullable().optional()
  }).extend(WithReason.shape),
  response: Account,
  errors: ["invariant-violated", "not-found"]
});

define({
  id: "enableAccount", method: "post", path: "/v1/accounts/{id}:enable",
  layer: "L2", context: CTX, summary: "启用账号", action: "manage",
  description:
    "停用是可逆的 —— 请长假、借调、误停都会走到这里。\n" +
    "**但派工不会自己回来**：停用时交接出去的中心仍然在接手人名下，\n" +
    "要还回去得再发起一次交接。这条不是遗漏，是刻意的：\n" +
    "让派工随启用自动回滚，会把接手人这段时间做的事变成无主的。",
  params: ById,
  body: WithReason,
  response: commandResult(Account),
  errors: ["not-found", "conflict-version"]
});

define({
  id: "setAccountPassword", method: "post", path: "/v1/accounts/{id}:set-password",
  layer: "L1", context: CTX, summary: "给账号设一个初始口令", action: "manage",
  description:
    "新建的内部账号需要一条进得来的路。一次性链接要求先登记收件地址\n" +
    "（那要有人上服务器跑脚本），在通道配好之前，管理员当面给一个初始口令更实际。\n\n" +
    "设出来的口令**标成初始口令**：本人登录后顶上会挂一条改不掉的红条，\n" +
    "改掉之后才消失，而且翻不回去。管理员知道别人的口令是个短期状态，\n" +
    "这个标记是让它保持短期的唯一办法。\n\n" +
    "改自己的口令走 `changePassword`，那条要验旧口令；这条是管理员对别人，\n" +
    "验的是 `manage` 权限。**不能对自己用** —— 那等于绕过验旧口令那道门。",
  params: ById,
  body: z.object({ password: z.string().min(8).max(200) }).extend(WithReason.shape),
  status: 204,
  errors: ["not-found", "validation-failed"]
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
    sensitiveOnly: QueryBool.optional().describe("只看权限类变更"),
    since: z.iso.datetime({ offset: true }).optional()
  }),
  response: page(AuditEntry)
});
