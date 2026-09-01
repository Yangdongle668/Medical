import { z } from "zod";
import { define } from "../kernel/registry.js";
import { Uuid, DateOnly, CentsNonNeg, QueryBool } from "../kernel/primitives.js";
import { PageQuery, page } from "../kernel/pagination.js";
import { commandResult, WithReason } from "../kernel/command.js";
import { Study, StudySite, SiteState, SiteGate } from "./model.js";

const CTX = "site";
const ById = z.object({ id: Uuid });

define({
  id: "listStudies", method: "get", path: "/v1/studies", layer: "L1", context: CTX,
  summary: "项目列表",
  description: "只返回本行范围内有中心的项目 —— 范围之外的项目不存在，不是「无权访问」。",
  query: PageQuery.extend({ q: z.string().max(64).optional() }),
  response: page(Study)
});

define({
  id: "listStudySites", method: "get", path: "/v1/study-sites", layer: "L1", context: CTX,
  summary: "中心台账",
  description:
    "行范围由登录身份推导：CRA 只看被指派的、PM 看本组承接项目下的、" +
    "机构办只看本院、PI 只看自己担任研究者的。\n" +
    "**调用方不能通过传参扩大范围**，只能在范围内再收窄。",
  query: PageQuery.extend({
    studyId: Uuid.optional(),
    state: z.array(SiteState).optional(),
    hospital: z.string().optional(),
    q: z.string().max(64).optional(),
    /** 只看「事后失效」的中心。见 StudySite.startupInvalidated —— 
     *  这是撤销启动清单项之后，那件事在台账上留下的唯一可查痕迹。 */
    startupInvalidated: QueryBool.optional()
  }),
  response: page(StudySite)
});

define({
  id: "getStudySite", method: "get", path: "/v1/study-sites/{id}", layer: "L1", context: CTX,
  summary: "中心详情",
  params: ById,
  response: StudySite
});

define({
  id: "createStudySite", method: "post", path: "/v1/study-sites", layer: "L1", context: CTX,
  summary: "中心建档", status: 201,
  description:
    "「已建档 / 合同中心数」的差值 = 合同里写了但还没进系统的中心：" +
    "它们的成本已经在发生，收入却挂不上号。建档滞后是早期成本失控最不显形的一种。",
  body: z.object({
    studyId: Uuid,
    code: z.string().min(1).max(64),
    hospital: z.string().min(1).max(128),
    dept: z.string().min(1).max(64),
    city: z.string().min(1).max(32),
    piName: z.string().min(1).max(64),
    piAccountId: Uuid.nullable().optional(),
    contracted: z.int().positive(),
    unitPriceCents: CentsNonNeg,
    startupFeeCents: CentsNonNeg.default(0),
    sivPlannedOn: DateOnly.nullable().optional()
  }),
  response: StudySite,
  errors: ["invariant-violated"]
});

define({
  id: "getSiteGate", method: "get", path: "/v1/study-sites/{id}/gate", layer: "L1", context: CTX,
  summary: "推进闸门预检",
  description:
    "在按钮点下去之前就告诉用户还差什么。前端用它决定按钮是否可用，" +
    "以及在旁边列出未满足项与「去处理」入口。",
  params: ById,
  query: z.object({ to: SiteState.optional().describe("缺省为状态机的下一节点") }),
  response: SiteGate
});

