import { z } from "zod";
import { Uuid, Code, DateOnly, Ratio, CentsNonNeg } from "../kernel/primitives.js";
import { gated } from "../kernel/fields.js";
import { GateUnmet } from "../kernel/errors.js";

/* ════════════════════════════════════════════════════════════════════
   Site & Staffing —— StudySite（项目 × 中心）是本系统的最小作业单元。
   收入按中心计、成本按人落在中心上、进度按中心统计、核查风险按中心暴露。
   ════════════════════════════════════════════════════════════════════ */

/** 与数据库 site_state 表一一对应，seq 即业务流程顺序 */
export const SITE_STATES = [
  "intake", "irb_submit", "irb_approve", "contract",
  "siv", "enrolling", "enrolled", "followup", "closed"
] as const;
export const SiteState = z.enum(SITE_STATES).meta({
  id: "SiteState",
  description:
    "中心状态机。intake 立项 → irb_submit 伦理递交 → irb_approve 伦理批件 → " +
    "contract 合同签署 → siv SIV启动 → enrolling 入组中 → enrolled 入组完成 → " +
    "followup 随访中 → closed 中心关闭"
});

export const Study = z.object({
  id: Uuid,
  code: Code,
  shortName: z.string(),
  sponsorName: z.string(),
  phase: z.string(),
  indication: z.string(),
  plannedSubjects: z.int().positive(),
  contractAmountCents: gated(CentsNonNeg, "price"),
  startedOn: DateOnly.nullable(),
  endsOn: DateOnly.nullable()
}).meta({ id: "Study" });

export const StudySite = z.object({
  id: Uuid,
  code: Code,
  study: z.object({ id: Uuid, code: Code, shortName: z.string() }),
  hospital: z.string(),
  dept: z.string(),
  city: z.string(),
  piName: z.string(),
  piAccountId: Uuid.nullable(),
  state: SiteState,
  contracted: z.int().positive().describe("合同例数"),

  /* 商业敏感：一线看得到中心，看不到它的价钱 */
  unitPriceCents:  gated(CentsNonNeg, "price"),
  startupFeeCents: gated(CentsNonNeg, "price"),

  irbApprovedOn: DateOnly.nullable(),
  sivOn:         DateOnly.nullable(),
  sivPlannedOn:  DateOnly.nullable(),
  fpiOn:         DateOnly.nullable().describe("首例入组日"),

  /** 「事后失效」：中心已经过了 SIV，但启动清单里还挂着未完成的阻塞项。
   *
   *  出现它的路径只有一条 —— 有人把一个已完成的阻塞项**撤销**了。
   *  系统**刻意不自动回退状态机**：一个已经入组了 12 例的中心，
   *  把它推回「合同签署」会让那 12 例的访视挂在一个不存在的状态上，
   *  比不回退危险得多。
   *
   *  但不回退不等于不记账。这个字段算出来（不存），
   *  让这种中心在台账上有一处能被筛出来 —— 否则撤销之后，
   *  唯一的痕迹是一条转瞬即逝的 sideEffect 文案。 */
  startupInvalidated: z.boolean()
    .describe("已过 SIV，但启动清单仍有未完成的阻塞项 —— 当初的启动条件现在不成立"),

  /** 建档时按第几版启动清单模板铺的清单。
   *  模板改版**不回溯**已建档的中心，所以要有这个戳来答
   *  「这个中心当初是照着什么铺的」。 */
  startupTemplateVersion: z.int().nullable()
}).meta({
  id: "StudySite",
  description:
    "项目 × 中心。带 x-gated-by 的字段在无权限时**从响应中消失**，不是返回 null。"
});

/** 推进到下一节点前的闸门检查结果。
 *  中心状态机的每一次推进都对应真实世界的一组事实，
 *  系统的职责是断言这些事实成立，而不是记录一个人点过按钮。 */
export const SiteGate = z.object({
  from: SiteState,
  to: SiteState,
  satisfied: z.boolean(),
  unmet: z.array(GateUnmet)
}).meta({ id: "SiteGate" });

/* ── 立项受理（迁移 0038） ────────────────────────────────────────
   医院承接项目的第一道闸门。形式审查只看材料是否齐备与合规，
   **不评价科学性**（那是伦理委员会与专业组的事）——
   但**材料不齐就受理，后面所有环节都会带着这个缺口往下走。** */

export const ACCEPTANCE_STATES = ["review", "amend", "accepted"] as const;
export const AcceptanceState = z.enum(ACCEPTANCE_STATES).meta({
  id: "AcceptanceState",
  description:
    "review 形式审查中 → amend 待补正 / accepted 已受理。" +
    "原型里的「形式审查中」与「待受理」其实是同一个状态的两种材料齐备度 ——" +
    "差别由清单勾选算出来，不必在枚举里多开一格。"
});

export const ACCEPTANCE_ORIGINS = ["in_system", "registered"] as const;
export const AcceptanceOrigin = z.enum(ACCEPTANCE_ORIGINS).meta({
  id: "AcceptanceOrigin",
  description:
    "in_system 在本系统里走完形式审查 / registered 只登记了一个既成事实的受理号。" +
    "**两者的空清单意义相反** —— 前者是「八项都齐」，后者是「没人在这儿查过」。"
});

export const AcceptanceDoc = z.object({
  seq: z.int().min(0),
  name: z.string(),
  present: z.boolean()
}).meta({
  id: "AcceptanceDoc",
  description: "**每一项都要能单独勾** —— 一个「材料齐备 6/8」的进度条，说不出缺的是哪两份。"
});

