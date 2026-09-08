import { z } from "zod";
import { ACTION_KEYS, ActionKey } from "../kernel/actions.js";
import { Uuid, Code, DateOnly, Timestamp, QueryBool } from "../kernel/primitives.js";
import { FieldKey } from "../kernel/fields.js";
import { PageQuery } from "../kernel/pagination.js";
import { WithReason } from "../kernel/command.js";

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

/** 分组的完整形态。**不是通讯录上的标签** —— PM 的行范围就是从它推导的，
 *  所以「这个组承接哪些项目」和「组里有几个人」是它的正题，不是附注。 */
export const Team = TeamRef.extend({
  lead: z.object({ id: Uuid, displayName: z.string() }).nullable()
    .describe("组长。为空是正常状态：新建的组还没定人。"),
  memberCount: z.number().int(),
  studyCount: z.number().int().describe("本组承接的项目数 —— 组员的行范围就是这些项目下的中心")
}).meta({ id: "Team" });

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
  lastLoginAt: Timestamp.nullable(),
  /* ── 这个账号进得来吗 ───────────────────────────────────────────
     建号建出来的是一个**还没有入口的**账号：登录链接只送到已登记的
     收件地址（auth_identity），而口令要有人当面给一次。两样都没有，
     这个人就进不来 —— 而在此之前界面上看不出这件事。

     更糟的是那条自助路会**假装成功**：没有收件地址时
     `POST /v1/auth/magic-link` 照样回 202「登录链接已发送」，
     服务端日志里写的却是「账号没有登记收件地址，未签发链接」。
     对外含糊是对的（防账号枚举），但管理员这一侧必须看得见真相。

     **这里只报收件地址，不报"设没设过口令"。** 第一版两个都报了，
     而 `auth_password` 的行级策略是 `account_id = app.current_account_id()`
     ——**严格只看得见自己那一行**。于是那个 EXISTS 对别人一律返回 false：
     台账上每个人都显示"进不来"，包括刚设过口令的那几个。
     查询不报错，页面不报错，只是答案是错的。

     那条策略是对的（口令行是这个系统里最敏感的东西，管理员也不该读），
     所以撤掉的是这个字段，不是那条策略。 */
  hasLoginAddress: z.boolean()
    .describe("登记过登录链接的收件地址（auth_identity, provider=magic-link）")
}).meta({ id: "Account" });

/**
 * 当前主体 —— 前端最重要的一个响应。
 * 导航、字段遮罩、按钮可用性全部由它驱动，**前端不得自行推断权限**。
 */
