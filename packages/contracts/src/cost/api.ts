import { z } from "zod";
import { define } from "../kernel/registry.js";
import { Uuid, DateOnly, CentsNonNeg, QueryBool } from "../kernel/primitives.js";
import { PageQuery, page } from "../kernel/pagination.js";
import { commandResult, WithReason } from "../kernel/command.js";
import { RateCard, RoleKindForRate, TimesheetEntry, WorkType, SitePnl, SitePnlTrend } from "./model.js";

const CTX = "cost";
const ById = z.object({ id: Uuid });

define({
  id: "listTimesheets", method: "get", path: "/v1/timesheets", layer: "L1", context: CTX,
  summary: "工时台账",
  description:
    "外部方看不到任何工时 —— 机构办知道我们在他们医院投了多少人天，" +
    "等于知道我们的报价底线。\n" +
    "成本三件套（人天单价 / 差旅 / 成本）受列权限管辖：" +
    "一线填工时，但看不到自己值多少钱。",
  query: PageQuery.extend({
    studySiteId: Uuid.optional(),
    accountId: Uuid.optional(),
    workType: z.array(WorkType).optional(),
    from: DateOnly.optional(), to: DateOnly.optional(),
    includeVoided: QueryBool.optional().describe("默认不含已作废"),
    /** 只看还没审的 —— 审批页每次都要问的那一句 */
    unapprovedOnly: QueryBool.optional()
  }),
  response: page(TimesheetEntry)
});

define({
  id: "createTimesheet", method: "post", path: "/v1/timesheets",
  layer: "L1", context: CTX, status: 201, action: "timeWrite",
  summary: "填报工时",
  description:
    "`billable` 由工作类型推导并**落库固化**（I1）；" +
    "成本按**填报当日生效的费率卡**算出快照（I2）。\n" +
    "找不到当日生效的费率卡时拒绝填报 —— 用一个「差不多的」费率入账，" +
    "比不入账更糟：它会一直躺在报表里没人发现。",
  body: z.object({
    studySiteId: Uuid,
    workDate: DateOnly,
    workType: WorkType,
    hours: z.number().min(0.25).max(24),
    travelCents: CentsNonNeg.optional(),
    subjectId: Uuid.optional(),
    note: z.string().max(500).optional()
  }),
  response: TimesheetEntry,
  errors: ["invariant-violated"]
});

define({
  id: "voidTimesheet", method: "post", path: "/v1/timesheets/{id}:void",
  layer: "L2", context: CTX, action: "timeWrite",
  summary: "作废工时",
  description:
    "**工时不能删，只能作废。** 作废写下时间、人与原因，成本随即从统计里退出。\n" +
    "只能作废自己填的；作废别人的需要 `approve` 权限。\n" +
    "自动生成的工时（来自完成访视）同样可作废 —— 访视填错了，成本得能退回来。",
  params: ById,
  body: WithReason,
  response: commandResult(TimesheetEntry),
  errors: ["invariant-violated", "idempotency-key-reused"]
});

define({
  id: "listRateCards", method: "get", path: "/v1/rate-cards", layer: "L1", context: CTX,
  summary: "费率卡",
  description: "同一工种/级别的生效区间不允许重叠 —— 重叠时「当天用哪个费率」没有答案。",
  query: PageQuery.extend({ roleKind: RoleKindForRate.optional() }),
  response: page(RateCard)
});

define({
  id: "createRateCard", method: "post", path: "/v1/rate-cards",
  layer: "L1", context: CTX, status: 201, action: "rateWrite",
  summary: "新增费率卡",
  description:
    "调价的正确做法是**给旧卡收口、开一张新卡**，不是改旧卡的数字 ——" +
    "改数字等于改写历史成本。区间重叠会被数据库直接拒绝。",
  body: z.object({
    roleKind: RoleKindForRate,
    level: z.string().max(16).nullable().optional(),
    dayCostCents: CentsNonNeg.min(1),
    validFrom: DateOnly,
    validTo: DateOnly.nullable().optional(),
    note: z.string().max(200).optional()
  }),
  response: RateCard,
  errors: ["invariant-violated"]
});

define({
  id: "closeRateCard", method: "post", path: "/v1/rate-cards/{id}:close",
  layer: "L2", context: CTX, action: "rateWrite",
  summary: "给费率卡收口",
  description:
    "把一张不封口的费率卡设上 `validTo`，好让新卡从次日接上 —— " +
    "这是调价的第一步，第二步才是 `POST /v1/rate-cards`。\n" +
    "**只能收口，不能改单价。** 改单价等于改写历史成本：" +
    "那张卡已经被若干条工时的快照引用着，它们的成本是按当时那个数算出来的。",
  params: ById,
  body: z.object({
    validTo: DateOnly.describe("最后一个生效日（含）。必须不早于 validFrom")
  }),
  response: commandResult(RateCard),
  errors: ["invariant-violated", "idempotency-key-reused"]
});

define({
  id: "getSitePnl", method: "get", path: "/v1/study-sites/{id}/pnl",
  layer: "L1", context: CTX,
  summary: "单中心损益",
  description:
    "收入按 I8' 四项算出，成本来自未作废工时，两者都带口径版本号。\n" +
    "**视图层不做算术** —— 界面上出现的每个业务数字都来自 `@sitedesk/calc`。\n" +
    "无权限的字段从响应里消失：一线拿到的是同一个接口，只是没有钱那几栏。",
  params: ById,
  response: SitePnl
});

define({
  id: "getSitePnlTrend", method: "get", path: "/v1/study-sites/{id}/pnl/monthly",
  layer: "L1", context: CTX,
  summary: "单中心分月损益",
  description:
    "累计口径回答不了「这个月比上个月差在哪」。\n" +
    "每一笔钱按**事件发生的那个月**归属（入组月、筛败月、退出月、工时的工作日期），" +
    "不是按录入时间 —— 补录的工时落在错误的月份，是月度对不上最常见的来源。",
  params: ById,
  query: z.object({
    /** 往回看几个月（含当月）。默认 12。 */
    months: z.coerce.number().int().min(1).max(60).optional()
  }),
  response: SitePnlTrend
});

define({
  id: "approveTimesheet", method: "post", path: "/v1/timesheets/{id}:approve",
  layer: "L2", context: CTX,
  summary: "审批一条工时",
  description:
    "**审批不改变任何金额** —— 人已经干了活，成本已经发生。\n" +
    "它只回答一个问题：这笔工时有没有被第二个人看过。\n" +
    "**不能审自己填的**：自审等于没有审批流，只是多了一次点击，" +
    "而多出来的那次点击会让人以为这里已经有把关了。\n" +
    "审过不能撤回：审错了请作废这一笔并重报。",
  action: "approve",
  params: ById,
  body: z.object({ note: z.string().max(500).optional() }),
  response: commandResult(TimesheetEntry),
  errors: ["invariant-violated", "conflict-version", "idempotency-key-reused"]
});
