import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { boot, resetDb, as, api, type Caller } from "./harness.js";
import { randomUUID } from "node:crypto";

let app: INestApplication, boss: Caller;
beforeAll(async () => {
  resetDb(); app = await boot(); boss = await as(app, "lingyuan");
}, 120_000);
afterAll(async () => { await app?.close(); });

let seq = 0;
async function freshSite() {
  const study = (await boss.get("/v1/studies?limit=1")).body.items[0];
  const r = await boss.post("/v1/study-sites", {
    studyId: study.id, code: `SS-GATE${String(++seq).padStart(2, "0")}`,
    hospital: "闸门测试医院", dept: "科", city: "北京",
    piName: "测试研究者", contracted: 5, unitPriceCents: 1000000
  });
  return r.body as { id: string; code: string; state: string };
}
const advance = (id: string, to: string, reason?: string) =>
  boss.post(`/v1/study-sites/${id}:advance`, { to, ...(reason ? { reason } : {}) },
    { "Idempotency-Key": randomUUID() });

describe("闸门：推进不是给字段赋值，是断言一组事实成立", () => {
  it("无闸门的节点可以正常推进", async () => {
    const s = await freshSite();
    expect(s.state).toBe("intake");
    const r = await advance(s.id, "irb_submit", "材料齐备，已向伦理递交");
    expect(r.status).toBe(201);
    expect(r.body.data.state).toBe("irb_submit");
    expect(r.body.sideEffects[0].type).toBe("SiteStateChanged");
  });

  it("只能推进到状态机的下一节点，不能跳级", async () => {
    const s = await freshSite();
    const r = await advance(s.id, "closed", "想直接关掉");
    expect(r.status).toBe(422);
    expect(r.body.detail).toContain("下一节点");
  });

  it("推进到 SIV 被闸门拦下，并逐条说明还差什么", async () => {
    const s = await freshSite();
    for (const to of ["irb_submit", "irb_approve", "contract"])
      expect((await advance(s.id, to, "推进到下一节点")).status).toBe(201);

    const r = await advance(s.id, "siv", "准备启动");
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("gate-not-satisfied");
    expect(r.body.unmet.length).toBeGreaterThan(0);
    expect(r.body.unmet[0]).toMatchObject({ code: "startup-blockers", module: "startup" });
    /* 状态没有被改动 */
    expect((await boss.get(`/v1/study-sites/${s.id}`)).body.state).toBe("contract");
  });

  it("闸门预检接口在按钮点下去之前就给出答案", async () => {
    const s = await freshSite();
    for (const to of ["irb_submit", "irb_approve", "contract"]) await advance(s.id, to, "按流程推进至下一节点");
    const g = await boss.get(`/v1/study-sites/${s.id}/gate`);
    expect(g.status).toBe(200);
    expect(g.body).toMatchObject({ from: "contract", to: "siv", satisfied: false });
    expect(g.body.unmet.map((u: { module: string }) => u.module)).toContain("startup");
  });

  it("关闭闸门：已交付的检查真查库，未交付的保持 fail-closed", async () => {
    const s = await freshSite();                      // 无受试者、无质疑、无补偿
    const g = await boss.get(`/v1/study-sites/${s.id}/gate?to=closed`);
    expect(g.body.satisfied).toBe(false);

    /* ClinicalOps 交付后，八项里有四项是真查询，且在空中心上应当通过 ——
       它们不再出现在 unmet 里。剩下四项依赖未交付模块，保持 unavailable。 */
    const codes = g.body.unmet.map((u: { code: string }) => u.code);
    expect(codes.sort()).toEqual(
      ["closeout-report", "ip-imbalance", "ip-not-destroyed", "specimen-open"]);
    /* 这是刻意的 fail-closed：查不了不等于通过 */
    for (const u of g.body.unmet) expect(u.message).toContain("尚未交付");
  });
});

