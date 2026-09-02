import { describe, it, expect } from "vitest";
import {
  arAging, forecastMilestones, cashFlow, monthKeys,
  LONG_OVERDUE_DAYS, type SiteForecastInput, type CashIn
} from "../src/cash.js";

/* ════════════════════════════════════════════════════════════════════
   现金流预测 · 应收账龄。

   这一组测试盯的是**这套预测怎么骗人**：
     · 把"已经该收到、只是没开票"的算成未来收入 —— 凭空造现金流；
     · 把"不知道什么时候"当成"很久以后" —— 在第 10 个月长出一笔钱；
     · 把落到区间外的款折回最后一个月 —— 最后一个月凭空多一大笔。
   三条都有对应的断言。
   ════════════════════════════════════════════════════════════════════ */

describe("应收账龄", () => {
  const rows = [
    { amountCents: 100_00, daysToDue: 30 },    // 还没到期
    { amountCents: 200_00, daysToDue: -10 },   // 逾期 10 天
    { amountCents: 300_00, daysToDue: -94 }    // 逾期 94 天
  ];

  it("逾期只算过了到期日的", () => {
    const a = arAging(rows);
    expect(a.totalCents).toBe(600_00);
    expect(a.overdueCents).toBe(500_00);
    expect(a.overdueCount).toBe(2);
  });

  it(`逾期超过 ${LONG_OVERDUE_DAYS} 天的单独算 —— 那不再是催收问题`, () => {
    expect(arAging(rows).longOverdueCents).toBe(300_00);
  });

  it("平均逾期天数只在逾期那部分里算", () => {
    expect(arAging(rows).meanOverdueDays).toBeCloseTo((10 + 94) / 2, 6);
  });

  it("**一笔都没逾期时是 null，不是 0**", () => {
    /* 「一笔都没逾期」和「平均逾期 0 天」是两回事 —— 前者该显示「—」。 */
    const clean = arAging([{ amountCents: 100_00, daysToDue: 5 }]);
    expect(clean.meanOverdueDays).toBeNull();
    expect(clean.overdueShare).toBe(0);
  });

  it("一笔应收都没有时占比是 null，不是 0", () => {
    expect(arAging([]).overdueShare).toBeNull();
  });

  it("逾期占比比绝对额有用 —— 两者都给", () => {
    expect(arAging(rows).overdueShare).toBeCloseTo(500 / 600, 6);
  });
});

const PLAN = [
  { code: "contract", ratio: 0.10 }, { code: "siv", ratio: 0.15 },
  { code: "half", ratio: 0.25 }, { code: "eighty", ratio: 0.25 },
  { code: "closeout", ratio: 0.25 }
];
const site = (o: Partial<SiteForecastInput> = {}): SiteForecastInput => ({
  contractCents: 100_000_00, contracted: 30, enrolled: 10,
  reached: ["contract", "siv"], velocityPerMonth: 2,
  monthsToSiv: 0, contractSigned: true, ...o
});

describe("里程碑预测", () => {
  it("已达成的那几段不再预测", () => {
    const f = forecastMilestones(site(), PLAN);
    expect(f.map(x => x.planCode)).not.toContain("contract");
    expect(f.map(x => x.planCode)).not.toContain("siv");
  });

  it("金额按合同额乘比例，且是整数分", () => {
    const half = forecastMilestones(site(), PLAN).find(x => x.planCode === "half")!;
    expect(half.amountCents).toBe(25_000_00);
    expect(Number.isInteger(half.amountCents)).toBe(true);
  });

  it("入组越快，达成越早", () => {
    const slow = forecastMilestones(site({ velocityPerMonth: 1 }), PLAN)
      .find(x => x.planCode === "half")!;
    const fast = forecastMilestones(site({ velocityPerMonth: 5 }), PLAN)
      .find(x => x.planCode === "half")!;
    expect(fast.inMonths).toBeLessThan(slow.inMonths);
  });

  it("**已经该达成却不在台账里的，标成 gap** —— 那是记录缺口不是未来收入", () => {
    /* 30 例合同，已入组 20 例 —— 过半（15 例）早就达成了。 */
    const f = forecastMilestones(site({ enrolled: 20 }), PLAN);
    const half = f.find(x => x.planCode === "half")!;
    expect(half.inMonths).toBe(0);
    expect(half.gap).toBe(true);
  });

  it("**速度未知时不给月数** —— 不是「很久以后」", () => {
    /* 返回 Infinity 或一个大数，会在第 10 个月凭空长出一笔钱。 */
    const f = forecastMilestones(
      site({ velocityPerMonth: null, enrolled: 0 }), PLAN);
    expect(f.map(x => x.planCode)).not.toContain("half");
    expect(f.map(x => x.planCode)).not.toContain("eighty");
    /* 结题也不在 —— 它的粗估是 12 个月，被十个月的地平线筛掉了。
       **这是对的**：一个还不知道入组速度的中心，什么时候结题是猜不是预测。
       于是这个中心对现金流的贡献是 0 —— 而那正是它该有的样子。 */
    expect(f).toHaveLength(0);
  });

  it("十个月以外的不进预测 —— 再远就不是预测是猜", () => {
    const f = forecastMilestones(
      site({ velocityPerMonth: 0.2, enrolled: 0, contracted: 100 }), PLAN);
    for (const x of f) expect(x.inMonths).toBeLessThanOrEqual(10);
  });

  it("合同还没签的，签约那一段给 2 个月", () => {
    const f = forecastMilestones(
      site({ reached: [], contractSigned: false, monthsToSiv: null }), PLAN);
    expect(f.find(x => x.planCode === "contract")!.inMonths).toBe(2);
  });
});

