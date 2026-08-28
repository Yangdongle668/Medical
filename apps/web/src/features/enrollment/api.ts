import { call } from "../../api/client.js";

/** `getSiteFunnel` 的列表形态。入组进度与筛选漏斗两页共用一份数 ——
 *  两页各取各的口径去算，迟早会出现"入组进度说 12 例、漏斗说 11 例"。 */
export interface Funnel {
  studySiteId: string; siteCode: string; hospital: string; contracted: number;
  prescreened: number; icfSigned: number; inScreening: number;
  enrolled: number; screenFailed: number; withdrawn: number; completed: number;
  screenFailRate: number | null; icfRate: number | null;
  yieldRate: number | null; retentionRate: number | null;
  screenFailBreakdown: { reason: string; count: number }[];
  withdrawBreakdown: { reason: string; count: number }[];
  attainment: number | null;
}

export const listEnrollment = (behindOnly = false) =>
  call<{ items: Funnel[] }>("listEnrollment",
    { query: { limit: 200, ...(behindOnly ? { behindOnly: true } : {}) } });

/** 百分比。null 是"分母为 0"，不是 0% —— 两者在这几页上差别很大：
 *  一个中心还没开始预筛，它的筛败率不是 0，是**没有**。 */
export const pct = (r: number | null) =>
  r === null ? "—" : `${Math.round(r * 100)}%`;

/* 取值与契约里的 SCREEN_FAIL_REASONS / WITHDRAW_REASONS 一一对应。
   查不到的键**原样显示**（下面 label()），不显示成空白 ——
   契约加了一个新原因而这里忘了跟上时，页面上会看到那个英文键，
   那比看到一片空白容易发现得多。 */
export const SCREEN_FAIL_LABEL: Record<string, string> = {
  lab: "实验室指标不符", prior_therapy: "既往治疗史不符", imaging: "影像学不符合",
  comorbidity: "合并疾病或用药禁忌", withdrew_icf: "受试者撤回知情", other: "其他"
};
export const WITHDRAW_LABEL: Record<string, string> = {
  withdrew_icf: "撤回知情", lost_to_followup: "失访", adverse_event: "不良事件终止治疗",
  investigator_decision: "研究者判断需终止", death: "死亡", protocol_violation: "方案违背终止"
};
export const label = (map: Record<string, string>, k: string) => map[k] ?? k;
