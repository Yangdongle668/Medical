import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { boot, resetDb, as, type Caller } from "./harness.js";
import { randomUUID } from "node:crypto";

/* ════════════════════════════════════════════════════════════════════
   立项受理与中心文件（ISF）。

   这一组钉住的，是三件在别处很容易被抹平的区别：

   ① **材料齐备 ≠ 已受理。** 齐备是清单算出来的，受理是机构的一次决定。
      把两者合成一个状态，「谁受理的、哪天受理的」就没有答案了。

   ② **空清单有两种意思。** 本系统办的受理，空清单是「八项都齐」；
      系统外登记的存根，空清单是「没人在这儿查过」——
      混起来，界面就会对着一条谁也没审过的记录报「材料齐备」。

   ③ **ISF 的状态是算出来的。** 同一行事实，今天 due、三个月后 expired，
      而库里那一行一个字都没变过。
   ════════════════════════════════════════════════════════════════════ */

let app: INestApplication;
let pm: Caller, inst: Caller, admin: Caller, crc: Caller, cra: Caller;
beforeAll(async () => {
  resetDb(); app = await boot();
  pm = await as(app, "hanxue");
  /* 机构办张慧敏的行范围是「北京协和医院」—— 受理这件事本来就该由她做，
     所以这个文件用协和的中心跑，而不是像闸门那组那样借管理员。 */
  inst = await as(app, "zhanghm");
  admin = await as(app, "admin");
  crc = await as(app, "wutong");
  cra = await as(app, "linmin");
}, 120_000);
afterAll(async () => { await app?.close(); });

const key = () => ({ "Idempotency-Key": randomUUID() });

describe("受理：形式审查只看材料齐不齐，但它是一道真闸门", () => {
  it("**递进去一律未勾** —— 递交方自己勾完再递，形式审查就没有意义了", async () => {
    const studies = await pm.get("/v1/studies?limit=1");
    const r = await pm.post("/v1/site-acceptances", {
      studyId: studies.body.items[0].id, hospital: "苏州大学附属第一医院",
      docs: ["立项申请表", "方案及研究者手册", "保险单"]
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.state).toBe("review");
    expect(r.body.origin).toBe("in_system");
    expect(r.body.presentDocs).toBe(0);
    expect(r.body.missingDocs).toEqual(
      ["立项申请表", "方案及研究者手册", "保险单"]);
    /* 受理号按当年最大号 + 1 发 —— 种子里 2026 年最大的是 041。 */
    expect(r.body.code).toMatch(/^AC-\d{4}-\d{3}$/);
    expect(r.body.acceptedOn).toBeNull();
    expect(r.body.acceptedByName).toBeNull();
  });

  it("一家医院在同一个项目上只有一次受理 —— 补正重交走的是同一条", async () => {
    const studies = await pm.get("/v1/studies?limit=1");
    const body = {
      studyId: studies.body.items[0].id, hospital: "厦门大学附属中山医院",
      docs: ["立项申请表", "保险单"]
    };
    expect((await pm.post("/v1/site-acceptances", body)).status).toBe(201);
    const again = await pm.post("/v1/site-acceptances", body);
    expect(again.status).toBe(422);
    expect(again.body.invariant).toBe("acceptance-duplicate");
    expect(again.body.detail).toContain("补正重交走的是同一条");
  });

  it("**同名两遍的清单勾不干净** —— 勾了一个另一个还缺着", async () => {
    const studies = await pm.get("/v1/studies?limit=1");
    const r = await pm.post("/v1/site-acceptances", {
      studyId: studies.body.items[0].id, hospital: "青岛大学附属医院",
      docs: ["保险单", "立项申请表", "保险单"]
    });
    expect(r.status).toBe(422);
    expect(r.body.invariant).toBe("acceptance-docs-duplicate");
  });

  it("**受理是医院的动作，不是我方的** —— PM 递得了材料，受理不了", async () => {
    const list = await inst.get("/v1/site-acceptances?openOnly=true");
    const a = list.body.items[0];
    expect(a, "种子里协和有两条还没受理的").toBeTruthy();
    const r = await pm.post(`/v1/site-acceptances/${a.id}:accept`, {}, key());
    expect(r.status, "借我方的角色受理，等于自己受理自己递的材料").toBe(403);
  });

  it("材料不齐不予受理，而且要列出缺的那几份的**名字**", async () => {
    const list = await inst.get("/v1/site-acceptances?openOnly=true");
    const a = list.body.items.find((x: { missingDocs: string[] }) =>
      x.missingDocs.length > 0);
    expect(a).toBeTruthy();
    const r = await inst.post(`/v1/site-acceptances/${a.id}:accept`, {}, key());
    expect(r.status).toBe(422);
    expect(r.body.invariant).toBe("acceptance-docs-missing");
    for (const name of a.missingDocs) expect(r.body.detail).toContain(name);
  });

  it("补正通知要说清缺什么 —— 一句「材料不齐」等于让人重寄八份", async () => {
    const list = await inst.get("/v1/site-acceptances?openOnly=true");
    const a = list.body.items.find((x: { missingDocs: string[] }) =>
      x.missingDocs.length > 0);
    const r = await inst.post(`/v1/site-acceptances/${a.id}:amend`,
      { reason: `请补齐：${a.missingDocs.join("、")}` }, key());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.state).toBe("amend");
    expect(r.body.data.amendNote).toContain(a.missingDocs[0]);
    expect(r.body.sideEffects[0].summary).toContain(a.missingDocs[0]);
  });

  it("勾齐 → 受理 → 清单冻结：受理通知发出去了，清单就不该再动", async () => {
    const list = await inst.get("/v1/site-acceptances?openOnly=true");
    const a = list.body.items.find((x: { missingDocs: string[] }) =>
      x.missingDocs.length > 0);
    for (const d of a.docs.filter((d: { present: boolean }) => !d.present)) {
      const r = await inst.post(
        `/v1/site-acceptances/${a.id}/docs/${d.seq}:set`, { present: true }, key());
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
    /* 齐备不等于受理 —— 出具受理通知是机构的一次决定。 */
    const ready = await inst.get(`/v1/site-acceptances?studyId=${a.studyId}`);
    const now = ready.body.items.find((x: { id: string }) => x.id === a.id);
    expect(now.missingDocs).toEqual([]);
    expect(now.state).not.toBe("accepted");

    const ok = await inst.post(`/v1/site-acceptances/${a.id}:accept`, {}, key());
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data.state).toBe("accepted");
    expect(ok.body.data.acceptedByName).toBe("张慧敏");
    expect(ok.body.data.acceptedOn).not.toBeNull();
    /* 这两条受理都还没建档 —— 「受理了但中心没进台账」正是建档滞后。 */
    expect(ok.body.sideEffects[0].summary).toContain("还没进台账");

    const frozen = await inst.post(
      `/v1/site-acceptances/${a.id}/docs/0:set`, { present: false }, key());
    expect(frozen.status).toBe(422);
    expect(frozen.body.invariant).toBe("acceptance-frozen");
  });
});