define({
  id: "advanceStudySite", method: "post", path: "/v1/study-sites/{id}:advance",
  layer: "L2", context: CTX, summary: "推进中心阶段", action: "advance",
  description:
    "**本系统 L2 命令层的样板。**\n\n" +
    "推进不是给一个字段赋值，而是断言一组前置条件已经成立：\n" +
    "· 推进到 siv：启动清单的阻塞项必须清零\n" +
    "· 推进到 closed：七项前置条件全部满足（在组受试者、未关闭质疑与质量事件、" +
    "药品数量平衡、回收药品已销毁、样本链闭环、补偿已发放且有凭证、结题报告已获批）\n\n" +
    "未满足时返回 422 `gate-not-satisfied`，`unmet` 里逐条说明还差什么、去哪里处理 —— " +
    "而不是一个被禁用的按钮。",
  params: ById,
  body: z.object({
    to: SiteState,
    /** **每一次推进都必填**，不只是 siv / closed。
     *
     *  这里曾写成"不可逆节点时必填"，而 `SENSITIVE_ACTIONS` 里
     *  `advanceStudySite` 是无条件敏感的 —— 契约与策略各说一套，
     *  症状是缺原因时返回 500 而不是 422：调用方被告知"服务坏了"，
     *  于是去重试、去看监控，唯独不会去补那一栏。
     *  以策略为准收口：中心状态机的每一次推进都是核查会问到的事实。 */
    reason: WithReason.shape.reason
  }),
  response: commandResult(StudySite),
  errors: ["gate-not-satisfied", "validation-failed",
    "conflict-version", "idempotency-key-reused"]
});

/* ════════════════════════════════════════════════════════════════════
   启动清单 · 人员 · 交接
   ════════════════════════════════════════════════════════════════════ */
import { StartupChecklist, StartupSummary, StartupItem, Staff, Handover, RoleKind, HandoverStatus,
  StartupTemplate, StartupTemplateItem }
  from "./staffing.js";

define({
  id: "getStartupChecklist", method: "get",
  path: "/v1/study-sites/{id}/startup-items", layer: "L1", context: CTX,
  summary: "中心启动清单",
  description:
    "8 类清单项，带负责人、应完成日与**阻塞项**标记。\n" +
    "阻塞项未清零，`POST /v1/study-sites/{id}:advance` 到 `siv` 会被闸门拦下。",
  params: ById,
  response: StartupChecklist
});

define({
  id: "listStartupChecklists", method: "get", path: "/v1/startup-checklists",
  layer: "L1", context: CTX,
  summary: "各中心的启动清单进度",
  description:
    "`getStartupChecklist` 的汇总形态，**不带逐项明细** ——\n" +
    "这一页问的是「哪几个中心卡住了」，不是「某个中心还差哪几项」。\n" +
    "带上 items 的话，15 个中心就是 15 × 16 项，而这一页一项都不画。\n\n" +
    "排序：先未完成的阻塞项数（降序），再距计划 SIV 的天数 ——\n" +
    "**启动慢一个月，这个中心的整条收入曲线右移一个月。**",
  query: PageQuery.extend({
    /** 只看还有阻塞项没清的。**默认不筛** —— 清完的也要看得见，
     *  否则"还有几个中心没启动"这个数在页面上凑不齐。 */
    blockedOnly: QueryBool.optional()
  }),
  response: page(StartupSummary)
});

define({
  id: "completeStartupItem", method: "post", path: "/v1/startup-items/{id}:complete",
  layer: "L2", context: CTX, summary: "标记启动清单项完成",
  description:
    "完成必须同时记下时间与人 —— 只记「做完了」而不记「谁做的」，核查时说不清。\n" +
    "若本次完成清空了最后一个阻塞项，`sideEffects` 会明确告知「可推进 SIV」。",
  params: ById,
  body: z.object({ note: z.string().max(500).optional() }),
  response: commandResult(StartupItem),
  errors: ["conflict-version", "idempotency-key-reused"]
});

define({
  id: "reopenStartupItem", method: "post", path: "/v1/startup-items/{id}:reopen",
  layer: "L2", context: CTX, summary: "撤销启动清单项的完成标记",
  description: "撤销是敏感动作：它可能让一个已经推进的中心回到「其实没准备好」的状态，必须写原因。",
  params: ById,
  body: WithReason,
  response: commandResult(StartupItem),
  errors: ["conflict-version", "idempotency-key-reused"]
});

