import { z } from "zod";
import { define } from "../kernel/registry.js";
import { Uuid, DateOnly, CentsNonNeg } from "../kernel/primitives.js";
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
    q: z.string().max(64).optional()
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
    /** 推进到 siv / closed 这类不可逆节点时必填 */
    reason: WithReason.shape.reason.optional()
  }),
  response: commandResult(StudySite),
  errors: ["gate-not-satisfied", "conflict-version", "idempotency-key-reused"]
});

/* ════════════════════════════════════════════════════════════════════
   启动清单 · 人员 · 交接
   ════════════════════════════════════════════════════════════════════ */
import { StartupChecklist, StartupItem, Staff, Handover, RoleKind, HandoverStatus }
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
    successionGap: z.coerce.boolean().optional().describe("只看「带多个中心却无继任者」的人")
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
    "完成时把派工从原负责人转到接手人，两边的行范围随即改变。",
  params: ById,
  body: z.object({}),
  response: commandResult(Handover),
  errors: ["gate-not-satisfied", "idempotency-key-reused"]
});
