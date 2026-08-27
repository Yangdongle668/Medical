import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { boot, resetDb, as, type Caller } from "./harness.js";
import { randomUUID } from "node:crypto";

/* 这一组**必须独立成文件**：它改的是全局模板，而 staffing.test.ts 里
   有两条用例断言"新建中心铺开 16 项"。同一个库里跑，后面那两条会因为
   前面改了模板而红 —— 而报错说的是"16 变成了 3"，指不到真正的原因。
   测试隔离不是靠约定，是靠没有共享的东西（harness 每个文件一个库）。 */

let app: INestApplication, boss: Caller, crcGuo: Caller;
beforeAll(async () => {
  resetDb(); app = await boot();
  boss = await as(app, "lingyuan");
  crcGuo = await as(app, "guoxiaoxu");
}, 120_000);
afterAll(async () => { await app?.close(); });

const K = () => ({ "Idempotency-Key": randomUUID() });
const siteByCode = async (c: Caller, code: string) =>
  (await c.get(`/v1/study-sites?limit=200&q=${code}`)).body.items
    .find((s: { code: string }) => s.code === code);

let seq = 0;
async function freshSite() {
  const study = (await boss.get("/v1/studies?limit=1")).body.items[0];
  const r = await boss.post("/v1/study-sites", {
    studyId: study.id, code: `SS-TPL${String(++seq).padStart(2, "0")}`,
    hospital: "模板测试医院", dept: "科", city: "北京",
    piName: "测试研究者", contracted: 5, unitPriceCents: 1000000
  });
  expect(r.status, `建档失败：${JSON.stringify(r.body)}`).toBe(201);
  return r.body as { id: string; code: string };
}

describe("启动清单模板：可配置，但**不回溯在途中心**", () => {
  const TPL = (over: Partial<{ items: unknown[]; reason: string }> = {}) => ({
    items: [
      { sortOrder: 0, category: "ethics", item: "伦理初始审查递交", isBlocking: true, dueOffset: -30 },
      { sortOrder: 1, category: "ip", item: "药品接收与药房交接", isBlocking: true, dueOffset: -3 },
      { sortOrder: 2, category: "meeting", item: "SIV 会议室预订", isBlocking: false, dueOffset: -5 }
    ],
    reason: "精简为三项：其余并入 SOP 检查表",
    ...over
  });

  it("读得到当前版本，且说得出是谁在什么时候改的", async () => {
    const t = (await boss.get("/v1/startup-template")).body;
    expect(t.version).toBeGreaterThan(0);
    expect(t.items.length).toBeGreaterThan(0);
    /* 迁移铺的第一版：作者是 NULL，但版本号和原因要有 */
    expect(t.reason).toBeTruthy();
  });

  it("发布新版：版本号加一，旧版本不删 —— 中心的戳要指得回去", async () => {
    const before = (await boss.get("/v1/startup-template")).body;
    const r = await boss.post("/v1/startup-template:replace", TPL(), K());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.version).toBe(before.version + 1);
    expect(r.body.data.items).toHaveLength(3);
    expect(r.body.data.updatedByName).toBe("凌远");
    expect(r.body.sideEffects[0].summary).toContain("只对此后建档的中心生效");
  });

  it("**在途中心的清单不变** —— 这是当初拦住这件事的那个问题", async () => {
    /* 一个已经做到第 12 项的中心，模板改一次就多出三项从来没人见过的
       阻塞，SIV 排期作废。没有人会认为那是"配置生效了"。 */
    const s = await siteByCode(boss, "SS-14");
    const before = (await boss.get(`/v1/study-sites/${s.id}/startup-items`)).body;
    expect(before.items.length).toBeGreaterThan(3);

    expect((await boss.post("/v1/startup-template:replace",
      TPL({ reason: "再精简一次，验证在途中心不受影响" }), K())).status).toBe(201);

    const after = (await boss.get(`/v1/study-sites/${s.id}/startup-items`)).body;
    expect(after.items.map((i: { item: string }) => i.item))
      .toEqual(before.items.map((i: { item: string }) => i.item));
  });

  it("此后建档的中心按新模板铺，并盖上版本号的戳", async () => {
    const v = (await boss.get("/v1/startup-template")).body.version;
    const s = await freshSite();
    const cl = (await boss.get(`/v1/study-sites/${s.id}/startup-items`)).body;
    expect(cl.items).toHaveLength(3);
    expect(cl.items[0].item).toBe("伦理初始审查递交");
    /* 追溯：这个中心是照着第几版铺的 */
    expect((await boss.get(`/v1/study-sites/${s.id}`)).body.startupTemplateVersion).toBe(v);
  });

  it("一个阻塞项都没有的模板会被拒 —— 那等于把 SIV 闸门关掉", async () => {
    /* 而它的表现是"闸门一直放行"，没有人会去查模板。 */
    const r = await boss.post("/v1/startup-template:replace", TPL({
      items: [{ sortOrder: 0, category: "meeting", item: "开个会", isBlocking: false, dueOffset: 0 }]
    }), K());
    expect(r.status).toBe(422);
    expect(r.body.detail).toContain("全部放行");
  });

  it("sortOrder 重复会被拒，而不是让主键冲突去报一句指不到这里的错", async () => {
    const r = await boss.post("/v1/startup-template:replace", TPL({
      items: [
        { sortOrder: 0, category: "ethics", item: "A", isBlocking: true, dueOffset: -1 },
        { sortOrder: 0, category: "ip", item: "B", isBlocking: true, dueOffset: -1 }
      ]
    }), K());
    expect(r.status).toBe(422);
    expect(r.body.detail).toContain("sortOrder 0");
  });

  it("改模板必须写原因，且逐条进审计", async () => {
    const noReason = await boss.post("/v1/startup-template:replace",
      { items: TPL().items }, K());
    expect(noReason.status).toBe(422);

    const trail = await boss.get(
      "/v1/audit-entries?targetType=startup_template&limit=10");
    expect(trail.body.items[0].action).toBe("发布启动清单模板");
    expect(trail.body.items[0].reason).toBeTruthy();
  });

  it("一线改不了它 —— 一份决定所有新中心怎么启动的清单不能人人可改", async () => {
    const r = await crcGuo.post("/v1/startup-template:replace", TPL(), K());
    expect(r.status).toBe(403);
  });
});
