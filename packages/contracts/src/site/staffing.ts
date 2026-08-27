import { z } from "zod";
import { Uuid, Code, DateOnly, Timestamp } from "../kernel/primitives.js";

/* ════════════════════════════════════════════════════════════════════
   Site & Staffing 的另外三块：启动清单 · 人员 · 交接
   ════════════════════════════════════════════════════════════════════ */

export const STARTUP_CATEGORIES = [
  "ethics", "contract", "isf", "training", "ip", "lab", "systems", "meeting"
] as const;
/** 八类的中文名。**顺序即 `startup_category.seq`**，清单按它分组显示。
 *
 *  为什么放在契约里而不是只放在库里：库里的 `startup_category` 表是权威，
 *  但前端要分组显示、mock 要造清单，各写一份中文名就是三处副本 ——
 *  加一个类目时必然只改一处。这里作一处声明，
 *  由 db/test 的「与 startup_category 表逐字一致」断言把两边钉住。 */
export const STARTUP_CATEGORY_LABEL: Record<
  (typeof STARTUP_CATEGORIES)[number], string
> = {
  ethics: "伦理与批件", contract: "合同与预算", isf: "研究者文件夹",
  training: "人员与培训", ip: "药品与物资", lab: "检验与设备",
  systems: "系统与账号", meeting: "启动会筹备"
};

export const StartupCategory = z.enum(STARTUP_CATEGORIES).meta({
  id: "StartupCategory",
  description: STARTUP_CATEGORIES.map(c => STARTUP_CATEGORY_LABEL[c]).join(" / ")
});

export const StartupItem = z.object({
  id: Uuid,
  studySiteId: Uuid,
  category: StartupCategory,
  categoryLabel: z.string(),
  item: z.string(),
  ownerAccountId: Uuid.nullable(),
  ownerName: z.string().nullable(),
  dueOn: DateOnly.nullable(),
  isBlocking: z.boolean()
    .describe("没有它就不能合法开展受试者相关工作。未清零不得推进到 SIV启动。"),
  doneAt: Timestamp.nullable(),
  doneByName: z.string().nullable(),
  overdueDays: z.int().nullable().describe("已逾期天数；未逾期或已完成为 null")
}).meta({ id: "StartupItem" });

export const StartupChecklist = z.object({
  studySiteId: Uuid,
  siteCode: Code,
  hospital: z.string(),
  state: z.string(),
  sivPlannedOn: DateOnly.nullable(),
  daysToSiv: z.int().nullable().describe("距计划 SIV 的天数；负数表示已过计划日"),
  total: z.int(),
  done: z.int(),
  blockingOpen: z.int().describe("未完成的阻塞项数 —— 它为 0 才能推进 SIV"),
  overdue: z.int(),
  items: z.array(StartupItem)
}).meta({
  id: "StartupChecklist",
  description: "启动慢一个月，这个中心的整条收入曲线右移一个月。"
});

/* ── 人员 ────────────────────────────────────────────────────────── */
export const ROLE_KINDS = ["CRA", "CRC", "PM", "QA", "DM"] as const;
export const RoleKind = z.enum(ROLE_KINDS).meta({ id: "RoleKind" });

export const Staff = z.object({
  accountId: Uuid,
  login: z.string(),
  displayName: z.string(),
  roleKind: RoleKind,
  level: z.string(),
  city: z.string(),
  gcpExpiresOn: DateOnly.nullable(),
  gcpDaysLeft: z.int().nullable().describe("负数表示已过期 —— 过期即不得开展工作"),
  mentorName: z.string().nullable(),
  successorName: z.string().nullable(),
  siteCount: z.int().describe("当前有效派工的中心数"),
  /** 无继任者且带 3 个以上中心 —— 一旦离职就断档 */
  successionGap: z.boolean(),
  /** 在职状态。**发起交接时只能选在职的人** ——
   *  停用的账号登不进来，交接给他等于把中心交给一个没人的位置。 */
  active: z.boolean(),
  disabledReason: z.string().nullable().describe("停用原因，如「离职 —— 转甲方 CRA」")
}).meta({
  id: "Staff",
  description: "account 回答「谁能登录、看得到什么」；staff 回答「他是什么工种、带谁、谁接他」。"
});

/* ── 交接 ────────────────────────────────────────────────────────── */
export const HandoverStatus = z.enum(["pending", "completed", "cancelled"])
  .meta({ id: "HandoverStatus" });

export const HandoverItem = z.object({
  seq: z.int(), item: z.string(),
  doneAt: Timestamp.nullable(), doneByName: z.string().nullable()
}).meta({ id: "HandoverItem" });

export const Handover = z.object({
  id: Uuid,
  fromAccountId: Uuid, fromName: z.string(),
  toAccountId: Uuid,   toName: z.string(),
  reason: z.string(),
  plannedOn: DateOnly,
  status: HandoverStatus,
  completedAt: Timestamp.nullable(),
  sites: z.array(z.object({ id: Uuid, code: Code, hospital: z.string() })),
  items: z.array(HandoverItem),
  doneCount: z.int(), totalCount: z.int()
}).meta({
  id: "Handover",
  description:
    "清单里最容易漏也最要命的一项是「在组受试者逐例交底」：" +
    "哪个依从性差、哪个家属有顾虑、哪个只能周三来 —— 这些不在 EDC 里，只在上一个 CRC 脑子里。"
});