export const SiteAcceptance = z.object({
  id: Uuid,
  code: Code,
  studyId: Uuid,
  studyCode: Code,
  drug: z.string(),
  sponsorName: z.string(),
  phase: z.string(),
  hospital: z.string(),
  /** 建档之后回填。**空表示受理了但中心还没进台账** ——
   *  那正是「建档滞后」在医院这一侧的样子。 */
  studySiteId: Uuid.nullable(),
  siteCode: Code.nullable(),
  submittedByName: z.string(),
  submittedOn: DateOnly,
  state: AcceptanceState,
  origin: AcceptanceOrigin,
  /** 补正通知的内容。**发了补正通知却不说缺什么**，
   *  递交方只能把八份材料重寄一遍。 */
  amendNote: z.string().nullable(),
  acceptedOn: DateOnly.nullable(),
  /** 受理人。**origin=registered 时为空，那是事实不是漏填** ——
   *  系统外的受理，受理人是医院里某个不在本系统的老师，填谁都是编的。 */
  acceptedByName: z.string().nullable(),
  /** 形式审查清单。**registered 的受理没有清单** ——
   *  空数组要读成「没人在这儿查过」，不是「查完了没缺」。 */
  docs: z.array(AcceptanceDoc),
  presentDocs: z.int().min(0),
  /** 缺的是哪几份 —— 名字，不是数目。 */
  missingDocs: z.array(z.string())
}).meta({
  id: "SiteAcceptance",
  description:
    "**受理不对外部方关闭** —— 它是双方共同的记录：" +
    "递交方要看到缺什么，受理方要出具受理通知。"
});

/** 形式审查清单的**默认模板**，给界面预填用。
 *
 *  它不是校验条件 —— 各医院的形式审查清单不一样（原型那两条就差着一项：
 *  器械项目查的是「试验用器械说明与合格证明」，药物项目查的是
 *  「试验用药品检验报告」）。把它写死在服务端，
 *  等于替所有医院决定它们该查什么。 */
export const ACCEPTANCE_DOC_TEMPLATE = [
  "立项申请表", "临床试验批件 / 备案号", "方案及研究者手册",
  "组长单位伦理批件", "主要研究者简历与 GCP 证书",
  "试验用药品检验报告", "保险单", "经费预算明细"
] as const;

export const SubmitAcceptance = z.object({
  studyId: Uuid,
  hospital: z.string().trim().min(2).max(80),
  /** 这家医院要审的那几份材料的名字。**递进去一律未勾** ——
   *  勾是机构办形式审查的动作。 */
  docs: z.array(z.string().trim().min(2).max(60)).min(1).max(20)
}).meta({ id: "SubmitAcceptance" });

/* ── 中心文件与物资（ISF） ────────────────────────────────────────
   **库里只存事实（在不在、什么时候到期、还剩几份），不存状态。**
   状态由 @sitedesk/calc 按今天算 —— 存成枚举它会过期：
   六月标「齐备」的那一项，十月已经是缺项，而没有人会回去改。 */

export const ISF_CATEGORY = ["dossier", "credential", "ip", "equipment"] as const;
export const IsfCategory = z.enum(ISF_CATEGORY).meta({
  id: "IsfCategory",
  description: "dossier 研究者文件夹 · credential 人员资质 · ip 试验用药品 · equipment 检验与设备"
});

export const IsfItem = z.object({
  id: Uuid,
  studySiteId: Uuid,
  siteCode: Code,
  hospital: z.string(),
  category: IsfCategory,
  item: z.string(),
  present: z.boolean(),
  expiresOn: DateOnly.nullable(),
  quantity: z.int().min(0).nullable(),
  reorderAt: z.int().min(0).nullable(),
  note: z.string().nullable(),
  checkedOn: DateOnly.nullable(),
  checkedByName: z.string().nullable(),
  /** **算出来的，不是存的。** missing 缺失 · expired 已过期 ·
   *  due 临期 · low 库存不足 · ok 齐备。 */
  status: z.enum(["missing", "expired", "due", "low", "ok"]),
  /** 距到期还有几天。**负数表示已经过期几天** ——
   *  折算成 0 会让「昨天过期」和「今天到期」看起来一样。 */
  daysLeft: z.int().nullable(),
  /** 实际用的提前量 —— 界面要说得出「为什么现在就提醒」。 */
  leadDays: z.int().positive()
}).meta({
  id: "IsfItem",
  description:
    "核查现场翻的就是这几摞东西。**人员资质缺失与药品效期是最常见的两类严重发现** ——" +
    "它们都能被日历提醒兜住，而一个存着过期状态的系统连日历都算不上。"
});

export const IsfSummary = z.object({
  total: z.int(),
  missing: z.int(),
  expired: z.int(),
  due: z.int(),
  low: z.int(),
  ok: z.int(),
  /** 齐备率。**总数为 0 时为 null，不是 100%** ——
   *  一个还没建清单的中心不是「文件齐备」，是没人查过。 */
  readyRatio: Ratio.nullable(),
  worstDaysLeft: z.int().nullable(),
  calcVersion: z.string()
}).meta({ id: "IsfSummary" });

export const IsfBoard = z.object({
  items: z.array(IsfItem),
  summary: IsfSummary
}).meta({ id: "IsfBoard" });
