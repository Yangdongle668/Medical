import { z } from "zod";
import { define } from "../kernel/registry.js";
import { Uuid, DateOnly, QueryBool } from "../kernel/primitives.js";
import { PageQuery, page } from "../kernel/pagination.js";
import { commandResult } from "../kernel/command.js";
import { MonitorVisit, MonitorKind, MonitorState, MonitorBoard } from "./model.js";

const CTX = "oversight";
const ById = z.object({ id: Uuid });

define({
  id: "listMonitorVisits", method: "get", path: "/v1/monitor-visits",
  layer: "L1", context: CTX,
  summary: "监查访视排期",
  description:
    "SIV 启动 · IMV 例行 · COV 关闭。默认按**计划日**排 —— " +
    "这一页是「接下来去哪」，不是「最近做了什么」。\n\n" +
    "对外部方整表关闭：一个机构办看得到我们打算什么时候去、抽多少比例，" +
    "等于把监查策略交给了被监查的一方。",
  query: PageQuery.extend({
    studySiteId: Uuid.optional(),
    kind: z.array(MonitorKind).optional(),
    state: z.array(MonitorState).optional(),
    /** 只看指派给我的 —— CRA 的默认视角。 */
    mine: QueryBool.optional(),
    /** 只看还没提交报告的。 */
    openOnly: QueryBool.optional()
  }),
  response: page(MonitorVisit)
});

define({
  id: "getMonitorBoard", method: "get", path: "/v1/monitor-visits/board",
  layer: "L1", context: CTX,
  summary: "监查计划与欠账",
  description:
    "**「监查频率来自风险分级，不是一刀切」这句话在这里被算了出来。**\n\n" +
    "输入是系统里已经有的质量信号（未关闭事件、SAE 超窗、质疑挂起、入组停滞），" +
    "输出是风险档、建议间隔、建议 SDV 抽样比例，**外加理由** —— " +
    "没有理由的建议值没人照着做，也没人能在核查时解释" +
    "「为什么这个中心只抽了 25%」。\n\n" +
    "另一半是欠账：逾期未监查的中心，和已经到过现场却压着没交的报告。",
  query: z.object({ studyId: Uuid.optional() }),
  response: MonitorBoard
});

define({
  id: "planMonitorVisit", method: "post", path: "/v1/monitor-visits",
  layer: "L1", context: CTX, status: 201,
  summary: "排一次监查访视",
  description:
    "跟进项**在排期时就写下来**，不是回来之后补 —— " +
    "「这次去要看什么」是出发前的决定，事后补的清单只会写成已经做过的事。\n\n" +
    "抽样比例可以不填：空表示「这次没有单独定过」，而不是默认 100%。",
  action: "monitor",
  body: z.object({
    studySiteId: Uuid,
    kind: MonitorKind,
    plannedOn: DateOnly,
    /** 不填就是排给自己 —— CRA 排自己的班是常态。 */
    monitorAccountId: Uuid.optional(),
    days: z.number().positive().max(30),
    sdvSamplePct: z.int().min(1).max(100).optional(),
    note: z.string().trim().max(500).optional(),
    items: z.array(z.string().trim().min(4).max(300)).min(1).max(30)
  }),
  response: commandResult(MonitorVisit),
  errors: ["invariant-violated", "idempotency-key-reused"]
});

define({
  id: "confirmMonitorVisit", method: "post", path: "/v1/monitor-visits/{id}:confirm",
  layer: "L2", context: CTX,
  summary: "与中心确认排期",
  description:
    "「待确认」和「已排期」的差别是**中心那边知不知道**。" +
    "确认日期落库 —— 否则「什么时候跟中心敲定的」没有答案，" +
    "而改期扯皮的时候要的正是这个日期。",
  action: "monitor",
  params: ById, body: z.object({}),
  response: commandResult(MonitorVisit),
  errors: ["invariant-violated", "idempotency-key-reused"]
});

define({
  id: "performMonitorVisit", method: "post", path: "/v1/monitor-visits/{id}:perform",
  layer: "L2", context: CTX,
  summary: "登记已到现场",
  description:
    "**到现场和交报告是两件事。** 登记到现场之后开始计报告时限 —— " +
    "在此之前它是「还没去」，在此之后它是「欠一份报告」，两种欠账要做的事不一样。",
  action: "monitor",
  params: ById,
  body: z.object({ performedOn: DateOnly.optional() }),
  response: commandResult(MonitorVisit),
  errors: ["invariant-violated", "idempotency-key-reused"]
});

define({
  id: "setMonitorItemDone", method: "post",
  path: "/v1/monitor-visits/{id}/items/{seq}:done",
  layer: "L2", context: CTX,
  summary: "勾掉（或撤回）一项跟进项",
  description:
    "报告提交之后跟进项**冻结** —— 交上去的报告和台账对不上，" +
    "比台账上少一项严重得多：核查时两份材料互相打脸。",
  action: "monitor",
  params: z.object({ id: Uuid, seq: z.coerce.number().int().min(0) }),
  body: z.object({ done: z.boolean() }),
  response: commandResult(MonitorVisit),
  errors: ["invariant-violated", "idempotency-key-reused"]
});

define({
  id: "submitMonitorReport", method: "post", path: "/v1/monitor-visits/{id}:report",
  layer: "L2", context: CTX,
  summary: "提交监查报告（MVR）",
  description:
    "**跟进项全部关闭之前提不了。** 拦的时候要说得出拦在哪几项 —— " +
    "一句「条件不满足」对要交报告的人没有任何用处。",
  action: "monitor",
  params: ById, body: z.object({}),
  response: commandResult(MonitorVisit),
  errors: ["invariant-violated", "idempotency-key-reused"]
});