define({
  id: "listStaff", method: "get", path: "/v1/staff", layer: "L1", context: CTX,
  summary: "人员与派工",
  description: "外部方看不到员工名册 —— 那与机构履行监管职责无关。",
  query: PageQuery.extend({
    roleKind: RoleKind.optional(),
    successionGap: QueryBool.optional().describe("只看「带多个中心却无继任者」的人"),
    /** 只看在职的。发起交接的候选人列表用它 ——
     *  停用的人出现在下拉里，选中之后是一次白跑：后端会拒，
     *  而界面上什么也说不出来。 */
    activeOnly: QueryBool.optional()
  }),
  response: page(Staff)
});

define({
  id: "listHandovers", method: "get", path: "/v1/handovers", layer: "L1", context: CTX,
  summary: "交接列表",
  query: PageQuery.extend({ status: HandoverStatus.optional() }),
  response: page(Handover)
});

define({
  id: "createHandover", method: "post", path: "/v1/handovers",
  layer: "L1", context: CTX, status: 201,
  summary: "发起交接",
  description:
    "休假、离职、调岗 —— 中心不会因此停下。\n" +
    "只能交接自己当前负责的中心；接手人必须是同工种的在职人员。",
  body: z.object({
    toAccountId: Uuid,
    studySiteIds: z.array(Uuid).min(1),
    reason: z.string().trim().min(5).max(500),
    plannedOn: DateOnly
  }),
  response: Handover,
  errors: ["invariant-violated"]
});

define({
  id: "completeHandoverItem", method: "post",
  path: "/v1/handovers/{id}/items/{seq}:done", layer: "L2", context: CTX,
  summary: "确认交接清单的某一项",
  description: "逐项确认，不是一次打勾了事 —— 交接单签了字但受试者没交底，等于没交接。",
  params: z.object({ id: Uuid, seq: z.coerce.number().int().min(0) }),
  body: z.object({}),
  response: commandResult(Handover),
  errors: ["idempotency-key-reused"]
});

define({
  id: "completeHandover", method: "post", path: "/v1/handovers/{id}:complete",
  layer: "L2", context: CTX, summary: "确认交接完成",
  description:
    "清单未逐项确认不得完成 —— 交接单签了字但受试者没交底，等于没交接。\n" +
    "完成时把派工从原负责人转到接手人，两边的行范围随即改变。\n\n" +
    "**一个中心都没转移就不算完成**：返回 422 `invariant-violated`" +
    "（`handover-must-move-assignments`），整笔请求回滚，状态留在 pending。\n" +
    "留下一个「已完成但什么也没发生」的交接单，比报错危险得多 —— " +
    "两个人都以为交完了，接手人一个中心也没拿到，" +
    "而原负责人的账号此刻已经可以停用了。",
  params: ById,
  body: z.object({}),
  response: commandResult(Handover),
  errors: ["gate-not-satisfied", "invariant-violated", "idempotency-key-reused"]
});

/* ── 启动清单模板（可配置，见迁移 0019） ─────────────────────────── */
define({
  id: "getStartupTemplate", method: "get", path: "/v1/startup-template",
  layer: "L1", context: "site",
  summary: "启动清单模板（当前版本）",
  response: StartupTemplate
});

define({
  id: "replaceStartupTemplate", method: "post", path: "/v1/startup-template:replace",
  layer: "L2", context: "site",
  summary: "发布新一版启动清单模板",
  description:
    "**整份替换，版本号加一，旧版本不删** —— 中心的 `startupTemplateVersion` " +
    "要指得回去，否则「这个中心当初是照着什么铺的」就没有答案。\n" +
    "只对**此后建档**的中心生效。",
  action: "manage",
  body: z.object({
    items: z.array(StartupTemplateItem).min(1).max(60),
    reason: z.string().trim().min(4).max(500)
  }),
  response: commandResult(StartupTemplate),
  errors: ["validation-failed", "idempotency-key-reused"]
});
