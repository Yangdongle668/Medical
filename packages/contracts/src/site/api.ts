import { z } from "zod";
import { define } from "../kernel/registry.js";
import { Uuid, DateOnly, CentsNonNeg, QueryBool } from "../kernel/primitives.js";
import { PageQuery, page } from "../kernel/pagination.js";
import { commandResult, WithReason } from "../kernel/command.js";
import { Study, StudySite, SiteState, SiteGate,
  SiteAcceptance, AcceptanceState, SubmitAcceptance,
  IsfBoard, IsfCategory } from "./model.js";

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
import { StartupChecklist, StartupSummary, StartupItem, Staff, SiteStaff, Handover,
  RoleKind, HandoverStatus, StartupTemplate, StartupTemplateItem }
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
  id: "listSiteStaff", method: "get", path: "/v1/site-staff", layer: "L1", context: CTX,
  summary: "中心人员备案名册",
  description:
    "`listStaff` 的**另一个问题**，不是它的一个筛子。\n\n" +
    "`/v1/staff` 是我方的人事账（职级、带教、继任、共带几个中心），" +
    "外部方一行也看不到，那条策略要保留。\n" +
    "但机构办有一件必须做的事：备案 —— 我院这几个中心上出现的 CRC 是谁、" +
    "他的 GCP 证书还有效吗。证书过期的人不得开展工作，" +
    "这不是我方的内部管理，是机构履行监管职责的一部分。\n\n" +
    "所以走一个只开这几列的口子（`app.site_staff_registry()`），" +
    "行范围照旧由登录身份推导 —— **SECURITY DEFINER 绕开的是表策略，不是行范围**。\n" +
    "`sites` 只列本范围内的中心：那个 CRC 在别家医院还带着几个，与本院无关。",
  query: PageQuery.extend({
    roleKind: RoleKind.optional(),
    /** 只看证书已过期或即将到期的 —— 备案表上真正要动手的就这几个人。 */
    gcpProblem: QueryBool.optional().describe("只看 GCP 已过期或 60 天内到期的"),
    studySiteId: Uuid.optional()
  }),
  response: page(SiteStaff)
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

/* ── 立项受理 ────────────────────────────────────────────────────── */

define({
  id: "listSiteAcceptances", method: "get", path: "/v1/site-acceptances",
  layer: "L1", context: CTX,
  summary: "立项受理",
  description:
    "医院承接项目的第一道闸门。**形式审查只看材料是否齐备与合规，不评价科学性** ——" +
    "科学性由伦理委员会与专业组判断。\n\n" +
    "但它是一道真闸门：材料不齐就受理，后面所有环节都会带着这个缺口往下走。" +
    "所以未受理的中心推不到「伦理递交」（中心状态机的闸门）。\n\n" +
    "**这张表不对外部方关闭** —— 它是双方共同的记录：" +
    "递交方要看到缺什么，受理方要出具受理通知。",
  query: PageQuery.extend({
    studyId: Uuid.optional(),
    state: z.array(AcceptanceState).optional(),
    openOnly: QueryBool.optional()
  }),
  response: page(SiteAcceptance)
});

define({
  id: "submitSiteAcceptance", method: "post", path: "/v1/site-acceptances",
  layer: "L1", context: CTX,
  summary: "递交立项材料", status: 201,
  description:
    "受托方把材料递到医院机构办 —— **这一步不在的话，`irb_submit` 闸门就是一堵墙**：" +
    "新建档的中心永远递不出去，而墙教会用户的是绕过它。\n\n" +
    "**材料清单由请求带来，不是服务端的规则** —— 各医院的形式审查清单不一样，" +
    "把它写死在服务端，等于替所有医院决定它们该查什么。" +
    "`ACCEPTANCE_DOC_TEMPLATE` 是给界面预填的默认值，不是校验条件。\n\n" +
    "递进去的清单**一律未勾**：勾是机构办形式审查的动作，" +
    "递交方自己勾完再递，形式审查就没有意义了。",
  action: "advance",
  body: SubmitAcceptance,
  response: SiteAcceptance,
  errors: ["invariant-violated"]
});