describe("系统外受理的登记存根：它记的是一件已经发生过的事", () => {
  const registered = async () => {
    const r = await admin.get("/v1/site-acceptances?limit=100");
    const a = r.body.items.find((x: { origin: string }) => x.origin === "registered");
    expect(a, "台账里十五个中心的受理都是既成事实").toBeTruthy();
    return a;
  };

  it("**没有受理人，也没有清单** —— 那是事实，不是漏填", async () => {
    const a = await registered();
    expect(a.state).toBe("accepted");
    expect(a.acceptedOn).not.toBeNull();
    expect(a.acceptedByName, "受理人在几年前的医院里，填谁都是编的").toBeNull();
    expect(a.docs, "空清单在这里是「没人在这儿查过」").toEqual([]);
    expect(a.studySiteId, "它们都已经建档了").not.toBeNull();
  });

  it("在存根上勾材料 / 发补正 / 再受理一次，全都拦下", async () => {
    const a = await registered();
    /* 逐个 await，不预先把三个请求都发出去 —— supertest 的请求一构造
       就开始连，三条一起打进同一个测试应用会撞上连接被拒。 */
    const 拦下 = async (r: { status: number; body: { invariant?: string } }) => {
      expect(r.status, JSON.stringify(r.body)).toBe(422);
      expect(r.body.invariant).toBe("acceptance-registered-readonly");
    };
    await 拦下(await admin.post(
      `/v1/site-acceptances/${a.id}/docs/0:set`, { present: true }, key()));
    await 拦下(await admin.post(
      `/v1/site-acceptances/${a.id}:amend`, { reason: "想改一件已经发生的事" }, key()));
    await 拦下(await admin.post(`/v1/site-acceptances/${a.id}:accept`, {}, key()));
  });

  it("闸门放行时说得出「凭什么」—— 而且说得出它是登记的", async () => {
    const a = await registered();
    const g = await admin.get(`/v1/study-sites/${a.studySiteId}/gate?to=irb_submit`);
    expect(g.body.satisfied).toBe(true);
  });
});

describe("受理不对外部方关闭 —— 但仍按行范围收敛", () => {
  it("机构办看得到递给本院的受理，**包括还没建档的那两条**", async () => {
    const r = await inst.get("/v1/site-acceptances?limit=100");
    expect(r.status).toBe(200);
    const hospitals = new Set(r.body.items.map((x: { hospital: string }) => x.hospital));
    expect([...hospitals]).toEqual(["北京协和医院"]);
    expect(r.body.items.some((x: { studySiteId: string | null }) => x.studySiteId === null),
      "受理发生在建档之前 —— 四参数的 app.site_visible 就是为这一条存在的")
      .toBe(true);
  });

  it("**范围之外 = 不存在（404），不是 403**", async () => {
    const all = await admin.get("/v1/site-acceptances?limit=100");
    const other = all.body.items.find(
      (x: { hospital: string }) => x.hospital !== "北京协和医院");
    const r = await inst.post(`/v1/site-acceptances/${other.id}:accept`, {}, key());
    expect(r.status).toBe(404);
  });
});

