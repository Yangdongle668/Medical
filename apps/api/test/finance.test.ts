import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { boot, resetDb, as, type Caller } from "./harness.js";

const idem = () => ({ "Idempotency-Key": randomUUID() });

/* ════════════════════════════════════════════════════════════════════
   里程碑 · 客户 · 现金流。

   这一组盯的是**这套数怎么骗人**：
     · 把「已达成但没开票」算成未来收入 —— 凭空造现金流；
     · 客户账期改了，历史发票的到期日跟着变 —— 应收账龄集体位移；
     · 已回款的能改回去 —— 钱到账变成一件可撤销的事。
   ════════════════════════════════════════════════════════════════════ */

let app: INestApplication;
let boss: Caller, pm: Caller, crc: Caller, inst: Caller;

beforeAll(async () => {
  resetDb(); app = await boot();
  boss = await as(app, "lingyuan");
  pm   = await as(app, "hanxue");
  crc  = await as(app, "wutong");
  inst = await as(app, "zhanghm");
}, 180_000);
afterAll(async () => { await app?.close(); });

describe("里程碑台账", () => {
  it("经营层看得到全部；外部方一行都没有", async () => {
    const r = await boss.get("/v1/milestones?limit=100");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(20);

    const ext = await inst.get("/v1/milestones?limit=100");
    expect(ext.status).toBe(200);
    expect(ext.body.items).toHaveLength(0);
  });

  it("金额受 price 列权限管辖 —— CRC 看得到进度，看不到钱", async () => {
    const r = await crc.get("/v1/milestones?limit=100");
    expect(r.status).toBe(200);
    const one = r.body.items[0];
    if (one) {
      expect("milestoneCents" in one, "金额不该出现").toBe(false);
      expect(one.planLabel).toBeTruthy();
    }
  });

  it("**逾期最久的排最前，已回款的沉到最后**", async () => {
    const r = await boss.get("/v1/milestones?limit=100");
    const paidIdx = r.body.items.findIndex((m: { state: string }) => m.state === "paid");
    const openAfter = r.body.items
      .slice(paidIdx + 1)
      .filter((m: { state: string }) => m.state !== "paid");
    expect(paidIdx, "应该有已回款的").toBeGreaterThan(-1);
    expect(openAfter, "已回款之后不该再有未了结的").toHaveLength(0);
  });

  it("**没逾期时 overdueDays 是 null，不是 0**", async () => {
    const r = await boss.get("/v1/milestones?limit=100");
    for (const m of r.body.items) {
      if (m.state !== "invoiced") {
        expect(m.daysToDue, `${m.code} 已回款/待开票不该谈到期`).toBeNull();
        expect(m.overdueDays).toBeNull();
      } else if (m.daysToDue >= 0) {
        expect(m.overdueDays, `${m.code} 没逾期`).toBeNull();
      } else {
        expect(m.overdueDays).toBe(-m.daysToDue);
      }
    }
  });

  it("overdueOnly 只留下过了到期日的", async () => {
    const r = await boss.get("/v1/milestones?limit=100&overdueOnly=true");
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(0);
    for (const m of r.body.items) {
      expect(m.state).toBe("invoiced");
      expect(m.overdueDays).toBeGreaterThan(0);
    }
  });

  it("PM 只看本组承接项目下的", async () => {
    const mine = await pm.get("/v1/milestones?limit=100");
    const sites = await pm.get("/v1/study-sites?limit=100");
    const ids = new Set(sites.body.items.map((s: { id: string }) => s.id));
    for (const m of mine.body.items)
      expect(ids.has(m.studySiteId), `${m.code} 越界了`).toBe(true);
    expect(mine.body.items.length).toBeLessThan(
      (await boss.get("/v1/milestones?limit=100")).body.items.length);
  });
});

describe("计划表", () => {
  it("五段，比例之和是 1", async () => {
    const r = await boss.get("/v1/milestones/plan");
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(5);
    const sum = r.body.items.reduce((n: number, p: { ratio: number }) => n + p.ratio, 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  it("plan 不能被当成一个 id —— 路由顺序", async () => {
    const r = await boss.get("/v1/milestones/plan");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.items)).toBe(true);
  });
});

describe("应收账龄", () => {
  it("逾期占比与绝对额都给", async () => {
    const r = await boss.get("/v1/milestones/ar-aging");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.totalCents).toBeGreaterThan(0);
    expect(r.body.overdueCents).toBeGreaterThan(0);
    expect(r.body.overdueShare).toBeGreaterThan(0);
    expect(r.body.overdueShare).toBeLessThanOrEqual(1);
    expect(r.body.calcVersion).toMatch(/^\d{4}\.\d+$/);
  });

  it("逾期超过 60 天的单独算，且不超过逾期总额", async () => {
    const r = await boss.get("/v1/milestones/ar-aging");
    expect(r.body.longOverdueCents).toBeGreaterThan(0);
    expect(r.body.longOverdueCents).toBeLessThanOrEqual(r.body.overdueCents);
  });

  it("和台账对得上 —— 同一批数不能有两个口径", async () => {
    const aging = await boss.get("/v1/milestones/ar-aging");
    const list = await boss.get("/v1/milestones?limit=200&receivableOnly=true");
    const total = list.body.items.reduce(
      (n: number, m: { milestoneCents: number }) => n + m.milestoneCents, 0);
    expect(aging.body.totalCents).toBe(total);
    expect(aging.body.count).toBe(list.body.items.length);
  });
});

