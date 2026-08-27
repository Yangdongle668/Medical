import { z } from "zod";
import { Uuid, Code, DateOnly, CentsNonNeg } from "../kernel/primitives.js";
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