describe("中心文件与物资：状态是算出来的，库里一个字都没变", () => {
  it("每一条都带着算出来的状态与「为什么现在就提醒」", async () => {
    const r = await cra.get("/v1/isf-items");
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(0);
    for (const i of r.body.items) {
      expect(["missing", "expired", "due", "low", "ok"]).toContain(i.status);
      expect(i.leadDays).toBeGreaterThan(0);
    }
    /* 缺失与过期排最前，齐备在最后 —— 顺序本身就是这一页的答案。 */
    const first = r.body.items[0].status;
    expect(["missing", "expired", "due", "low"]).toContain(first);
    expect(r.body.summary.calcVersion).toMatch(/^\d{4}\.\d+$/);
  });

  it("**齐备率按全部清单算**，不按筛过之后的 —— 否则只看不齐备时它永远是 0", async () => {
    const all = await cra.get("/v1/isf-items");
    const open = await cra.get("/v1/isf-items?openOnly=true");
    expect(open.body.items.length).toBeLessThan(all.body.items.length);
    expect(open.body.summary.readyRatio).toBe(all.body.summary.readyRatio);
    expect(open.body.items.every((i: { status: string }) => i.status !== "ok")).toBe(true);
  });

  it("缺失的那份没有到期日 —— 缺失和过期是两种缺，不能互相顶替", async () => {
    const r = await cra.get("/v1/isf-items");
    const missing = r.body.items.filter((i: { status: string }) => i.status === "missing");
    expect(missing.length).toBeGreaterThan(0);
    for (const m of missing) {
      expect(m.present).toBe(false);
      expect(m.expiresOn).toBeNull();
      expect(m.daysLeft, "缺失的东西没有「还剩几天」").toBeNull();
    }
  });

  it("**已过期的 daysLeft 是负数** —— 折算成 0，昨天过期和今天到期就一样了", async () => {
    const r = await admin.get("/v1/isf-items");
    const expired = r.body.items.filter((i: { status: string }) => i.status === "expired");
    for (const e of expired) expect(e.daysLeft).toBeLessThan(0);
  });

  it("补了一份缺失的文件，状态跟着事实走，核对人留在行上", async () => {
    const r = await crc.get("/v1/isf-items?openOnly=true");
    const m = r.body.items.find((i: { status: string }) => i.status === "missing");
    expect(m).toBeTruthy();
    const up = await crc.post(`/v1/isf-items/${m.id}:update`,
      { present: true, expiresOn: "2028-06-30", note: "新护士 GCP 证书已归档" }, key());
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const now = up.body.data.items.find((i: { id: string }) => i.id === m.id);
    expect(now.status).toBe("ok");
    expect(now.checkedByName).toBe("吴桐");
    expect(now.daysLeft).toBeGreaterThan(0);
  });

  it("标为缺失就不该还留着到期日 —— 先决定它到底在不在", async () => {
    const r = await crc.get("/v1/isf-items");
    const dated = r.body.items.find(
      (i: { expiresOn: string | null; present: boolean }) => i.present && i.expiresOn);
    const bad = await crc.post(`/v1/isf-items/${dated.id}:update`,
      { present: false }, key());
    expect(bad.status).toBe(422);
    expect(bad.body.invariant).toBe("isf-missing-has-expiry");
  });

  it("**没有补货线就填不了库存** —— 「少到多少算少」没有答案", async () => {
    const r = await crc.get("/v1/isf-items");
    const noStock = r.body.items.find((i: { reorderAt: number | null }) =>
      i.reorderAt === null);
    const bad = await crc.post(`/v1/isf-items/${noStock.id}:update`,
      { quantity: 3 }, key());
    expect(bad.status).toBe(422);
    expect(bad.body.invariant).toBe("isf-stock-needs-reorder");
  });

  it("机构办翻得到本院那摞纸，别家医院的一条都翻不到", async () => {
    const r = await inst.get("/v1/isf-items");
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(0);
    for (const i of r.body.items) expect(i.hospital).toBe("北京协和医院");
  });

  it("**空清单的中心齐备率是 null，不是 100%** —— 它不是齐备，是没人查过", async () => {
    const sites = await admin.get("/v1/study-sites?limit=100");
    const withIsf = new Set((await admin.get("/v1/isf-items")).body.items
      .map((i: { studySiteId: string }) => i.studySiteId));
    const bare = sites.body.items.find((s: { id: string }) => !withIsf.has(s.id));
    expect(bare, "十五个中心里只有两个铺了清单").toBeTruthy();
    const r = await admin.get(`/v1/isf-items?studySiteId=${bare.id}`);
    expect(r.body.items).toEqual([]);
    expect(r.body.summary.readyRatio).toBeNull();
    expect(r.body.summary.worstDaysLeft).toBeNull();
  });
});
