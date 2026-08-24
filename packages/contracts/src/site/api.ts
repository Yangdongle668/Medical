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