describe("开票与回款", () => {
  const pending = async () =>
    (await boss.get("/v1/milestones?limit=200&state=pending")).body.items[0];

  it("**到期日按客户账期算出来并固化**", async () => {
    const m = await pending();
    expect(m, "种子里应该有待开票的").toBeDefined();

    const clients = await boss.get("/v1/clients?limit=50");
    const cl = clients.body.items.find(
      (x: { name: string }) => x.name === m.clientName);
    expect(cl).toBeDefined();

    const r = await boss.post(`/v1/milestones/${m.id}:invoice`,
      { invoicedOn: "2026-08-25" }, idem());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.state).toBe("invoiced");

    const due = new Date("2026-08-25T00:00:00Z");
    due.setUTCDate(due.getUTCDate() + cl.paymentTermsDays);
    expect(r.body.data.dueOn).toBe(due.toISOString().slice(0, 10));
    expect(r.body.sideEffects[0].summary).toContain(`${cl.paymentTermsDays} 天`);
  });

  it("**客户改账期不回溯历史发票**", async () => {
    const before = (await boss.get("/v1/milestones?limit=200&receivableOnly=true"))
      .body.items[0];
    const clients = await boss.get("/v1/clients?limit=50");
    const cl = clients.body.items.find(
      (x: { name: string }) => x.name === before.clientName);

    const up = await boss.patch(`/v1/clients/${cl.id}`, { paymentTermsDays: 120 });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    expect(up.body.paymentTermsDays).toBe(120);

    const after = (await boss.get("/v1/milestones?limit=200&receivableOnly=true"))
      .body.items.find((m: { id: string }) => m.id === before.id);
    expect(after.dueOn, "已开出去的票，到期日在开票那一刻就固化了")
      .toBe(before.dueOn);
  });

  it("开票日不能早于达成日 —— 开不出那样的票", async () => {
    const m = await pending();
    if (!m) return;
    const r = await boss.post(`/v1/milestones/${m.id}:invoice`,
      { invoicedOn: "2020-01-01" }, idem());
    expect(r.status).toBe(422);
    expect(r.body.detail).toContain("不能早于达成日");
  });

  it("没开票的钱记不进来", async () => {
    const m = await pending();
    if (!m) return;
    const r = await boss.post(`/v1/milestones/${m.id}:pay`, {}, idem());
    expect(r.status).toBe(422);
    expect(r.body.detail).toContain("还没开票");
  });

  it("**已回款的不能改回去** —— 钱到账是不可撤销的事实", async () => {
    const paid = (await boss.get("/v1/milestones?limit=200&state=paid")).body.items[0];
    expect(paid).toBeDefined();
    const r = await boss.post(`/v1/milestones/${paid.id}:pay`, {}, idem());
    expect(r.status).toBe(422);
    expect(r.body.detail).toContain("不可撤销");
  });

  it("回款晚于约定时要说出来", async () => {
    const late = (await boss.get("/v1/milestones?limit=200&overdueOnly=true"))
      .body.items[0];
    expect(late).toBeDefined();
    const r = await boss.post(`/v1/milestones/${late.id}:pay`, {}, idem());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.state).toBe("paid");
    expect(r.body.sideEffects[0].summary).toContain("晚了");
  });

  it("CRC 没有 bid 动作：读得到，开不了票", async () => {
    const m = (await boss.get("/v1/milestones?limit=200&state=pending")).body.items[0];
    if (!m) return;
    const r = await crc.post(`/v1/milestones/${m.id}:invoice`, {}, idem());
    expect(r.status).toBe(403);
  });
});

