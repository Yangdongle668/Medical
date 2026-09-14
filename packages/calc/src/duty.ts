/* ════════════════════════════════════════════════════════════════════
   一线该登记而还没登记的那几件事。

   ── 为什么"登记制"需要这一口径 ────────────────────────────────────
   迁移 0048 与 0050 把两条流程从「等院外的人在本系统里点一下」改成了
   「由院内的人带着日期登记进来」。那是对的 —— 院方的机构办与研究者
   不是这套系统的用户。

   但它把风险换了个地方：原来卡住的是**别人不点**（看得见，因为它卡着），
   现在卡住的是**自己人没登记**（看不见，因为它只是没发生）。
   一件没发生的事不会出现在任何列表上，除非有人专门去数。

   而这套系统是给管理员与经营层用来管底下 CRC / CRA / PM 的 ——
   「这个人这周该登记的几件事登记了没有」正是这个系统存在的理由，
   在此之前**没有任何一页回答得了**：
   团队工作台按中心排（"SS-07 怎么样了"），驾驶舱按问题类型排，
   两者都不按人排，于是"谁欠着"永远要靠人工对。

   ── 四件事，而且都是一线自己办得掉的 ──────────────────────────────
   收进来的判据只有一条：**它是不是这个人现在就能去办完的。**
   等别人回复的（数据质疑待中心答复）、等排期的、要审批的，一律不收 ——
   把"在等别人"混进"你欠着"，这张表就会立刻失去说服力，
   而一张会冤枉人的清单，人只会学会忽略它。
   ════════════════════════════════════════════════════════════════════ */

/** EDC 录入及时线：访视完成后 5 个工作日。周末不算 —— 现实里没人周末录 EDC。
 *
 *  **它是约定，不是常识**，而且它现在有两个读者：访视详情页要画
 *  「已超出 N 天」，这张履职表要数「几件超时未录」。
 *  两处各写一份 5 的后果不是不一致告警，是两个页面对同一条访视
 *  给出不同的结论，而没有任何地方是红的。 */
export const EDC_SLA_WORKDAYS = 5;

/** 两个日历日之间隔了几个工作日（不含 `to` 当天）。
 *  周六周日不计 —— 法定节假日不在这里处理：那要一张假日表，
 *  而一张没人维护的假日表比没有更糟（它会在春节之后开始悄悄算错）。
 *
 *  ── 全程走 UTC，一处不碰本地时区 ────────────────────────────────
 *  这个函数搬进 calc 之前写的是 `d.getDay()` / `d.setDate()`。
 *  `new Date("2026-09-19")` 解析出来是 **UTC 零点**，而 `getDay()` 读的是
 *  **本地**星期几 —— 两者在东八区碰巧一致（UTC 零点是当地早上八点，
 *  同一天），所以这个 bug 在中国部署上永远不出现。
 *
 *  换到西半球就不是了：UTC-5 那边 UTC 零点是**前一天晚上七点**，
 *  于是每个日期的星期几整体退一天，周六被当成工作日、周一被当成周末。
 *  症状不是报错，是 EDC 及时率悄悄算错，而且只在那个时区错。
 *
 *  日期串是**日历日，不是某个瞬间**（shell/dates.ts 开头那段话说的是
 *  同一件事的另一半）。既然两端都按 UTC 解析，星期几也该按 UTC 读。 */
export function workdaysBetween(from: string, to: string): number {
  let n = 0;
  const b = new Date(to);
  for (const d = new Date(from); d < b; d.setUTCDate(d.getUTCDate() + 1)) {
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) n++;
  }
  return n;
}

/** 这次访视的 EDC 录入超时了几天。未完成、或已录入的一律 null ——
 *  **null 是"不欠"，0 是"今天正好到期"**，两者在界面上是两种画法。 */
export function edcDaysLate(
  actualDate: string | null, edcEntered: boolean, today: string
): number | null {
  if (!actualDate || edcEntered) return null;
  const lag = workdaysBetween(actualDate, today);
  return lag > EDC_SLA_WORKDAYS ? lag - EDC_SLA_WORKDAYS : null;
}

/** 一个人欠着的四类事。字段名与 contracts 里的 `RegistrationDuty` 同名 ——
 *  那边是传输形状，这里是口径。 */
export interface DutyCounts {
  /** 访视做完了，但 PI 签字那件事还没登记（状态停在 done_pending_pi）。
   *  **这一类不计入「已完成」统计**，所以它欠着的时候整个中心的数都是低的。 */
  pendingPiConfirm: number;
  /** 访视完成超过 5 个工作日还没标记录入 EDC。不阻断，但进及时率统计。 */
  edcOverdue: number;
  /** 窗口已经关了而访视还没完成。**每一条都是一次方案偏离**。 */
  outOfWindow: number;
  /** 立项材料递交了，受理意见函还没登记。核查要看的是那张纸。 */
  acceptanceNoLetter: number;
}

export const DUTY_KINDS = [
  "pendingPiConfirm", "edcOverdue", "outOfWindow", "acceptanceNoLetter"
] as const;
export type DutyKind = (typeof DUTY_KINDS)[number];

/** 面向人的说法。**四条都是动词** —— 一张清单上写「PI 确认」，
 *  读的人不知道该做什么；写「登记 PI 确认」，他知道。 */
export const DUTY_LABEL: Record<DutyKind, string> = {
  pendingPiConfirm: "登记 PI 确认",
  edcOverdue: "录入 EDC",
  outOfWindow: "超窗未完成",
  acceptanceNoLetter: "登记受理意见函"
};

/** 欠着的总件数。 */
export const dutyTotal = (d: DutyCounts): number =>
  DUTY_KINDS.reduce((n, k) => n + d[k], 0);

/** 这个人要不要被顶到最上面。
 *
 *  **判据不是件数，是最久的那一件挂了多久。** 按件数排的话，
 *  一个带三个大中心、每样欠一点的人会永远排在第一，
 *  而真正该先处理的是那条挂了四十天的 —— 它已经不是"来不及"，
 *  是"忘了"，而忘了的那一条不会自己浮上来。
 *
 *  14 天：两周。一个 CRC 一周去一次中心，两周没登记意味着
 *  他去过一次而没有补 —— 那时候提醒还来得及；
 *  再等下去，等到的就是核查时对不上的一段记录。 */
export const DUTY_STALE_DAYS = 14;

export const dutyUrgent = (oldestDays: number | null): boolean =>
  oldestDays !== null && oldestDays >= DUTY_STALE_DAYS;