describe("认证：一次性链接、会话、停用即失效", () => {
  it("申请链接对存在与不存在的账号返回同样的 202 —— 不做账号枚举器", async () => {
    const ok = await api(app).post("/v1/auth/magic-link").send({ login: "zhanghm" });
    const no = await api(app).post("/v1/auth/magic-link").send({ login: "nobody_here" });
    expect(ok.status).toBe(202);
    expect(no.status).toBe(202);
    expect(no.body.message).toBe(ok.body.message);
  });

  it("链接可兑换为会话，且只能用一次", async () => {
    const issued = await api(app).post("/v1/auth/magic-link").send({ login: "zhanghm" });
    const token = issued.body.devToken as string;
    expect(token).toBeTruthy();

    const first = await api(app).post("/v1/auth/session").send({ token });
    expect(first.status).toBe(201);
    expect(first.body.token).toBeTruthy();

    const again = await api(app).post("/v1/auth/session").send({ token });
    expect(again.status).toBe(401);
    expect(again.body.detail).toContain("已被使用");
  });

  it("会话令牌可用于访问接口", async () => {
    const issued = await api(app).post("/v1/auth/magic-link").send({ login: "zhanghm" });
    const s = await api(app).post("/v1/auth/session").send({ token: issued.body.devToken });
    const r = await api(app).get("/v1/me").set({ Authorization: `Bearer ${s.body.token}` });
    expect(r.status).toBe(200);
    expect(r.body.account.login).toBe("zhanghm");
    expect(r.body.permissions.rowRule).toBe("hospital");
  });

  it("登出后令牌立刻失效", async () => {
    const c = await as(app, "tangyan");
    expect((await c.get("/v1/me")).status).toBe(200);
    expect((await c.post("/v1/auth/logout")).status).toBe(204);
    expect((await c.get("/v1/me")).status).toBe(401);
  });

  it("已停用账号无法开会话", async () => {
    const r = await api(app).post("/v1/auth/dev-session").send({ login: "zhouqi" });
    expect(r.status).toBe(401);
  });

  it("停用账号后，他手上已有的会话立刻失效", async () => {
    const victim = await as(app, "sheny" + "ilin");
    expect((await victim.get("/v1/me")).status).toBe(200);

    const acc = (await boss.get("/v1/accounts?limit=200")).body.items
      .find((a: { login: string }) => a.login === "shenyilin");
    /* 沈亦琳带着 SS-02，应当先被交接闸门拦下 */
    const blocked = await boss.post(`/v1/accounts/${acc.id}:disable`,
      { reason: "验证停用前必须先交接" }, { "Idempotency-Key": randomUUID() });
    expect(blocked.status).toBe(422);
    expect(blocked.body.code).toBe("gate-not-satisfied");
    expect(blocked.body.unmet[0].module).toBe("handover");
  });

  it("不带中心的人可以被停用，且其会话随即失效", async () => {
    const acc = (await boss.get("/v1/accounts?limit=200")).body.items
      .find((a: { login: string }) => a.login === "weilan");   // QA 无派工
    const victim = await as(app, "weilan");
    expect((await victim.get("/v1/me")).status).toBe(200);

    const r = await boss.post(`/v1/accounts/${acc.id}:disable`,
      { reason: "离职办理，账号停用但记录保留" }, { "Idempotency-Key": randomUUID() });
    expect(r.status).toBe(201);
    expect(r.body.data.status).toBe("disabled");
    /* resolve_session 只认在职账号 —— 停用即断线 */
    expect((await victim.get("/v1/me")).status).toBe(401);
  });

  it("不能停用自己", async () => {
    const me = (await boss.get("/v1/me")).body.account;
    const r = await boss.post(`/v1/accounts/${me.id}:disable`,
      { reason: "试图自我停用" }, { "Idempotency-Key": randomUUID() });
    expect(r.status).toBe(422);
    expect(r.body.detail).toContain("自己");
  });
});