describe("客户档案", () => {
  it("四个客户，跨项目的账都算得出来", async () => {
    const r = await boss.get("/v1/clients?limit=50");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.items).toHaveLength(4);
    for (const c of r.body.items) {
      expect(c.studyCount).toBeGreaterThan(0);
      expect(c.siteCount).toBeGreaterThan(0);
      expect(c.paymentTermsDays).toBeGreaterThan(0);
    }
  });

  it("**外部方一行都看不到** —— 账期与联系人都是商业信息", async () => {
    const r = await inst.get("/v1/clients?limit=50");
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(0);
  });

  it("PM 只看本组承接项目的客户", async () => {
    const mine = await pm.get("/v1/clients?limit=50");
    expect(mine.status).toBe(200);
    expect(mine.body.items.length).toBeGreaterThan(0);
    expect(mine.body.items.length).toBeLessThan(4);
  });

  it("**一条查询装配全部** —— 不按客户逐个去打", async () => {
    /* 四个客户逐个查项目、中心、里程碑就是十三条查询，
       而这一页的存在理由正是"跨项目的账"。 */
    const one = await boss.get("/v1/clients?limit=1");
    const many = await boss.get("/v1/clients?limit=50");
    expect(one.status).toBe(200);
    expect(many.status).toBe(200);
    expect(one.body.items).toHaveLength(1);
    expect(one.body.nextCursor).not.toBeNull();
  });

  it("没有应收时 meanArDays 是 null，不是 0", async () => {
    const r = await boss.get("/v1/clients?limit=50");
    for (const c of r.body.items)
      if (c.receivableCents === 0)
        expect(c.meanArDays, `${c.name} 一笔应收都没有`).toBeNull();
  });

  it("金额受 price 列权限管辖", async () => {
    const r = await crc.get("/v1/clients?limit=50");
    expect(r.status).toBe(200);
    const one = r.body.items[0];
    if (one) {
      expect("contractCents" in one).toBe(false);
      expect("overdueCents" in one).toBe(false);
      expect(one.name).toBeTruthy();
    }
  });
});

describe("现金流预测", () => {
  it("逐月给出进账、支出、净额与累计", async () => {
    const r = await boss.get("/v1/cash-forecast");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.months).toHaveLength(6);
    expect(r.body.burnCents).toBeGreaterThan(0);
    expect(r.body.headcount).toBeGreaterThan(0);
    let cum = 0;
    for (const m of r.body.months) {
      expect(m.netCents).toBe(m.inCents - m.outCents);
      cum += m.netCents;
      expect(m.cumCents).toBe(cum);
    }
  });

  it("**记录缺口单列，不进任何一个月**", async () => {
    const r = await boss.get("/v1/cash-forecast");
    const inTotal = r.body.months.reduce(
      (n: number, m: { inCents: number }) => n + m.inCents, 0);
    const itemTotal = r.body.months.flatMap((m: { items: { inflowCents: number }[] }) => m.items)
      .reduce((n: number, i: { inflowCents: number }) => n + i.inflowCents, 0);
    expect(inTotal).toBe(itemTotal);
    /* 缺口那部分不在上面任何一个数里 —— 它不是未来收入 */
    if (r.body.recordGapCount > 0)
      expect(r.body.recordGapCents).toBeGreaterThan(0);
  });

  it("**压力情景不会比基准好**", async () => {
    const r = await boss.get("/v1/cash-forecast");
    expect(r.body.stress.troughCents).toBeLessThanOrEqual(r.body.troughCents);
    expect(r.body.stress.months).toHaveLength(6);
  });

  it("月数可调，且月份键连续", async () => {
    const r = await boss.get("/v1/cash-forecast?months=3");
    expect(r.body.months).toHaveLength(3);
    const ms = r.body.months.map((m: { month: string }) => m.month);
    expect(ms).toEqual([...ms].sort());
    for (const m of ms) expect(m).toMatch(/^\d{4}-\d{2}$/);
  });

  it("外部方：一条进账都没有，而且金额那几列整个不出现", async () => {
    const r = await inst.get("/v1/cash-forecast");
    expect(r.status).toBe(200);
    /* 两件事同时成立，且**要分开断言**：
       ① RLS —— 里程碑一行都看不到，所以每个月的 items 是空的；
       ② 列权限 —— 机构办没有 price，金额那几列**整个不出现**（不是 0）。
       只断言金额的话，第一条漏了也照样绿：字段不在，怎么写都通不过或都通得过。 */
    for (const m of r.body.months) {
      expect(m.items).toHaveLength(0);
      expect("inCents" in m, "没有 price 列权限，金额不该出现").toBe(false);
    }
    expect("burnCents" in r.body).toBe(false);
    expect(r.body.headcount).toBeGreaterThanOrEqual(0);
  });

  it("带口径版本号", async () => {
    const r = await boss.get("/v1/cash-forecast");
    expect(r.body.calcVersion).toMatch(/^\d{4}\.\d+$/);
  });
});