/** 发起交接时默认生成的八项清单 */
export const DEFAULT_HANDOVER_ITEMS = [
  "ISF 研究者文件夹清点与移交",
  "在组受试者逐例交底（含联系方式与依从性）",
  "试验用药品实盘与账实核对",
  "未关闭质疑与质量事件清单",
  "机构与 PI 当面引荐",
  "EDC / IWRS 账号权限移交",
  "受试者补偿未发放清单",
  "样本暂存与转运待办"
] as const;

/** 新中心建档时自动铺开的标准启动清单 —— **这份常量现在只是种子**。
 *
 *  为什么要自动铺开：闸门查的是「阻塞项是否清零」。若建档时清单为空，
 *  这个条件天然成立 —— 闸门看起来在把关，实际对每一个新中心都放行。
 *  一个默认放行的闸门比没有闸门更危险，因为它会让人以为已经把住了。
 *
 *  `dueOffset` 是相对计划 SIV 日的天数（负数 = SIV 之前几天）。
 *  建档时未填计划 SIV 日的，到期日留空，等排期确定后再回填。
 *
 *  ── 它曾经是唯一的那一份 ────────────────────────────────────────
 *  这里原本写着「模板一旦可配置就要回答『谁能改、改了对在途中心是否生效、
 *  历史清单如何追溯』，那是 Phase 5 管理后台的事」。三个问题都有答案了
 *  （见迁移 0019），模板搬进了 `startup_template_item` 表：
 *
 *    · 谁能改 —— `manage` 动作，必须写原因，逐条进审计；
 *    · 在途中心 —— **不生效**。清单在建档那一刻铺开成行，此后与模板无关；
 *    · 追溯 —— 中心自己的 startup_item 行，加上 `startupTemplateVersion` 戳。
 *
 *  这份常量留下来做**第一版模板的种子**，以及新租户开户时的初始数据。
 *  运行时的建档流程读的是表，不是它 —— 两处不能同时是"事实来源"。 */
export const DEFAULT_STARTUP_ITEMS: ReadonlyArray<{
  category: (typeof STARTUP_CATEGORIES)[number];
  item: string; blocking: boolean; dueOffset: number;
}> = [
  { category: "ethics",   item: "伦理初始审查递交（方案、ICF、IB 及研究者资质）", blocking: true,  dueOffset: -35 },
  { category: "ethics",   item: "伦理会议答辩与补充材料",                     blocking: true,  dueOffset: -18 },
  { category: "ethics",   item: "伦理批件取得并归档 ISF",                     blocking: true,  dueOffset: -12 },
  { category: "contract", item: "三方协议定稿与签署（申办方 / 机构 / 受托方）",  blocking: true,  dueOffset: -14 },
  { category: "contract", item: "受试者补偿标准报机构备案",                   blocking: false, dueOffset: -10 },
  { category: "isf",      item: "ISF 建夹与目录页（按申办方模板）",            blocking: false, dueOffset: -20 },
  { category: "isf",      item: "全体研究者 CV、执业证、GCP 证书收集",          blocking: true,  dueOffset: -8 },
  { category: "training", item: "研究者授权分工表 DOA 由 PI 签署",             blocking: true,  dueOffset: -5 },
  { category: "training", item: "方案与 ICF 培训及签到表",                    blocking: true,  dueOffset: 0 },
  { category: "training", item: "机构人员备案与门禁办理",                     blocking: false, dueOffset: -7 },
  { category: "ip",       item: "药品接收、温控启用与药房交接",                 blocking: true,  dueOffset: -3 },
  { category: "ip",       item: "ICF 空白件、访视包、采血管到位",               blocking: false, dueOffset: -4 },
  { category: "lab",      item: "中心实验室资质与正常值范围收集",               blocking: false, dueOffset: -9 },
  { category: "lab",      item: "离心机 / 冰箱校准证书，影像科排期对接",         blocking: false, dueOffset: -6 },
  { category: "systems",  item: "EDC / IWRS 账号开通与权限确认",               blocking: true,  dueOffset: -4 },
  { category: "meeting",  item: "SIV 议程、参会人确认、会议室预订",             blocking: false, dueOffset: -5 }
];

/* ── 启动清单模板（可配置，见迁移 0019） ───────────────────────────── */
export const StartupTemplateItem = z.object({
  sortOrder: z.int().min(0),
  category: StartupCategory,
  item: z.string().min(1).max(200),
  isBlocking: z.boolean(),
  dueOffset: z.int().min(-365).max(365)
    .describe("相对计划 SIV 日的天数，负数 = SIV 之前几天")
}).meta({ id: "StartupTemplateItem" });

export const StartupTemplate = z.object({
  version: z.int(),
  items: z.array(StartupTemplateItem),
  updatedAt: Timestamp.nullable(),
  updatedByName: z.string().nullable(),
  reason: z.string().nullable()
}).meta({
  id: "StartupTemplate",
  description:
    "决定每个**新**中心怎么启动的那份清单。\n" +
    "**改它不影响在途中心**：清单在建档那一刻铺开成行，此后与模板无关。" +
    "一个已经做到第 12 项的中心，模板改一次就多出三项从来没人见过的阻塞 —— " +
    "没有人会认为那是「配置生效了」。"
});