define({
  id: "setAcceptanceDoc", method: "post",
  path: "/v1/site-acceptances/{id}/docs/{seq}:set",
  layer: "L2", context: CTX,
  summary: "勾选一项立项材料",
  description:
    "**每一项单独勾。** 一个「材料齐备 6/8」的进度条说不出缺的是哪两份，" +
    "而补正通知要写的正是那两份的名字。\n\n" +
    "受理之后清单冻结：受理通知发出去了，清单还能改，" +
    "那张通知就不再对应任何一份材料。",
  action: "accept",
  params: z.object({ id: Uuid, seq: z.coerce.number().int().min(0) }),
  body: z.object({ present: z.boolean() }),
  response: commandResult(SiteAcceptance),
  errors: ["invariant-violated", "idempotency-key-reused"]
});

define({
  id: "acceptSite", method: "post", path: "/v1/site-acceptances/{id}:accept",
  layer: "L2", context: CTX,
  summary: "予以受理",
  description:
    "**材料不齐不予受理** —— 拦的时候要列出缺的那几份的名字。\n\n" +
    "受理是医院对我方的一次准入决定，所以门是 `accept`，" +
    "而它**只有机构办与管理员有**：借 `closeQA` 的话，" +
    "我方的质量岗就能替医院受理自己递上去的材料。",
  action: "accept",
  params: ById, body: z.object({}),
  response: commandResult(SiteAcceptance),
  errors: ["invariant-violated", "idempotency-key-reused"]
});

define({
  id: "requestAcceptanceAmend", method: "post",
  path: "/v1/site-acceptances/{id}:amend",
  layer: "L2", context: CTX,
  summary: "发出补正通知",
  description:
    "**补正通知要说清缺什么。** 只说「材料不齐」，递交方只能把八份重寄一遍 ——" +
    "而重寄一遍之后缺的还是那两份。",
  action: "accept",
  params: ById, body: WithReason,
  response: commandResult(SiteAcceptance),
  errors: ["invariant-violated", "idempotency-key-reused"]
});

/* ── 中心文件与物资 ──────────────────────────────────────────────── */

define({
  id: "getIsfBoard", method: "get", path: "/v1/isf-items",
  layer: "L1", context: CTX,
  summary: "中心文件与物资",
  description:
    "**状态是算出来的，不是存的。** 库里只有事实（在不在、什么时候到期、还剩几份）——" +
    "存成枚举它会过期：六月标「齐备」的那一项，十月已经是缺项，" +
    "而没有人会回去改。\n\n" +
    "提前量按类别不同：伦理年度跟踪要**提前 60 天**递交，" +
    "药品效期提前 30 天联系申办方换批就够。一刀切要么天天见红，" +
    "要么在最要紧的那一项上来不及。\n\n" +
    "**缺失与过期排最前**，其次临期（越近越前），再次库存不足，齐备在最后 ——" +
    "核查现场翻的就是这几摞东西，翻到的顺序应当是最该先处理的那几项。",
  query: z.object({
    studySiteId: Uuid.optional(),
    category: z.array(IsfCategory).optional(),
    /** 只看不齐备的。 */
    openOnly: QueryBool.optional()
  }),
  response: IsfBoard
});

define({
  id: "updateIsfItem", method: "post", path: "/v1/isf-items/{id}:update",
  layer: "L2", context: CTX,
  summary: "更新一项中心文件",
  description:
    "改的是**事实**：证书拿到了没有、新到期日是哪天、还剩几份。" +
    "状态不接受传入 —— 它是算出来的，传进来就等于把过期状态又存了回去。\n\n" +
    "门是 `isfWrite`，CRC 与 CRA 都有：**ISF 完整性检查是每次监查的必查项**，" +
    "而 CRA 没有 `subjWrite` —— 借那个动作，CRA 现场发现缺件却改不动台账。",
  action: "isfWrite",
  params: ById,
  body: z.object({
    present: z.boolean().optional(),
    expiresOn: DateOnly.nullable().optional(),
    quantity: z.int().min(0).nullable().optional(),
    note: z.string().trim().max(500).optional()
  }),
  response: commandResult(IsfBoard),
  errors: ["invariant-violated", "idempotency-key-reused"]
});
