import { describe, it, expect } from "vitest";
import {
  isfVerdict, isfSummary, isfRank, ISF_LEAD_DAYS, type IsfInput
} from "../src/isf.js";

/* ════════════════════════════════════════════════════════════════════
   中心文件与物资。

   这一组盯的是**状态存下来会怎样**：
     · 六月标"齐备"的那一项，十月已经过期，而没有人会回去改；
     · 缺失与过期混成一格 —— 一份没有过的证书和一份过期的证书，
       要做的事不一样：前者是去要，后者是去换；
     · 一刀切的提前量 —— 伦理年度跟踪要 60 天，药品换批 30 天就够。
   ════════════════════════════════════════════════════════════════════ */

const T = "2026-09-03";
const mk = (over: Partial<IsfInput> = {}): IsfInput =>
  ({ category: "dossier", present: true, expiresOn: null, leadDays: null, ...over });

describe("状态是算出来的", () => {
  it("**同一行数据，隔几个月结论就变** —— 这正是不能存的理由", () => {
    const item = mk({ expiresOn: "2026-10-18" });
    /* 六月看：还早 */
    expect(isfVerdict(item, "2026-06-01").status).toBe("ok");
    /* 九月看：进了 60 天提前量 */
    expect(isfVerdict(item, T).status).toBe("due");
    /* 十一月看：过期了 */
    expect(isfVerdict(item, "2026-11-01").status).toBe("expired");
  });

  it("**缺失与过期分开** —— 前者是去要，后者是去换", () => {
    expect(isfVerdict(mk({ present: false }), T).status).toBe("missing");
    expect(isfVerdict(mk({ expiresOn: "2026-08-01" }), T).status).toBe("expired");
  });

  it("到期当天算临期，不算过期 —— 那一天证书还有效", () => {
    expect(isfVerdict(mk({ expiresOn: T }), T).status).toBe("due");
    expect(isfVerdict(mk({ expiresOn: "2026-09-02" }), T).status).toBe("expired");
  });

  it("没有到期日的只看在不在", () => {
    expect(isfVerdict(mk(), T).status).toBe("ok");
    expect(isfVerdict(mk(), T).daysLeft).toBeNull();
  });

  it("**已过期的 daysLeft 是负数** —— 折算成 0 会让昨天和今天看起来一样", () => {
    expect(isfVerdict(mk({ expiresOn: "2026-08-29" }), T).daysLeft).toBe(-5);
  });

  it("**提前量按类别不同**：伦理要 60 天，药品换批 30 天就够", () => {
    expect(ISF_LEAD_DAYS.dossier).toBe(60);
    expect(ISF_LEAD_DAYS.ip).toBe(30);
    const in45 = "2026-10-18";
    expect(isfVerdict(mk({ category: "dossier", expiresOn: in45 }), T).status).toBe("due");
    expect(isfVerdict(mk({ category: "ip", expiresOn: in45 }), T).status).toBe("ok");
  });

  it("**库存不足单成一档** —— 模块名就是「中心文件与物资」", () => {
    const v = isfVerdict(mk({ quantity: 4, reorderAt: 10 }), T);
    expect(v.status).toBe("low");
    /* 补货线以上就是齐备 */
    expect(isfVerdict(mk({ quantity: 40, reorderAt: 10 }), T).status).toBe("ok");
  });

  it("**过期压过库存不足** —— 一批过期的药一盒都不能用", () => {
    const v = isfVerdict(
      mk({ category: "ip", expiresOn: "2026-08-20", quantity: 9, reorderAt: 10 }), T);
    expect(v.status).toBe("expired");
  });

  it("只有库存没有补货线时不下结论 —— 「少到多少算少」没有答案", () => {
    expect(isfVerdict(mk({ quantity: 1 }), T).status).toBe("ok");
  });

  it("行上可以覆盖提前量，而覆盖了多少要给出来", () => {
    const v = isfVerdict(mk({ category: "ip", expiresOn: "2026-10-18", leadDays: 90 }), T);
    expect(v.status).toBe("due");
    expect(v.leadDays).toBe(90);
  });
});

describe("齐备率与排序", () => {
  const vs = [
    isfVerdict(mk({ present: false }), T),
    isfVerdict(mk({ expiresOn: "2026-08-01" }), T),
    isfVerdict(mk({ expiresOn: "2026-10-18" }), T),
    isfVerdict(mk(), T)
  ];

  it("四档各数各的", () => {
    const s = isfSummary(vs);
    expect(s).toMatchObject({ total: 4, missing: 1, expired: 1, due: 1, low: 0, ok: 1 });
    expect(s.readyRatio).toBeCloseTo(0.25, 6);
  });

  it("**没有清单不是齐备率 100%**，是没人查过", () => {
    expect(isfSummary([]).readyRatio).toBeNull();
    expect(isfSummary([]).worstDaysLeft).toBeNull();
  });

  it("最紧的那一项取最负的天数", () => {
    expect(isfSummary(vs).worstDaysLeft).toBe(-33);
  });

  it("**缺失与过期排最前，齐备排最后**", () => {
    const withLow = [...vs, isfVerdict(mk({ quantity: 4, reorderAt: 10 }), T)];
    const order = withLow.sort((a, b) => isfRank(a) - isfRank(b)).map(v => v.status);
    expect(order).toEqual(["missing", "expired", "due", "low", "ok"]);
  });

  it("临期的按剩余天数排 —— 越近越前", () => {
    const a = isfVerdict(mk({ expiresOn: "2026-10-18" }), T);   // 45 天
    const b = isfVerdict(mk({ expiresOn: "2026-09-20" }), T);   // 17 天
    expect(isfRank(b)).toBeLessThan(isfRank(a));
  });
});
