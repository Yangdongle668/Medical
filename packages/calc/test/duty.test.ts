import { describe, it, expect } from "vitest";
import {
  EDC_SLA_WORKDAYS, workdaysBetween, edcDaysLate,
  DUTY_KINDS, DUTY_LABEL, dutyTotal, dutyUrgent, DUTY_STALE_DAYS
} from "../src/duty.js";

/* ════════════════════════════════════════════════════════════════════
   一线履职的口径。

   这一组里真正会出事的是 `workdaysBetween` —— **它是一个会在周末
   悄悄算错的函数**，而错的那两天恰好是没人看板的两天。
   所以下面的用例全部挑在周末两侧，而不是"随便取两个日期"。

   2026-09-14 是星期一（下面每一条都按这个锚点排，改锚点要重排）。
   ════════════════════════════════════════════════════════════════════ */

/** 2026 年 9 月：14 一 / 15 二 / 16 三 / 17 四 / 18 五 / 19 六 / 20 日 / 21 一 */
const 一 = "2026-09-14", 五 = "2026-09-18", 六 = "2026-09-19", 下周一 = "2026-09-21";

describe("workdaysBetween：周末不算", () => {
  it("同一天是 0", () => {
    expect(workdaysBetween(一, 一)).toBe(0);
  });

  it("周一到周五是 4 —— **不含到达那一天**", () => {
    /* 含不含终点决定"第 5 个工作日"落在哪一天，而那正是 SLA 的边界。 */
    expect(workdaysBetween(一, 五)).toBe(4);
  });

  it("**跨过一个周末只增加 1**（周五 → 下周一）", () => {
    /* 这一条是整个函数存在的理由：自然日是 3 天，工作日只有 1 天。
       按自然日算的话，周五做完的访视在下周三就被判成超时 ——
       而那天它其实才用掉 3 个工作日。 */
    expect(workdaysBetween(五, 下周一)).toBe(1);
    expect(Math.round(
      (new Date(下周一).getTime() - new Date(五).getTime()) / 86_400_000)).toBe(3);
  });

  it("从周六起算，周末那两天一天都不进", () => {
    expect(workdaysBetween(六, 下周一)).toBe(0);
  });

  it("倒着给不会变成负数 —— 循环条件是 `<`，不是相减", () => {
    expect(workdaysBetween(下周一, 五)).toBe(0);
  });
});

describe("edcDaysLate：null 是「不欠」，0 不是", () => {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const 加一天 = (s: string) => iso(new Date(new Date(s).getTime() + 86_400_000));

  /** 用满 5 个工作日的那一刻。**它可能落在周六** ——
   *  周一完成的话，周五下班就用满了，而周六周日一天都不加。
   *  测试里不许手写"下周几"：那是把被测函数的结论抄一遍当输入。 */
  const 用满 = (from: string) => {
    let d = from;
    while (workdaysBetween(from, d) < EDC_SLA_WORKDAYS) d = 加一天(d);
    return d;
  };
  /** 第一个算迟的日子。*/
  const 首个迟日 = (from: string) => {
    let d = from;
    while (edcDaysLate(from, false, d) === null) d = 加一天(d);
    return d;
  };

  it("还没完成的访视不欠 —— 没有 actualDate 就没有起算点", () => {
    expect(edcDaysLate(null, false, 下周一)).toBeNull();
  });

  it("已经录入的不欠，哪怕当初拖了很久", () => {
    expect(edcDaysLate(一, true, "2026-12-31")).toBeNull();
  });

  it("**正好用满 5 个工作日还不算迟** —— 那天是最后期限，不是已经超了", () => {
    expect(edcDaysLate(一, false, 用满(一))).toBeNull();
  });

  it("第一个算迟的日子，迟的是 1 天 —— 不是 0，也不是 2", () => {
    /* 一上来就报"迟 2 天"是按自然日算的那一版的招牌症状：
       周末两天被算了进去。 */
    expect(edcDaysLate(一, false, 首个迟日(一))).toBe(1);
  });

  it("首个迟日的**前一天还不迟** —— 边界只跨一次", () => {
    const 迟 = 首个迟日(一);
    let 前 = 一;
    while (加一天(前) !== 迟) 前 = 加一天(前);
    expect(edcDaysLate(一, false, 前)).toBeNull();
  });

  it("**周末不会让它变迟** —— 用满那天之后的周六周日各查一次，都还是不迟", () => {
    /* 这一条抓的是最容易写错的那一版：按自然日算的实现，
       周末两天会让同一条访视从"没迟"跳成"迟 2 天"，
       而周一一上班它又"自己好了"。 */
    const 周六 = new Date(用满(一));
    while (周六.getUTCDay() !== 6) 周六.setUTCDate(周六.getUTCDate() + 1);
    const 周日 = new Date(周六.getTime() + 86_400_000);
    expect(edcDaysLate(一, false, iso(周六))).toBeNull();
    expect(edcDaysLate(一, false, iso(周日))).toBeNull();
  });
});

describe("四类欠账", () => {
  const 空 = { pendingPiConfirm: 0, edcOverdue: 0, outOfWindow: 0, acceptanceNoLetter: 0 };

  it("dutyTotal 就是四类的和", () => {
    expect(dutyTotal(空)).toBe(0);
    expect(dutyTotal({ pendingPiConfirm: 3, edcOverdue: 2, outOfWindow: 7,
      acceptanceNoLetter: 1 })).toBe(13);
  });

  it("**四类都有中文说法，而且都是动词**", () => {
    /* 清单上写「PI 确认」，读的人不知道该做什么；
       写「登记 PI 确认」，他知道。少一条 label，界面上那一列会是空表头。 */
    for (const k of DUTY_KINDS) {
      expect(DUTY_LABEL[k], `${k} 没有中文说法`).toBeTruthy();
    }
    expect(Object.keys(DUTY_LABEL).sort()).toEqual([...DUTY_KINDS].sort());
  });

  it("dutyUrgent：一件都不欠（null）不算紧急", () => {
    /* null 混进比较的话，`null >= 14` 在 JS 里是 false 但 `null >= 0` 是 true ——
       换个阈值就会把清白的人标红。所以这里显式判 null。 */
    expect(dutyUrgent(null)).toBe(false);
  });

  it("dutyUrgent：正好到线就算 —— 边界含在里面", () => {
    expect(dutyUrgent(DUTY_STALE_DAYS - 1)).toBe(false);
    expect(dutyUrgent(DUTY_STALE_DAYS)).toBe(true);
    expect(dutyUrgent(DUTY_STALE_DAYS + 30)).toBe(true);
  });
});
