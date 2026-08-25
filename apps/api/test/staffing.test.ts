import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { boot, resetDb, as, type Caller } from "./harness.js";
import { randomUUID } from "node:crypto";
import { DEFAULT_STARTUP_ITEMS } from "@sitedesk/contracts";

/* ════════════════════════════════════════════════════════════════════
   Site & Staffing 的另外三块：启动清单 · 人员 · 交接

   这一组测试真正要证明的是：**Phase 3 里两处写死的东西现在是真的了** ——
   SIV 闸门去查启动清单，停用账号的「请先交接」指向一笔真实的交接单。
   ════════════════════════════════════════════════════════════════════ */

let app: INestApplication;
let boss: Caller, crcWu: Caller, crcGuo: Caller, cra: Caller, inst: Caller;
const K = () => ({ "Idempotency-Key": randomUUID() });

beforeAll(async () => {
  resetDb(); app = await boot();
  boss   = await as(app, "lingyuan");
  crcWu  = await as(app, "wutong");
  crcGuo = await as(app, "guoxiaoxu");
  cra    = await as(app, "linmin");
  inst   = await as(app, "zhanghm");
}, 120_000);
afterAll(async () => { await app?.close(); });

const siteByCode = async (c: Caller, code: string) =>
  (await c.get(`/v1/study-sites?limit=200&q=${code}`)).body.items
    .find((s: { code: string }) => s.code === code);

describe("启动清单", () => {
  it("按 8 类分组，带阻塞项与逾期天数", async () => {
    const s = await siteByCode(boss, "SS-13");
    const r = await boss.get(`/v1/study-sites/${s.id}/startup-items`);
    expect(r.status).toBe(200);
    expect(r.body.siteCode).toBe("SS-13");
    expect(r.body.total).toBeGreaterThan(10);
    expect(r.body.blockingOpen).toBeGreaterThan(0);
    expect(r.body.daysToSiv).toBeTypeOf("number");
    const cats = new Set(r.body.items.map((i: { category: string }) => i.category));
    expect(cats.size).toBeGreaterThanOrEqual(6);
    /* 逾期项要能自己算出来，不靠人工标注 */
    const overdue = r.body.items.filter((i: { overdueDays: number | null }) => i.overdueDays !== null);
    expect(overdue.length).toBe(r.body.overdue);
    for (const i of overdue) expect(i.overdueDays).toBeGreaterThan(0);
  });

  it("CRC 只看得到自己中心的清单；范围外 404", async () => {
    const mine = await siteByCode(crcGuo, "SS-13");
    expect((await crcGuo.get(`/v1/study-sites/${mine.id}/startup-items`)).status).toBe(200);
    const other = await siteByCode(boss, "SS-05");
    expect((await crcGuo.get(`/v1/study-sites/${other.id}/startup-items`)).status).toBe(404);
  });

  it("完成一项：记下时间**和人**，并留下审计轨迹", async () => {
    const s = await siteByCode(crcGuo, "SS-13");
    const list = await crcGuo.get(`/v1/study-sites/${s.id}/startup-items`);
    const open = list.body.items.find((i: { doneAt: string | null }) => !i.doneAt);

    const r = await crcGuo.post(`/v1/startup-items/${open.id}:complete`,
      { note: "伦理会议已答辩，补充材料已提交" }, K());
    expect(r.status).toBe(201);
    expect(r.body.data.doneAt).toBeTruthy();
    expect(r.body.data.doneByName).toBe("郭晓萱");

    const trail = await crcGuo.get(
      `/v1/audit-entries?targetType=startup_item&targetId=${encodeURIComponent(open.item)}`);
    expect(trail.body.items[0].action).toBe("完成启动清单项");
    expect(trail.body.items[0].actorLogin).toBe("guoxiaoxu");
  });

  it("重复完成同一项 → 409（不是静默成功）", async () => {
    const s = await siteByCode(crcGuo, "SS-13");
    const done = (await crcGuo.get(`/v1/study-sites/${s.id}/startup-items`))
      .body.items.find((i: { doneAt: string | null }) => i.doneAt);
    const r = await crcGuo.post(`/v1/startup-items/${done.id}:complete`, {}, K());
    expect(r.status).toBe(409);
  });

  it("撤销必须写原因，且会警示该中心当初的启动条件已不成立", async () => {
    const s = await siteByCode(boss, "SS-05");          // 已处于 siv 阶段
    const items = (await boss.get(`/v1/study-sites/${s.id}/startup-items`)).body.items;
    const doneBlocking = items.find((i: any) => i.doneAt && i.isBlocking);

    const noReason = await boss.post(`/v1/startup-items/${doneBlocking.id}:reopen`, {}, K());
    expect(noReason.status).toBe(422);

    const r = await boss.post(`/v1/startup-items/${doneBlocking.id}:reopen`,
      { reason: "复核发现该批件归档的是过期版本，需重新取得" }, K());
    expect(r.status).toBe(201);
    expect(r.body.data.doneAt).toBeNull();
    expect(r.body.sideEffects[0].summary).toContain("当初的启动条件现在不成立");
  });
});