describe("现金流", () => {
  const ins: CashIn[] = [
    { amountCents: 100_00, month: 1, label: "已开票 A", kind: "invoiced" },
    { amountCents: 200_00, month: 1, label: "逾期 B", kind: "overdue" },
    { amountCents: 300_00, month: 2, label: "预计 C", kind: "forecast" }
  ];

  it("逐月净额与累计", () => {
    const f = cashFlow(ins, 150_00, 4, "2026-08");
    expect(f.months).toHaveLength(4);
    expect(f.months[0]!.inCents).toBe(300_00);
    expect(f.months[0]!.netCents).toBe(150_00);
    expect(f.months[1]!.cumCents).toBe(150_00 + (300_00 - 150_00));
  });

  it("月份键从起始月的**下一个月**开始，且跨年正确", () => {
    expect(monthKeys("2026-11", 3)).toEqual(["2026-12", "2027-01", "2027-02"]);
  });

  it("**落到区间外的视为收不到，不折回最后一个月**", () => {
    /* 折回去会让最后一个月凭空多出一大笔，
       而那正是压力情景要拆穿的假象。 */
    const f = cashFlow(
      [{ amountCents: 999_00, month: 9, label: "太远了", kind: "forecast" }],
      100_00, 3, "2026-08");
    for (const m of f.months) expect(m.inCents).toBe(0);
  });

  it("最低点落在哪个月 —— 那就是要提前多久去谈的答案", () => {
    const f = cashFlow([], 100_00, 3, "2026-08");
    expect(f.troughCents).toBe(-300_00);
    expect(f.troughMonth).toBe("2026-11");
  });

  it("**压力情景：逾期的再拖 3 个月，预计的延后 1 个月**", () => {
    const f = cashFlow(ins, 150_00, 4, "2026-08");
    /* 逾期那 200 从第 1 月推到第 4 月；预计那 300 从第 2 月推到第 3 月 */
    expect(f.stress.months[0]!.inCents).toBe(100_00);
    expect(f.stress.months[2]!.inCents).toBe(300_00);
    expect(f.stress.months[3]!.inCents).toBe(200_00);
    /* 压力下的最低点不会比基准好 */
    expect(f.stress.troughCents).toBeLessThanOrEqual(f.troughCents);
  });

  it("已开票与待开票在压力情景里不推迟 —— 只有逾期和预测会", () => {
    const f = cashFlow(
      [{ amountCents: 100_00, month: 1, label: "待开票", kind: "pending" }],
      0, 3, "2026-08");
    expect(f.stress.months[0]!.inCents).toBe(100_00);
  });

  it("**记录缺口单独给，不进任何一个月** —— 它不是未来收入", () => {
    const f = cashFlow(ins, 150_00, 4, "2026-08", 888_00);
    expect(f.recordGapCents).toBe(888_00);
    const total = f.months.reduce((n, m) => n + m.inCents, 0);
    expect(total).toBe(600_00);
  });

  it("一个月都不预测时不炸，最低点是 0 不是 Infinity", () => {
    const f = cashFlow([], 100_00, 0, "2026-08");
    expect(f.months).toHaveLength(0);
    expect(f.troughCents).toBe(0);
    expect(f.troughMonth).toBeNull();
  });
});
