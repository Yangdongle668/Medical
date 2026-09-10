import { z } from "zod";
import { define } from "../kernel/registry.js";
import { Uuid, QueryBool } from "../kernel/primitives.js";
import { PageQuery, page } from "../kernel/pagination.js";
import { commandResult, WithReason } from "../kernel/command.js";
import { MailTransport, MailTestResult,
  SetMailTransportBody, TestMailTransportBody } from "./model.js";
import { Account, Principal, Role, Team, AuditEntry,
  CreateAccountBody, UpdateAccountBody, SetAccountPasswordBody,
  CreateTeamBody, UpdateRolePermissionsBody, ListAccountsQuery,
  ListAuditEntriesQuery, SetLoginAddressBody } from "./model.js";
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
  query: ListAccountsQuery,
  response: page(Account)
});

define({
  id: "createAccount", method: "post", path: "/v1/accounts", layer: "L1", context: CTX,
  summary: "新增账号", action: "manage", status: 201,
  description:
    "不设密码：内部走 OIDC（企业微信 / 飞书），外部走一次性魔法链接。\n" +
    "row_rule=hospital 的角色必须同时给出 orgRef，否则账号能登录却一行数据都看不到。",
  body: CreateAccountBody,
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
  body: UpdateRolePermissionsBody,
  response: Role,
  errors: ["conflict-version", "idempotency-key-reused"]
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
  body: CreateTeamBody,
  response: Team,
  errors: ["validation-failed", "idempotency-key-reused"]
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
  body: UpdateAccountBody,
  response: Account,
  errors: ["invariant-violated", "not-found", "idempotency-key-reused"]
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
  body: SetAccountPasswordBody,
  status: 204,
  errors: ["not-found", "validation-failed", "idempotency-key-reused"]
});

define({
  id: "setLoginAddress", method: "post", path: "/v1/accounts/{id}:set-login-address",
  layer: "L1", context: CTX, summary: "登记登录链接的收件地址", action: "manage",
  description:
    "一次性链接只送到**库里登记的**地址，不送到请求里带的那个 ——\n" +
    "否则 `magic-link` 这个公开端点就是一键账号接管。所以地址必须有一条路写进去。\n\n" +
    "在此之前那条路只有一个：上服务器跑 `deploy/login-address.sh`。\n" +
    "于是新建的账号**没有入口**：申请链接会得到一句「已发送」，" +
    "而服务端日志里写的是「没有登记收件地址，未签发」——\n" +
    "那个人一直等，没有人知道为什么。机构老师和 PI 恰恰是最该走链接这条路的人。\n\n" +
    "**能改地址等于能拿到那个人的登录链接。** 但管理员本来就能用 " +
    "`setAccountPassword` 接管任何账号，两者一样悄无声息 —— 所以这里不是新增了\n" +
    "一类能力，而是把一件已经能做的事**摆到会留痕的地方**：\n" +
    "`manage` 动作、进审计轨迹、标为敏感。与迁移 0026 对「管理员给自己加 subject 字段」\n" +
    "的处置同一条道理 —— **不是拦住他，是让这件事留下时间和人**。\n\n" +
    "一个账号只保留一个地址，再调一次就是更换。\n" +
    "地址已经登记给别的账号时**报错，不悄悄改绑** —— 那等于把那个人的入口转走。",
  params: ById,
  body: SetLoginAddressBody,
  status: 204,
  errors: ["not-found", "validation-failed", "invariant-violated", "idempotency-key-reused"]
});

define({
  id: "listAuditEntries", method: "get", path: "/v1/audit-entries", layer: "L1", context: CTX,
  summary: "审计轨迹",
  description: "只追加、不可改删。外部方只看得到本院中心相关的条目。",
  query: ListAuditEntriesQuery,
  response: page(AuditEntry)
});

/* ── 登录链接的投递通道 ──────────────────────────────────────────── */

define({
  id: "getMailTransport", method: "get", path: "/v1/mail-transport",
  layer: "L1", context: CTX, summary: "投递通道设置", action: "manage",
  description:
    "登录链接靠它送出去。在此之前只能改环境变量、重启进程 —— " +
    "也就是说**签发登录链接的权限等同于运维权限**。\n\n" +
    "**响应里没有口令**，只有 `secretSet: boolean`。一个能把口令读回来的" +
    "设置页，等于给每个管理员发了一份邮箱凭证，而他们要做的事" +
    "（改服务器、换发件人、试发一封）一件也不需要读它。\n\n" +
    "`source` 说清这份配置从哪儿来：`db` 是在页面上配的，`env` 是还在用" +
    "环境变量（开机那条路），`none` 是两处都没有 —— 那时链接照样签得出来，" +
    "但没有人收得到。",
  response: MailTransport
});

define({
  id: "setMailTransport", method: "post", path: "/v1/mail-transport:set",
  layer: "L2", context: CTX, summary: "改投递通道", action: "manage",
  description:
    "**敏感动作，必须写原因。** 换一台 SMTP 服务器，就是换一台机器去读" +
    "所有人的登录链接 —— 指向一台会记日志的中继，等于把每一个链接抄送一份。\n\n" +
    "口令三种意思分得开：**省略 = 不动已存的那一个**（改个端口不该被迫" +
    "重输口令），传空串 = 清掉，传值 = 换成新的。\n\n" +
    "服务器上没有 `SITEDESK_SECRET_KEY` 时**拒绝保存口令**并说清为什么 —— " +
    "而不是悄悄存明文。一份会进备份、进从库、进 dump 的明文口令，" +
    "比「这个功能暂时不能用」糟得多。",
  body: SetMailTransportBody,
  response: commandResult(MailTransport),
  errors: ["invariant-violated", "conflict-version", "idempotency-key-reused"]
});

define({
  id: "testMailTransport", method: "post", path: "/v1/mail-transport:test",
  layer: "L2", context: CTX, summary: "试发一封", action: "manage",
  description:
    "**配好了要能自己验一次。** 否则「配对了没有」这件事要等第一个真人" +
    "申请登录链接时才知道 —— 而没收到的那个人不会来报，他只会以为系统坏了。\n\n" +
    "收件人**不接受传入**，一律发给当前登录者自己登记的地址：" +
    "一个可以指定收件人的「试发」就是一个开放的转发器。\n\n" +
    "结果连同时间一起记在通道上（`lastTestAt` / `lastTestOk`），" +
    "页面据此显示「最近一次试发」。",
  body: TestMailTransportBody,
  response: commandResult(MailTestResult),
  errors: ["invariant-violated", "idempotency-key-reused"]
});