describe("SIV 闸门：Phase 3 的 unavailable 占位现在是真查询了", () => {
  it("阻塞项未清零 → 拦下，并逐条列出还差什么", async () => {
    const s = await siteByCode(boss, "SS-14");          // contract 阶段
    const g = await boss.get(`/v1/study-sites/${s.id}/gate`);
    expect(g.body).toMatchObject({ from: "contract", to: "siv", satisfied: false });
    const item = g.body.unmet.find((u: { code: string }) => u.code === "startup-blockers");
    expect(item.module).toBe("startup");
    /* 关键：消息里是**真实的清单项名字**，不再是「该模块尚未交付」 */
    expect(item.message).toMatch(/仍有 \d+ 项阻塞未完成/);
    expect(item.message).not.toContain("尚未交付");

    const adv = await boss.post(`/v1/study-sites/${s.id}:advance`,
      { to: "siv", reason: "准备启动该中心" }, K());
    expect(adv.status).toBe(422);
    expect(adv.body.code).toBe("gate-not-satisfied");
  });

  it("把阻塞项逐一清零后，闸门放行，中心可推进到 SIV", async () => {
    const s = await siteByCode(boss, "SS-14");
    let list = await boss.get(`/v1/study-sites/${s.id}/startup-items`);
    for (const i of list.body.items.filter((x: any) => x.isBlocking && !x.doneAt))
      expect((await boss.post(`/v1/startup-items/${i.id}:complete`, {}, K())).status).toBe(201);

    list = await boss.get(`/v1/study-sites/${s.id}/startup-items`);
    expect(list.body.blockingOpen).toBe(0);

    const g = await boss.get(`/v1/study-sites/${s.id}/gate`);
    expect(g.body.satisfied).toBe(true);

    const adv = await boss.post(`/v1/study-sites/${s.id}:advance`,
      { to: "siv", reason: "启动阻塞项已全部清零" }, K());
    expect(adv.status).toBe(201);
    expect(adv.body.data.state).toBe("siv");
    expect(adv.body.data.sivOn).toBeTruthy();
  });

  it("新建的中心自动铺开标准清单 —— 否则闸门对每个新中心都是默认放行", async () => {
    const study = (await boss.get("/v1/studies?limit=1")).body.items[0];
    const r = await boss.post("/v1/study-sites", {
      studyId: study.id, code: `SS-NEW${Date.now() % 100000}`,
      hospital: "新建中心测试医院", dept: "肿瘤科", city: "杭州",
      piName: "测试研究者", contracted: 8, unitPriceCents: 1200000,
      sivPlannedOn: "2026-12-01"
    }, K());
    expect(r.status).toBe(201);

    const list = await boss.get(`/v1/study-sites/${r.body.id}/startup-items`);
    expect(list.body.total).toBe(DEFAULT_STARTUP_ITEMS.length);
    expect(list.body.done).toBe(0);
    expect(list.body.blockingOpen)
      .toBe(DEFAULT_STARTUP_ITEMS.filter(t => t.blocking).length);
    /* 到期日按计划 SIV 日倒推，不是一律留空 */
    expect(list.body.items.every((i: { dueOn: string | null }) => i.dueOn)).toBe(true);

    /* 这才是重点：清单铺开了，闸门才真的关着 */
    const g = await boss.get(`/v1/study-sites/${r.body.id}/gate?to=siv`);
    expect(g.body.satisfied).toBe(false);
  });

  it("未排 SIV 日的中心，清单照样铺开，只是到期日留空", async () => {
    const study = (await boss.get("/v1/studies?limit=1")).body.items[0];
    const r = await boss.post("/v1/study-sites", {
      studyId: study.id, code: `SS-NOD${Date.now() % 100000}`,
      hospital: "未排期测试医院", dept: "心内科", city: "成都",
      piName: "测试研究者", contracted: 6, unitPriceCents: 900000
    }, K());
    const list = await boss.get(`/v1/study-sites/${r.body.id}/startup-items`);
    expect(list.body.total).toBe(DEFAULT_STARTUP_ITEMS.length);
    expect(list.body.items.every((i: { dueOn: string | null }) => i.dueOn === null)).toBe(true);
    expect(list.body.overdue).toBe(0);
  });

  it("清空最后一个阻塞项时，sideEffects 主动告知「可推进 SIV」", async () => {
    const s = await siteByCode(boss, "SS-13");
    const items = (await boss.get(`/v1/study-sites/${s.id}/startup-items`)).body.items
      .filter((x: any) => x.isBlocking && !x.doneAt);
    let last: any;
    for (const i of items) last = await boss.post(`/v1/startup-items/${i.id}:complete`, {}, K());
    expect(last.body.sideEffects[0].summary).toContain("可以推进到「SIV启动」");
  });
});

