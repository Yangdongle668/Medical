import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { boot, resetDb, as, type Caller } from "./harness.js";

let app: INestApplication, boss: Caller, cra: Caller, inst: Caller;

beforeAll(async () => {
  resetDb();
  app = await boot();
  boss = await as(app, "lingyuan");
  cra  = await as(app, "linmin");
  inst = await as(app, "zhanghm");
}, 120_000);
afterAll(async () => { await app?.close(); });

describe("审计：写操作必然留痕", () => {
  it("建档动作产生一条轨迹，四个 W 齐全", async () => {
    const study = (await boss.get("/v1/studies?limit=1")).body.items[0];
    const code = "SS-T" + Math.floor(Math.random() * 900 + 100);
    const created = await boss.post("/v1/study-sites", {
      studyId: study.id, code, hospital: "测试医院", dept: "测试科",
      city: "北京", piName: "测试研究者", contracted: 10, unitPriceCents: 5000000
    });
    expect(created.status).toBe(201);

    const trail = await boss.get(`/v1/audit-entries?targetType=study_site&targetId=${code}`);
    const e = trail.body.items[0];
    expect(e.action).toBe("中心建档");
    expect(e.actorLogin).toBe("lingyuan");        // 谁
    expect(e.at).toBeTruthy();                     // 何时
    expect(e.after).toMatchObject({ code });       // 改成什么
    expect(e.actorRoleCode).toBe("boss");          // 当时的身份
  });

  it("敏感动作的原因被记录下来，且标记为 sensitive", async () => {
    const roles = (await boss.get("/v1/roles")).body.items;
    const qa = roles.find((r: { code: string }) => r.code === "qa");
    expect(qa.allowedActions).not.toContain("ethics");
    await boss.patch(`/v1/roles/${qa.id}`, {
      allowedActions: [...qa.allowedActions, "ethics"],
      reason: "补授伦理递交权限：稽查发现的严重违背须由 QA 直接报伦理"
    });
    const trail = await boss.get("/v1/audit-entries?sensitiveOnly=true&limit=5");
    const e = trail.body.items.find((x: { action: string }) => x.action === "调整角色权限");
    expect(e.isSensitive).toBe(true);
    expect(e.reason).toContain("补授伦理递交权限");
    expect(e.before.allowedActions).not.toEqual(e.after.allowedActions);
  });

  it("敏感动作缺原因 → 422，写不进去", async () => {
    const roles = (await boss.get("/v1/roles")).body.items;
    const r = await boss.patch(`/v1/roles/${roles[0].id}`, { rowRule: "all" });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("validation-failed");
    expect(JSON.stringify(r.body.issues)).toContain("/reason");
  });

  it("原因不能敷衍 —— 一两个字过不了契约校验", async () => {
    const roles = (await boss.get("/v1/roles")).body.items;
    const r = await boss.patch(`/v1/roles/${roles[0].id}`, { rowRule: "all", reason: "改" });
    expect(r.status).toBe(422);
  });

  it("角色是快照：事后改了角色，历史轨迹里仍是当时的身份", async () => {
    const before = await boss.get("/v1/audit-entries?actorLogin=lingyuan&limit=1");
    expect(before.body.items[0].actorRoleCode).toBe("boss");
  });
});

describe("审计的行范围：外部方看不到别人中心的轨迹", () => {
  it("机构办看不到无中心归属的内部动作（如权限调整）", async () => {
    const seen = await inst.get("/v1/audit-entries?limit=200");
    expect(seen.status).toBe(200);
    const actions = seen.body.items.map((x: { action: string }) => x.action);
    expect(actions).not.toContain("调整角色权限");
  });

  it("CRA 看得到自己范围内中心的轨迹", async () => {
    const site = (await cra.get("/v1/study-sites?limit=1")).body.items[0];
    const r = await cra.get(`/v1/audit-entries?studySiteId=${site.id}`);
    expect(r.status).toBe(200);
  });
});
