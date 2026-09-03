import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { boot, resetDb, as, type Caller } from "./harness.js";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { LoginDelivery } from "../src/infra/login-delivery.js";
import { DEFAULT_STARTUP_ITEMS } from "@sitedesk/contracts";

/* ════════════════════════════════════════════════════════════════════
   Site & Staffing 的另外三块：启动清单 · 人员 · 交接

   这一组测试真正要证明的是：**Phase 3 里两处写死的东西现在是真的了** ——
   SIV 闸门去查启动清单，停用账号的「请先交接」指向一笔真实的交接单。
   ════════════════════════════════════════════════════════════════════ */

let app: INestApplication;
let boss: Caller, crcWu: Caller, crcGuo: Caller, cra: Caller, inst: Caller;
/* 立项受理的门是 `accept`，经营层没有它；而机构办张慧敏的行范围只到协和，
   测试新建的医院在她范围之外（= 不存在，404）。所以用管理员。 */
let admin: Caller;
const K = () => ({ "Idempotency-Key": randomUUID() });

beforeAll(async () => {
  resetDb(); app = await boot();
  boss   = await as(app, "lingyuan");
  crcWu  = await as(app, "wutong");
  crcGuo = await as(app, "guoxiaoxu");
  cra    = await as(app, "linmin");
  inst   = await as(app, "zhanghm");
  admin  = await as(app, "admin");
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

  it("撤销必须写原因、会警示，而且这个中心在台账上筛得出来", async () => {
    const s = await siteByCode(boss, "SS-05");          // 已处于 siv 阶段
    expect((await boss.get(`/v1/study-sites/${s.id}`)).body.startupInvalidated,
      "前置条件：这个中心一开始应当是正常的").toBe(false);

    const items = (await boss.get(`/v1/study-sites/${s.id}/startup-items`)).body.items;
    const doneBlocking = items.find((i: any) => i.doneAt && i.isBlocking);

    const noReason = await boss.post(`/v1/startup-items/${doneBlocking.id}:reopen`, {}, K());
    expect(noReason.status).toBe(422);

    const r = await boss.post(`/v1/startup-items/${doneBlocking.id}:reopen`,
      { reason: "复核发现该批件归档的是过期版本，需重新取得" }, K());
    expect(r.status).toBe(201);
    expect(r.body.data.doneAt).toBeNull();
    expect(r.body.sideEffects[0].summary).toContain("当初的启动条件现在不成立");

    /* 状态机**没有**被回退 —— 那是刻意的：一个已入组的中心被推回
       「合同签署」，那些访视就挂在了一个不存在的状态上。 */
    const after = await boss.get(`/v1/study-sites/${s.id}`);
    expect(after.body.state).toBe("siv");
    /* 但不回退不等于不记账：在此之前，撤销留下的唯一痕迹是上面那句
       转瞬即逝的 sideEffect 文案 —— 关掉页面就再也找不回来了。 */
    expect(after.body.startupInvalidated).toBe(true);

    const only = await boss.get("/v1/study-sites?limit=50&startupInvalidated=true");
    expect(only.body.items.map((x: { id: string }) => x.id)).toContain(s.id);
    /* 三态：传 false 才是"只看正常的"；不传是两种都要。 */
    const normal = await boss.get("/v1/study-sites?limit=50&startupInvalidated=false");
    expect(normal.body.items.map((x: { id: string }) => x.id)).not.toContain(s.id);
    const all = await boss.get("/v1/study-sites?limit=50");
    expect(all.body.items.map((x: { id: string }) => x.id)).toContain(s.id);

    /* 补做完，这一栏自己就消失了 —— 因为它是**算出来的**，不是存出来的。
       存一个布尔位就要在两处维护（撤销时置位、补做完时清位），
       漏掉任何一处，台账上就是一笔假账；而假的"没问题"比没有这一栏更糟。 */
    expect((await boss.post(`/v1/startup-items/${doneBlocking.id}:complete`,
      { note: "已重新取得批件并归档" }, K())).status).toBe(201);
    expect((await boss.get(`/v1/study-sites/${s.id}`)).body.startupInvalidated).toBe(false);
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

  it("推进必须写明原因，缺了是 422 而不是 500", async () => {
    /* 这条断言是从一个 500 里挖出来的。

       契约原来写着「siv / closed 这类不可逆节点时必填」，
       而 `SENSITIVE_ACTIONS` 里 `advanceStudySite` 是**无条件敏感**的 ——
       两处各说一套，缺原因时审计层抛裸 Error，出口变成
       「服务内部错误」。调用方被告知服务器坏了，于是去重试、去看监控，
       唯独不会去补那一栏。**把客户端的错说成服务端的故障，
       比不校验更糟：它把人引向完全错误的方向。**

       现在以策略为准收口：每一次推进都要写原因，缺了就是 422。 */
    const study = (await boss.get("/v1/studies?limit=1")).body.items[0];
    const hospital = `原因校验测试医院-${randomUUID().slice(0, 8)}`;
    const created = await boss.post("/v1/study-sites", {
      studyId: study.id, code: `RS-${randomUUID().slice(0, 8)}`,
      hospital, dept: "科", city: "北京",
      piName: "测试研究者", contracted: 5, unitPriceCents: 1000000
    });
    expect(created.status).toBe(201);
    const id = created.body.id;

    /* 迁移 0038 之后「伦理递交」也有闸门：机构没受理，材料递不到伦理。
       这条测的是**缺原因**，所以先把受理办掉 ——
       否则下面那三条会红在一个跟"原因"毫无关系的闸门上，
       而报错文案会把人引向完全错误的方向（正是这条断言当初挖出来的那种毛病）。 */
    const ac = await boss.post("/v1/site-acceptances",
      { studyId: study.id, hospital, docs: ["立项申请表", "方案及研究者手册"] });
    expect(ac.status, JSON.stringify(ac.body)).toBe(201);
    for (const d of ac.body.docs)
      expect((await admin.post(
        `/v1/site-acceptances/${ac.body.id}/docs/${d.seq}:set`,
        { present: true }, K())).status).toBe(201);
    expect((await admin.post(
      `/v1/site-acceptances/${ac.body.id}:accept`, {}, K())).status).toBe(201);

    /* 可逆节点也一样要写 —— 敏感与否看的是动作，不是目标状态 */
    const missing = await boss.post(`/v1/study-sites/${id}:advance`,
      { to: "irb_submit" }, K());
    expect(missing.status, JSON.stringify(missing.body)).toBe(422);
    expect(missing.body.code).toBe("validation-failed");
    expect(JSON.stringify(missing.body.issues)).toContain("reason");

    /* 空白不算原因 —— 否则这条规则等于一个必须按一下的空格键 */
    const blank = await boss.post(`/v1/study-sites/${id}:advance`,
      { to: "irb_submit", reason: "   " }, K());
    expect(blank.status).toBe(422);

    const ok = await boss.post(`/v1/study-sites/${id}:advance`,
      { to: "irb_submit", reason: "材料齐备，已向伦理递交" }, K());
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it("闸门未过时报的是闸门，不是「你还没填原因」", async () => {
    /* 顺序要紧：**闸门在前，原因在后。**
       反过来的话，一个还没把阻塞项清完的人先被要求"填个原因"，
       填完再被告知"还差 8 项" —— 两次都答非所问。

       （body 的 schema 校验确实跑在闸门之前，但那一层只管"有没有填"；
        这里验的是**填了以后**，先报的仍是闸门而不是别的。） */
    const s = await siteByCode(boss, "SS-13");        // irb_submit，先推到 contract
    for (const to of ["irb_approve", "contract"])
      expect((await boss.post(`/v1/study-sites/${s.id}:advance`,
        { to, reason: "按流程推进至下一节点" }, K())).status).toBe(201);

    const r = await boss.post(`/v1/study-sites/${s.id}:advance`,
      { to: "siv", reason: "想直接启动" }, K());
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("gate-not-satisfied");
    expect(r.body.unmet[0].module).toBe("startup");
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
    /* 15 = 14 在职 + 1 已离职。**离职的人留在名册里**：
       「谁离职了、他的中心谁接的」是交接台账要回答的问题，
       把人从名册上抹掉等于抹掉那段历史。 */
    expect(r.body.items.length).toBe(15);
    const wt = r.body.items.find((s: { login: string }) => s.login === "wutong");
    expect(wt).toMatchObject({ roleKind: "CRC", level: "高级", city: "北京", active: true });
    expect(wt.gcpDaysLeft).toBeTypeOf("number");
  });

  it("已离职的人留在名册里，但带着停用原因 —— 而 activeOnly 能把他们筛掉", async () => {
    /* 在此之前这件事只是**碰巧**成立：种子里没有任何一个停用账号有
       staff 行，于是"发起交接不会选到离职的人"没有任何测试守着。 */
    const all = await boss.get("/v1/staff?limit=50");
    const gone = all.body.items.find((s: { login: string }) => s.login === "zhouqi");
    expect(gone, "名册里应当留着已离职的周琦").toBeTruthy();
    expect(gone.active).toBe(false);
    expect(gone.disabledReason).toContain("离职");

    const onlyActive = await boss.get("/v1/staff?limit=50&activeOnly=true");
    expect(onlyActive.body.items.map((s: { login: string }) => s.login))
      .not.toContain("zhouqi");
    for (const s of onlyActive.body.items) expect(s.active).toBe(true);
  });

  it("activeOnly=false 是「两种都要」，不是被读成 true", async () => {
    /* QueryBool 之前，?activeOnly=false 会被 Boolean("false") 读成 true。 */
    const r = await boss.get("/v1/staff?limit=50&activeOnly=false");
    expect(r.body.items.map((s: { login: string }) => s.login)).toContain("zhouqi");
  });

  it("把中心交给一个已离职的人 → 被拒", async () => {
    const mine = (await crcWu.get("/v1/study-sites?limit=10")).body.items[0];
    const gone = (await boss.get("/v1/staff?limit=50")).body.items
      .find((s: { login: string }) => s.login === "zhouqi");
    const r = await crcWu.post("/v1/handovers", {
      toAccountId: gone.accountId, studySiteIds: [mine.id],
      reason: "交给一个已经离职的人", plannedOn: "2026-09-10"
    });
    /* 交给一个登不进来的人，等于把中心交给一个没人的位置 */
    expect(r.status).toBe(422);
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

  it("发起交接会**通知接手人** —— 在此之前他完全不知道有这回事", async () => {
    /* 交接是发起人单方面做的动作：他填表、勾清单、点发起。
       没有通知的话，"交接"实际发生在微信群里，系统只是事后记账。

       盯住通道本身，而不是日志：日志格式会变，"这条通知有没有发出去"
       不会。投递在提交之后异步发生，所以下面要等一个事件循环回合。 */
    const sent = vi.spyOn(LoginDelivery.prototype, "notify");
    try {
      const mine = (await crcWu.get("/v1/study-sites?limit=10")).body.items[1];
      const to = (await boss.get("/v1/staff?limit=50")).body.items
        .find((s: { login: string }) => s.login === "shenyilin");
      const r = await crcWu.post("/v1/handovers", {
        toAccountId: to.accountId, studySiteIds: [mine.id],
        reason: "通知验证：发起之后接手人应当收到消息", plannedOn: "2026-09-25"
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      await new Promise(res => setTimeout(res, 100));

      expect(sent, "发起交接没有通知任何人").toHaveBeenCalled();
      const m = sent.mock.calls[0]![0];
      expect(m.subject).toContain("交接给你");
      /* 正文要说得出**是哪几个中心**，否则收信人还得再登进来查 */
      expect(m.text).toContain("SS-");
      /* 收件地址只认库里登记的那个 —— 与登录链接同一条规矩 */
      expect(m.to).toContain("@");
    } finally { sent.mockRestore(); }
  });

  it("通知发不出去，交接照样成立 —— 拿小问题去制造大问题是最坏的选择", async () => {
    const boom = vi.spyOn(LoginDelivery.prototype, "notify")
      .mockRejectedValue(new Error("SMTP 网关超时"));
    try {
      const mine = (await crcWu.get("/v1/study-sites?limit=10")).body.items[0];
      const to = (await boss.get("/v1/staff?limit=50")).body.items
        .find((s: { login: string }) => s.login === "shenyilin");
      const r = await crcWu.post("/v1/handovers", {
        toAccountId: to.accountId, studySiteIds: [mine.id],
        reason: "通知失败不该让一笔已经写进库的交接回滚", plannedOn: "2026-09-26"
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      await new Promise(res => setTimeout(res, 100));
      /* 单子确实在库里 */
      const got = await crcWu.get(`/v1/handovers?limit=50`);
      expect(got.body.items.map((x: { id: string }) => x.id)).toContain(r.body.id);
    } finally { boom.mockRestore(); }
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

  it("交接进行中，接手人**已经**看得到那几个中心 —— 交底之前要能自己核对", async () => {
    /* 清单里最要命的一项是「在组受试者逐例交底」。在此之前接手人
       连一张名单都对不上：他勾"已确认"的时候，确认的是自己听懂了，
       不是自己核对过。 */
    const shen = await as(app, "shenyilin");
    const h = (await crcWu.get(`/v1/handovers?limit=50`)).body.items
      .find((x: { id: string }) => x.id === hid);
    const siteId = h.sites[0].id;

    const seen = (await shen.get("/v1/study-sites?limit=50")).body.items
      .map((x: { id: string }) => x.id);
    expect(seen, "交接进行中，接手人应当看得到这个中心").toContain(siteId);

    /* 而受试者也看得到 —— 只看得到中心而看不到人，等于没解决问题 */
    const subs = await shen.get(`/v1/subjects?studySiteId=${siteId}&limit=5`);
    expect(subs.status).toBe(200);
  });

  it("完成交接会真的转移派工 —— 原负责人随即看不到了", async () => {
    const beforeWu = (await crcWu.get("/v1/study-sites?limit=50")).body.items.length;
    const shen = await as(app, "shenyilin");
    const h = (await crcWu.get(`/v1/handovers?limit=50`)).body.items
      .find((x: { id: string }) => x.id === hid);
    const siteId = h.sites[0].id;

    const r = await crcWu.post(`/v1/handovers/${hid}:complete`, {}, K());
    expect(r.status).toBe(201);
    expect(r.body.data.status).toBe("completed");
    expect(r.body.sideEffects[0].summary).toContain("派工已由 吴桐 转至 沈亦琳");

    expect((await crcWu.get("/v1/study-sites?limit=50")).body.items.length).toBe(beforeWu - 1);
    /* 接手人这边**数目不变** —— 他在交接期间就看得到了。
       变的是性质：从一段会过期的临时可见性，变成正式派工。
       重开会话才看得出这一点：临时那段是按 status='pending' 算的。 */
    const shenAfter = await as(app, "shenyilin");
    expect((await shenAfter.get("/v1/study-sites?limit=50")).body.items
      .map((x: { id: string }) => x.id)).toContain(siteId);
  });

  it("单子一不是 pending，那段临时可见性立刻没了 —— 它自己过期，不用谁回收", async () => {
    const mine = (await crcWu.get("/v1/study-sites?limit=10")).body.items[0];
    const to = (await boss.get("/v1/staff?limit=50")).body.items
      .find((s: { login: string }) => s.login === "shenyilin");
    const made = await crcWu.post("/v1/handovers", {
      toAccountId: to.accountId, studySiteIds: [mine.id],
      reason: "临时可见性到期验证：发起之后置为已取消", plannedOn: "2026-09-20"
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);

    const during = await as(app, "shenyilin");
    expect((await during.get("/v1/study-sites?limit=50")).body.items
      .map((x: { id: string }) => x.id)).toContain(mine.id);

    /* 直接改库：**目前还没有"取消交接"这个端点**（`cancelled` 是
       schema 允许但没人设置的状态）。这条用例验的是可见性跟着 status 走，
       不是那个端点 —— 补端点是另一件事，不该顺手长在这里。

       前面几条用例也给这个中心排过交接单，所以要把**这个中心的**
       在途单子全部收掉：只改自己那一笔的话，别的单子还开着，
       可见性照样成立，而报错会说成"过期没生效"。 */
    const db = new pg.Client({ connectionString: process.env["TEST_DATABASE_URL"] });
    await db.connect();
    try {
      await db.query(
        `UPDATE handover SET status = 'cancelled'
          WHERE status = 'pending' AND id IN (
            SELECT handover_id FROM handover_site WHERE study_site_id = $1)`, [mine.id]);
    } finally { await db.end(); }

    const after = await as(app, "shenyilin");
    expect((await after.get("/v1/study-sites?limit=50")).body.items
      .map((x: { id: string }) => x.id)).not.toContain(mine.id);
  });

  it("由**接手人**收单，派工同样要真的转移 —— 这条曾经静默失败", async () => {
    /* 上面那条是**原负责人自己**收的单：他看得见自己的派工，所以转移一直是通的。
       而真实场景里更常见的是接手人确认完清单顺手收单 —— 那条路上，
       接手人此刻还看不见这些中心（他正是因为**还没接手**才在做这件事），
       于是 RLS 让「查原负责人的派工」回 0 行，转移被 `continue` 静默跳过：
       接口 201、交接单「已完成」、派工原地不动，两个人都以为交完了。

       整个套件此前只走过 from 那一侧，所以它一直是绿的 ——
       这条断言的价值全在于它走的是**另一侧**。 */
    const mine = (await crcWu.get("/v1/study-sites?limit=10")).body.items[0];
    expect(mine, "吴桐至少还要剩一个中心可交接").toBeTruthy();
    const to = (await boss.get("/v1/staff?limit=50")).body.items
      .find((s: { login: string }) => s.login === "shenyilin");

    const created = await crcWu.post("/v1/handovers", {
      toAccountId: to.accountId, studySiteIds: [mine.id],
      reason: "接手人收单：产假交接，为期六个月", plannedOn: "2026-09-05"
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id;

    const shen = await as(app, "shenyilin");
    for (let seq = 0; seq < 8; seq++)
      expect((await shen.post(`/v1/handovers/${id}/items/${seq}:done`, {}, K())).status)
        .toBe(201);

    const r = await shen.post(`/v1/handovers/${id}:complete`, {}, K());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.sideEffects.some((e: { summary: string }) =>
      e.summary.includes("派工已由"))).toBe(true);

    /* **落库了才算。** 只断言 sideEffects 会把「文案对了」当成「事做了」——
       而这个 bug 的原形正是文案没了、事也没做，却回了 201。 */
    expect((await shen.get(`/v1/study-sites/${mine.id}`)).status).toBe(200);
    expect((await crcWu.get(`/v1/study-sites/${mine.id}`)).status).toBe(404);
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