export const Principal = z.object({
  account: Account,
  /** 行范围的可读说明，如「4 个中心 · 4 个项目」。数量由服务端算，前端不重算。 */
  scopeLabel: z.string(),
  /* ── 这里曾经有一个 `visibleSiteIds` ──────────────────────────────
     「当前可见的中心 id 全集」。它是一颗定时炸弹：响应体随中心数线性
     变长，偏偏 /v1/me 是每次进应用都要打的那一个 —— 经营层在 1500 个
     中心的租户里会拿到一个六万字符的数组，只为了做一件服务端本来就会
     做的事（过滤）。四个阶段的已知问题都记着它。

     **删掉它是一次故意的破坏性变更**，门禁会拦下来（拦对了）：
     停发一个必填响应字段，对读它的客户端就是破坏，改成可选也一样。
     所以这里没有"温和"的走法，只有"说清楚"的走法 ——

       影响范围：仓库内零消费方（前端从未读过它，只有 MSW 的 mock 里
                 有一处，已一并删除）；系统尚未上线，无外部客户端。
       迁移方案：行范围过滤本来就由服务端强制，客户端不需要替代品。
                 确有需要时应当新增一个**分页**的中心列表端点，
                 而不是把全集塞回这个响应里。

     评审时请连着这段一起看：门禁在这次提交上会红一次，那正是它的用处。 */
  permissions: z.object({
    rowRule: RowRule,
    fields: z.array(FieldKey),
    actions: z.array(ActionKey),
    modules: z.array(z.string())
  }),
  /** 本人的登录方式现状。**只描述自己**，不泄漏别人有没有设口令。 */
  credentials: z.object({
    hasPassword: z.boolean()
      .describe("设过口令没有。false 是正常状态 —— 多数人只用一次性链接。"),
    passwordIsInitial: z.boolean()
      .describe(
        "还在用出厂口令（admin）。界面据此挂红条。" +
        "这个标记只能从 true 变 false —— 能被重新点亮的报警灯等于没有报警灯。")
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

/* ════════════════════════════════════════════════════════════════════
   请求体 —— **有名字，而且导出**。

   ── 为什么不写成 define() 里的匿名 z.object ────────────────────
   写在 `define({ body: z.object({…}) })` 里的话，schema 只活在注册表里，
   服务端拿不到它的类型；于是控制器只能照着**再抄一遍**，
   而抄的那份与这份并排放着，谁也不校验谁。

   这不是假想。`createAccount` 的登录名在这里写着：

       .regex(/^[a-z][a-z0-9_]{2,31}$/, "3–32 位小写字母 / 数字 / 下划线…")

   控制器抄的那份漏了第二个参数。校验逻辑一模一样，两边都拒同样的输入 ——
   **差的只是那句话**。于是管理员把登录名填成「周敏」时，收到的是
   `Invalid string: must match pattern /^[a-z][a-z0-9_]{2,31}$/`，
   而那几乎必然被读成"这功能坏了"。

   任何比对"是否拒绝"的测试都照样绿：错的不是判断，是说给人听的那半句。

   所以请求体在这里定义、在这里导出，控制器 import 它 ——
   与动作权限那一维同一条规矩（见 apps/api/src/auth/guards.ts 的 ACTION_OF）：
   **契约是唯一定义源，控制器不另抄一遍。**
   ════════════════════════════════════════════════════════════════════ */

/* `.meta({ id })` 沿用生成器原来给匿名对象起的名字（…Request）——
   导出名叫 …Body 是给 TS 用的，而组件名是**公开契约的一部分**：
   改掉它，照着 OpenAPI 生成客户端的人就得跟着改一遍，
   而请求体本身一个字节都没变。改名不是不能做，是不该顺手做。 */
export const CreateAccountBody = z.object({
  login: z.string().regex(/^[a-z][a-z0-9_]{2,31}$/,
    "3–32 位小写字母 / 数字 / 下划线，且以字母开头"),
  displayName: z.string().min(1).max(64),
  roleId: Uuid,
  teamId: Uuid.nullable().optional(),
  orgRef: z.string().max(128).nullable().optional(),
  /* 建号的同时给一个初始口令。**可选** —— 机构老师与 PI 走一次性链接
     那条路，本来就不该有口令。
     给了的话它和 `setAccountPassword` 走同一条：标记为初始口令，
     本人第一次登录被要求改掉，而且这个标记翻不回去。

     长度这一档在契约里挡一道，真正的口令策略（弱口令表、首尾空白）
     只有服务端一处实现 —— 抄一份到前端，两边迟早对不上，
     而对不上的那天没人知道该信哪一条。 */
  password: z.string().min(8, "口令至少 8 位").max(200, "口令最长 200 位")
    .optional()
    .describe("初始口令。不填就是不设 —— 那个人得靠一次性链接进来")
}).meta({ id: "CreateAccountRequest" });

export const UpdateAccountBody = z.object({
  roleId: Uuid.optional(),
  teamId: Uuid.nullable().optional(),
  orgRef: z.string().max(128).nullable().optional()
}).extend(WithReason.shape).meta({ id: "UpdateAccountRequest" });

export const SetAccountPasswordBody = z.object({
  password: z.string().min(8).max(200)
}).extend(WithReason.shape).meta({ id: "SetAccountPasswordRequest" });

export const CreateTeamBody = z.object({
  code: z.string().regex(/^[A-Za-z0-9-]{2,16}$/, "2–16 位字母 / 数字 / 连字符"),
  name: z.string().min(1).max(64),
  leadAccountId: Uuid.nullable().optional()
}).meta({ id: "CreateTeamRequest" });

export const UpdateRolePermissionsBody = z.object({
  rowRule: RowRule.optional(),
  visibleFields: z.array(FieldKey).optional(),
  allowedActions: z.array(ActionKey).optional(),
  modules: z.array(z.string()).optional()
}).extend(WithReason.shape).meta({ id: "UpdateRolePermissionsRequest" });

export const ListAccountsQuery = PageQuery.extend({
  status: z.enum(["active", "disabled"]).optional(),
  roleCode: z.string().optional(),
  q: z.string().max(64).optional().describe("按姓名或登录名模糊匹配")
});

export const ListAuditEntriesQuery = PageQuery.extend({
  studySiteId: Uuid.optional(),
  actorLogin: z.string().optional(),
  targetType: z.string().optional(),
  targetId: z.string().optional(),
  sensitiveOnly: QueryBool.optional().describe("只看权限类变更"),
  since: z.iso.datetime({ offset: true }).optional()
});

/** 登记 / 更换登录链接的收件地址。
 *
 *  **地址是写进去的，读不回来。** 台账上只报「登记过没有」
 *  （Account.hasLoginAddress）—— 管理员要判断的是"这个人自助进得来吗"，
 *  而把一屋子人的邮箱手机号铺在列表页上，是为了一个判断付了一整页的代价。
 *  登记错了就再登记一次，那也是这条命令唯一的用法。 */
/* 这里只管长度，**不重抄形状**：形状的唯一定义处是服务端的
   `app.set_login_address`（运维脚本走的同一个函数），它的 RAISE 原话
   会原样透出来。在这里再写一遍正则，两处迟早对不上，
   而对不上的那天没人知道该信哪一条。

   但长度这一条也得说人话 —— 光写 `.min(5)` 时，填「周敏」收到的是
   一句「请求参数不符合契约」，和登录名那次犯的是同一个错。 */
export const SetLoginAddressBody = z.object({
  address: z.string().trim()
    .min(5, "太短了 —— 这里填的是收链接的邮箱或手机号，不是姓名")
    .max(160, "最多 160 个字符")
    .describe("邮箱或手机号。形状由服务端的 app.set_login_address 校验")
}).extend(WithReason.shape).meta({ id: "SetLoginAddressRequest" });
