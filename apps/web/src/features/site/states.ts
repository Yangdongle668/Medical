/** 中心状态机的中文名与顺序。
 *
 *  为什么单独一个文件：详情页要按顺序画流程条，启动清单页要显示当前阶段，
 *  两处若各写一份，加一个状态时必然只改一处。
 *  顺序与 `SITE_STATES`（契约）、`site_state.seq`（库）同源 ——
 *  这里只补中文名，不另立顺序。 */
import { SITE_STATES } from "@sitedesk/contracts";

export const SITE_ORDER: readonly string[] = SITE_STATES;

export const SITE_STATE_LABEL: Record<string, string> = {
  intake: "立项", irb_submit: "伦理递交", irb_approve: "伦理批件",
  contract: "合同签署", siv: "SIV启动", enrolling: "入组中",
  enrolled: "入组完成", followup: "随访中", closed: "中心关闭"
};