describe("人员：account 之外的作业属性", () => {
  it("列出工种、司职、GCP 剩余天数与带教/继任者", async () => {
    const r = await boss.get("/v1/staff?limit=50");
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBe(14);
    const wt = r.body.items.find((s: { login: string }) => s.login === "wutong");
    expect(wt).toMatchObject({ roleKind: "CRC", level: "高级", city: "北京" });
    expect(wt.gcpDaysLeft).toBeTypeOf("number");
  });

  it("「带 3 个以上中心却没有继任者」可以直接筛出来", async () => {
    const r = await boss.get("/v1/staff?limit=50&successionGap=true");
    expect(r.body.items.length).toBeGreaterThan(0);
    for (const s of r.body.items) {
      expect(s.siteCount).toBeGreaterThanOrEqual(3);
      expect(s.successorName).toBeNull();
    }
  });

  it("外部方看不到员工名册 —— 那与机构履行监管职责无关", async () => {
    const r = await inst.get("/v1/staff?limit=50");
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(0);
  });
});

describe("交接：中心不会因为人休假就停下", () => {
  let hid: string;

  it("只能交接自己当前负责的中心", async () => {
    const notMine = await siteByCode(boss, "SS-09");
    const to = (await boss.get("/v1/staff?limit=50")).body.items
      .find((s: { login: string }) => s.login === "shenyilin");
    const r = await crcWu.post("/v1/handovers", {
      toAccountId: to.accountId, studySiteIds: [notMine.id],
      reason: "试图交接一个不属于自己的中心", plannedOn: "2026-09-10"
    });
    expect(r.status).toBe(422);
    expect(r.body.invariant).toBe("handover-only-own-sites");
  });

  it("接手人必须同工种 —— CRA 与 CRC 不能互相顶替", async () => {
    const mine = (await crcWu.get("/v1/study-sites?limit=10")).body.items[0];
    const craAcc = (await boss.get("/v1/staff?limit=50")).body.items
      .find((s: { login: string }) => s.login === "zhaokun");
    const r = await crcWu.post("/v1/handovers", {
      toAccountId: craAcc.accountId, studySiteIds: [mine.id],
      reason: "把 CRC 的中心交给 CRA", plannedOn: "2026-09-10"
    });
    expect(r.status).toBe(422);
    expect(r.body.invariant).toBe("handover-same-role-kind");
  });

  it("发起交接会自动生成 8 项清单，其中包含「在组受试者逐例交底」", async () => {
    const mine = (await crcWu.get("/v1/study-sites?limit=10")).body.items[0];
    const to = (await boss.get("/v1/staff?limit=50")).body.items
      .find((s: { login: string }) => s.login === "shenyilin");
    const r = await crcWu.post("/v1/handovers", {
      toAccountId: to.accountId, studySiteIds: [mine.id],
      reason: "09-02 至 09-04 年假，期间有两例访视窗口", plannedOn: "2026-08-29"
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.totalCount).toBe(8);
    expect(r.body.items.map((i: { item: string }) => i.item))
      .toContain("在组受试者逐例交底（含联系方式与依从性）");
    hid = r.body.id;
  });

  it("清单未逐项确认不得完成 —— 签了字但受试者没交底，等于没交接", async () => {
    const r = await crcWu.post(`/v1/handovers/${hid}:complete`, {}, K());
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("gate-not-satisfied");
    expect(r.body.unmet.length).toBe(8);
  });

  it("逐项确认，最后一项完成时 sideEffects 提示可以收单", async () => {
    let last: any;
    for (let seq = 0; seq < 8; seq++)
      last = await crcWu.post(`/v1/handovers/${hid}/items/${seq}:done`, {}, K());
    expect(last.status).toBe(201);
    expect(last.body.data.doneCount).toBe(8);
    expect(last.body.sideEffects[0].summary).toContain("可以完成这笔交接");
  });

  it("完成交接会真的转移派工 —— 双方的行范围随即改变", async () => {
    const beforeWu = (await crcWu.get("/v1/study-sites?limit=50")).body.items.length;
    const shen = await as(app, "shenyilin");
    const beforeShen = (await shen.get("/v1/study-sites?limit=50")).body.items.length;

    const r = await crcWu.post(`/v1/handovers/${hid}:complete`, {}, K());
    expect(r.status).toBe(201);
    expect(r.body.data.status).toBe("completed");
    expect(r.body.sideEffects[0].summary).toContain("派工已由 吴桐 转至 沈亦琳");

    expect((await crcWu.get("/v1/study-sites?limit=50")).body.items.length).toBe(beforeWu - 1);
    expect((await shen.get("/v1/study-sites?limit=50")).body.items.length).toBe(beforeShen + 1);
  });

  it("交接完成后，原负责人不能再看那个中心（404，不是 403）", async () => {
    const h = (await boss.get(`/v1/handovers?limit=20`)).body.items
      .find((x: { id: string }) => x.id === hid);
    const moved = h.sites[0];
    expect((await crcWu.get(`/v1/study-sites/${moved.id}`)).status).toBe(404);
    const shen = await as(app, "shenyilin");
    expect((await shen.get(`/v1/study-sites/${moved.id}`)).status).toBe(200);
  });
});

describe("停用账号的闸门现在指向真实交接单", () => {
  it("仍带中心 → 拦下；已有待完成交接单时提示改为「去完成它」", async () => {
    const acc = (await boss.get("/v1/accounts?limit=200")).body.items
      .find((a: { login: string }) => a.login === "tangyan");
    const first = await boss.post(`/v1/accounts/${acc.id}:disable`,
      { reason: "离职办理，账号停用但记录保留" }, K());
    expect(first.status, JSON.stringify(first.body)).toBe(422);
    expect(first.body.detail).toContain("请先发起交接");

    /* 唐延自己发起一笔交接 */
    const ty = await as(app, "tangyan");
    const mine = (await ty.get("/v1/study-sites?limit=10")).body.items;
    const to = (await boss.get("/v1/staff?limit=50")).body.items
      .find((s: { login: string }) => s.login === "fengle");
    const h = await ty.post("/v1/handovers", {
      toAccountId: to.accountId, studySiteIds: mine.map((m: { id: string }) => m.id),
      reason: "离职交接，全部中心移交", plannedOn: "2026-09-01"
    });
    expect(h.status).toBe(201);

    const second = await boss.post(`/v1/accounts/${acc.id}:disable`,
      { reason: "离职办理，账号停用但记录保留" }, K());
    expect(second.status).toBe(422);
    expect(second.body.detail).toContain("已有一笔待完成的交接单");
  });
});
