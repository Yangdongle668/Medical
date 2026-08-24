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
  fpiOn:         DateOnly.nullable().describe("首例入组日")
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
