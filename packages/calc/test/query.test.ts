import { describe, it, expect } from "vitest";
import {
  queryLoad, siteQueryDensity, densityBand, densityVerdict,
  QUERY_STALE_DAYS, QUERY_TARGET_DAYS, type QueryRecord
} from "../src/query.js";

/* ════════════════════════════════════════════════════════════════════
   数据质疑的口径。

   这一组盯的是**这套数怎么骗人**：
     · 只统计已关闭的 —— 永远不关的那条就永远不进分母，越烂越好看；
     · 入组 0 例的中心算成 0 条/例 —— 还没开始录的伪装成录得最干净；
     · 只给密度不给集中度 —— "高不一定是中心差"就只是一句免责声明。
   ════════════════════════════════════════════════════════════════════ */

const q = (ageDays: number, state: QueryRecord["state"] = "open"): QueryRecord =>
  ({ ageDays, state });

describe("质疑负荷", () => {
  it("**未关闭的也算进平均** —— 否则不关就能把数做好看", () => {
    /* 三条已关闭、都很快；一条挂了 40 天没人管。 */
    const rs = [q(2, "closed"), q(3, "closed"), q(1, "closed"), q(40)];
    const l = queryLoad(rs);
    expect(l.meanAgeDays).toBeCloseTo((2 + 3 + 1 + 40) / 4, 6);
    expect(l.meetsTarget).toBe(false);

    /* 只算已关闭的话，同一份数据会给出 2 天并且"达标" ——
       而那条挂了 40 天的正是这一页存在的全部理由。 */
    const closedOnly = rs.filter(r => r.state === "closed");
    const fake = closedOnly.reduce((n, r) => n + r.ageDays, 0) / closedOnly.length;
    expect(fake).toBeLessThan(QUERY_TARGET_DAYS);
  });

  it("超 7 天只数「待中心回复」的，待关闭的单独数", () => {
    const l = queryLoad([q(9), q(3), q(20, "pending_review"), q(30, "closed")]);
    expect(l.open).toBe(2);
    expect(l.stale).toBe(1);
    expect(l.pendingReview).toBe(1);
    /* 待关闭堆了 20 天是 DM 自己的欠账，不该混进"中心不回复"里。 */
    expect(l.staleReview).toBe(1);
    expect(l.closed).toBe(1);
  });

  it("刚好 7 天不算超期 —— 边界写死", () => {
    expect(queryLoad([q(QUERY_STALE_DAYS)]).stale).toBe(0);
    expect(queryLoad([q(QUERY_STALE_DAYS + 1)]).stale).toBe(1);
  });

  it("**没有质疑不等于达标**", () => {
    const l = queryLoad([]);
    expect(l.meanAgeDays).toBeNull();
    expect(l.meetsTarget).toBeNull();
    expect(l.worstAgeDays).toBeNull();
  });

  it("最坏的那一条单独给出来", () => {
    expect(queryLoad([q(2), q(21), q(5)]).worstAgeDays).toBe(21);
  });
});

describe("每例质疑数", () => {
  const rows = (n: number, form = "合并用药 CM") =>
    Array.from({ length: n }, () => ({ ...q(3), form }));

  it("**入组 0 例返回 null，不是 0** —— 还没开始录不等于录得干净", () => {
    const d = siteQueryDensity({ studySiteId: "s1", enrolled: 0, queries: rows(2) });
    expect(d.perSubject).toBeNull();
    expect(d.band).toBeNull();

    /* 原型写的是 `enrolled ? n/enrolled : 0`。那个 0 会在按密度排序时
       落到最干净的一端 —— 而那正是最该去看一眼的中心。 */
    expect(densityBand(0)).toBe("ok");
  });

  it("两条带按 0.2 / 0.4 划，边界不算进坏的一侧", () => {
    expect(densityBand(0.2)).toBe("ok");
    expect(densityBand(0.21)).toBe("watch");
    expect(densityBand(0.4)).toBe("watch");
    expect(densityBand(0.41)).toBe("bad");
  });

  it("密度算出来是条数除以入组例数", () => {
    const d = siteQueryDensity({ studySiteId: "s1", enrolled: 10, queries: rows(5) });
    expect(d.perSubject).toBeCloseTo(0.5, 6);
    expect(d.band).toBe("bad");
  });
});

describe("归因：表单问题还是录入问题", () => {
  const mk = (forms: string[]) =>
    siteQueryDensity({
      studySiteId: "s1", enrolled: 10,
      queries: forms.map(f => ({ ...q(3), form: f }))
    });

  it("**扎堆在一个表单上 → 是这个表单难填，不是这家中心差**", () => {
    const d = mk(["合并用药 CM", "合并用药 CM", "合并用药 CM", "不良事件 AE"]);
    expect(d.topForm).toBe("合并用药 CM");
    expect(d.topFormShare).toBeCloseTo(0.75, 6);
    expect(densityVerdict(d)).toBe("form");
  });

  it("散在各处 → 才是录入质量问题", () => {
    const d = mk(["合并用药 CM", "不良事件 AE", "实验室检查 LB", "生命体征 VS"]);
    expect(d.topFormShare).toBeCloseTo(0.25, 6);
    expect(densityVerdict(d)).toBe("entry");
  });

  it("两条质疑不下结论 —— 碰巧同一个表单说明不了什么", () => {
    expect(densityVerdict(mk(["合并用药 CM", "合并用药 CM"]))).toBe("too-few");
  });

  it("并列第一按表单名定序 —— 同一份数据不能给出两个「主要表单」", () => {
    const a = mk(["不良事件 AE", "合并用药 CM"]).topForm;
    const b = mk(["合并用药 CM", "不良事件 AE"]).topForm;
    expect(a).toBe(b);
  });

  it("没有质疑时没有主要表单", () => {
    const d = siteQueryDensity({ studySiteId: "s1", enrolled: 4, queries: [] });
    expect(d.topForm).toBeNull();
    expect(d.topFormShare).toBeNull();
    expect(d.perSubject).toBe(0);
  });
});
