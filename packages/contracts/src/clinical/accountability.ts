import { z } from "zod";
import { define } from "../kernel/registry.js";
import { Uuid, DateOnly } from "../kernel/primitives.js";
import { PageQuery, page } from "../kernel/pagination.js";
import { commandResult } from "../kernel/command.js";

/* ════════════════════════════════════════════════════════════════════
   药品台账 · 生物样本 · 伦理递交

   这三样是为了同一件事补上的：**关闭闸门里那四项从来没能真查过的检查**
   （见 apps/api/src/modules/site/gate.ts 与迁移 0017）。
   fail-closed 一直是对的，代价是没有任何一个中心关得掉 ——
   闸门看起来在把关，实际是一堵墙。

   刻意建到"够闸门用、够台账看"为止。完整的药品管理与样本管理是两个
   独立的产品模块（温控、批号、有效期、盲态……），不该借着补闸门的名义
   一次长出来 —— 那样出来的东西两头都不像。
   ════════════════════════════════════════════════════════════════════ */

const CTX = "clinical";
const ById = z.object({ id: Uuid });

/* 动作权限用的是**现成的** key，没有新造：
   药品与样本是 CRC/CRA 在同一次访视里做的事，跟着 `subjWrite` 走；
   伦理递交跟着 `ethics` 走。
   新造一个 action key 不只是加一个字符串 —— 规约 13 说「谁能做什么」
   属于租户数据，要落在种子里，于是每一个既有租户都要补一次数据迁移。
   为了两张新表付那个代价，不值。 */

/* ── 药品 ─────────────────────────────────────────────────────────── */
export const IpKind = z.enum(["receipt", "dispense", "return", "ship_back", "destroy"])
  .describe("到货 / 发放 / 受试者退回 / 退回申办方 / 销毁登记");

export const IpMovement = z.object({
  id: Uuid,
  studySiteId: Uuid,
  movedOn: DateOnly,
  kind: IpKind,
  quantity: z.int().positive(),
  /** 只存筛选号/随机号 —— 数据红线：不存任何受试者可识别信息 */
  subjectRef: z.string().nullable(),
  refNo: z.string().nullable(),
  note: z.string().nullable()
}).meta({ id: "IpMovement" });

export const IpLedger = z.object({
  items: z.array(IpMovement),
  nextCursor: z.string().nullable(),
  /** 在手数量。**算出来的，不是存出来的** —— 存了就要维护，维护就会错。
   *  为负说明发出去的比收到的多：那是记账错了，不是"少了几盒"。 */
  balance: z.int(),
  /** 关闭闸门看的就是这两个。放在这里，是为了让人在台账上
   *  直接看见"我现在关不掉中心，是因为它们"。 */
  blocksClose: z.boolean()
}).meta({ id: "IpLedger" });

define({
  id: "listIpMovements", method: "get", path: "/v1/study-sites/{id}/ip-movements",
  layer: "L1", context: CTX,
  summary: "中心药品台账",
  description: "只追加的流水 + 算出来的在手数量。关闭闸门的两项药品检查看的就是它。",
  params: ById, query: PageQuery,
  response: IpLedger
});

define({
  id: "recordIpMovement", method: "post", path: "/v1/study-sites/{id}/ip-movements",
  layer: "L1", context: CTX, status: 201, action: "subjWrite",
  summary: "记一笔药品出入库",
  description: "只追加：记错了要用反向流水冲销，不能改历史 —— 核查看的就是这本台账。",
  params: ById,
  body: z.object({
    movedOn: DateOnly.optional(),
    kind: IpKind,
    quantity: z.int().positive().max(100_000),
    subjectRef: z.string().max(32).optional(),
    refNo: z.string().max(64).optional(),
    note: z.string().max(500).optional()
  }),
  response: IpMovement
});

/* ── 生物样本 ─────────────────────────────────────────────────────── */
export const Specimen = z.object({
  id: Uuid,
  studySiteId: Uuid,
  subjectRef: z.string(),
  kind: z.string(),
  collectedOn: DateOnly,
  shippedOn: DateOnly.nullable(),
  receivedOn: DateOnly.nullable(),
  discardedOn: DateOnly.nullable(),
  trackingNo: z.string().nullable(),
  /** 闭环 = 实验室确认收到，或已销毁登记。两个都没有 = 在路上不知去向。 */
  closed: z.boolean()
}).meta({ id: "Specimen" });

define({
  id: "listSpecimens", method: "get", path: "/v1/study-sites/{id}/specimens",
  layer: "L1", context: CTX,
  summary: "中心生物样本",
  params: ById,
  query: PageQuery.extend({ openOnly: z.coerce.boolean().optional() }),
  response: page(Specimen)
});

define({
  id: "recordSpecimen", method: "post", path: "/v1/study-sites/{id}/specimens",
  layer: "L1", context: CTX, status: 201, action: "subjWrite",
  summary: "登记一管样本",
  params: ById,
  body: z.object({
    subjectRef: z.string().min(1).max(32),
    kind: z.string().min(1).max(32),
    collectedOn: DateOnly,
    trackingNo: z.string().max(64).optional()
  }),
  response: Specimen
});

define({
  id: "advanceSpecimen", method: "post", path: "/v1/specimens/{id}:advance",
  layer: "L2", context: CTX, action: "subjWrite",
  summary: "推进样本链路（寄出 / 收到 / 销毁）",
  description:
    "收到与销毁是两个互斥的结局 —— 都不填就是「在路上不知去向」，" +
    "而中心一关就再也查不清了。",
  params: ById,
  body: z.object({
    stage: z.enum(["shipped", "received", "discarded"]),
    on: DateOnly
  }),
  response: commandResult(Specimen)
});

/* ── 伦理递交 ─────────────────────────────────────────────────────── */
export const SubmissionKind = z.enum(["initial", "amendment", "annual", "closeout"]);
export const SubmissionDecision = z.enum(["pending", "approved", "rejected"]);

export const RegulatorySubmission = z.object({
  id: Uuid,
  studySiteId: Uuid,
  kind: SubmissionKind,
  submittedOn: DateOnly,
  decision: SubmissionDecision,
  decidedOn: DateOnly.nullable(),
  refNo: z.string().nullable(),
  note: z.string().nullable()
}).meta({ id: "RegulatorySubmission" });

define({
  id: "listRegulatorySubmissions", method: "get",
  path: "/v1/study-sites/{id}/regulatory-submissions",
  layer: "L1", context: CTX,
  summary: "伦理递交与批复",
  params: ById, query: PageQuery,
  response: page(RegulatorySubmission)
});

define({
  id: "recordRegulatorySubmission", method: "post",
  path: "/v1/study-sites/{id}/regulatory-submissions",
  layer: "L1", context: CTX, status: 201, action: "ethics",
  summary: "登记一次伦理递交",
  params: ById,
  body: z.object({
    kind: SubmissionKind,
    submittedOn: DateOnly,
    refNo: z.string().max(64).optional(),
    note: z.string().max(500).optional()
  }),
  response: RegulatorySubmission
});

define({
  id: "decideRegulatorySubmission", method: "post",
  path: "/v1/regulatory-submissions/{id}:decide",
  layer: "L2", context: CTX, action: "ethics",
  summary: "登记伦理批复",
  description: "**递交了不等于批下来了。** 关闭闸门看的是批复，不是递交。",
  params: ById,
  body: z.object({
    decision: z.enum(["approved", "rejected"]),
    decidedOn: DateOnly,
    note: z.string().max(500).optional()
  }),
  response: commandResult(RegulatorySubmission)
});
