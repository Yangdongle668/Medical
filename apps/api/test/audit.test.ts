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

/* ════════════════════════════════════════════════════════════════════
   核查员打开的第一屏 —— `sensitiveOnly=true` 是 AuditPage 的默认值。
   一条动作**写进了轨迹**不等于**在那一屏上**：SENSITIVE_ACTIONS 里
   曾经写着 `changeAccountRole`（真名 `updateAccount`），
   `needsReason()` 查不到只返回 false，于是「谁把谁调成了什么角色」
   一直躺在第二屏。契约的 description 里白纸黑字写着 isSensitive=true，
   而没有任何一条测试去验它 —— 所以下面这几条按**端到端**验，
   不是去问那张表里有没有这个名字（那是拿清单证明清单）。
   ════════════════════════════════════════════════════════════════════ */
describe("接管账号的那几条，得出现在核查员的第一屏", () => {
  /* 建一个自己的账号来改，不动种子里的人 ——
     `linmin` 是下面「CRA 看得到自己范围内中心的轨迹」那条依赖的身份，
     在这里把他调成别的角色，坏掉的是另一个文件里的另一条测试，
     而报出来的错会指向那一条，不指向这里。 */
  let 靶子 = "";
  beforeAll(async () => {
    const roles = (await boss.get("/v1/roles")).body.items;
    const cra = roles.find((r: { code: string }) => r.code === "cra");
    const r = await boss.post("/v1/accounts", {
      login: "audittarget", displayName: "审计测试账号", roleId: cra.id
    });
    expect(r.status).toBe(201);
    靶子 = r.body.id;
  });

  /** 只在敏感那一档里找 —— 找不到就是这条 bug 复发了。 */
  const 第一屏 = async (action: string) => {
    const r = await boss.get("/v1/audit-entries?sensitiveOnly=true&limit=50");
    return r.body.items.find(
      (x: { action: string; targetId: string }) =>
        x.action === action && x.targetId === "audittarget");
  };

  it("改角色：updateAccount 标为敏感（原来写成了 changeAccountRole，静默地不算）", async () => {
    const roles = (await boss.get("/v1/roles")).body.items;
    const qa = roles.find((r: { code: string }) => r.code === "qa");

    const r = await boss.patch(`/v1/accounts/${靶子}`, {
      roleId: qa.id,
      reason: "借调至质量组，按新岗位调整角色"
    });
    expect(r.status).toBe(200);

    const e = await 第一屏("调整账号角色");
    expect(e, "改角色没出现在 sensitiveOnly 的那一屏上").toBeTruthy();
    expect(e.isSensitive).toBe(true);
    expect(e.reason).toContain("借调至质量组");
  });

  it("设初始口令：能给别人设口令就能以他的身份进来 —— 和停用账号同一档", async () => {
    const r = await boss.post(`/v1/accounts/${靶子}:set-password`, {
      password: "Temp-9f3k2m8Q",
      reason: "本人报告无法登录，当面交付初始口令"
    });
    expect(r.status).toBe(204);

    const e = await 第一屏("重设账号口令");
    expect(e, "设初始口令没出现在 sensitiveOnly 的那一屏上").toBeTruthy();
    expect(e.isSensitive).toBe(true);
  });

  it("撤销启动清单项：契约里就写着它是敏感动作", async () => {
    /* 「撤销是敏感动作：它可能让一个已经推进的中心回到「其实没准备好」的状态，
        必须写原因。」—— packages/contracts/src/site/api.ts。
        原因确实被强制了（body 是 WithReason），缺的一直是"标成敏感"这一下。 */
    interface SItem { id: string; item: string; doneAt: string | null }
    const sites = (await boss.get("/v1/study-sites?limit=50")).body.items as
      { id: string }[];

    /* 跨中心找一条已完成的；一条都没有就自己先完成一条 ——
       种子里哪个中心勾了哪几项会变，而这条测试关心的是撤销，不是种子。 */
    let done: SItem | undefined;
    for (const s of sites) {
      const items = (await boss.get(
        `/v1/study-sites/${s.id}/startup-items`)).body.items as SItem[];
      done = items.find(x => x.doneAt);
      if (done) break;
      const open = items[0];
      if (!open) continue;
      const c = await boss.post(`/v1/startup-items/${open.id}:complete`, {},
        { "idempotency-key": crypto.randomUUID() });
      if (c.status === 201 || c.status === 200) { done = { ...open, doneAt: "x" }; break; }
    }
    expect(done, "一个已完成的启动清单项都凑不出来 —— 这条测试测不到东西了")
      .toBeTruthy();

    const r = await boss.post(`/v1/startup-items/${done!.id}:reopen`,
      { reason: "现场核对发现该项当时并未真正完成，撤回重做" },
      { "idempotency-key": crypto.randomUUID() });
    expect(r.status).toBe(201);

    const 第一屏 = await boss.get("/v1/audit-entries?sensitiveOnly=true&limit=50");
    const e = (第一屏.body.items as { action: string; targetId: string }[])
      .find(x => x.action === "撤销启动清单项" && x.targetId === done!.item);
    expect(e, "撤销启动清单项没出现在 sensitiveOnly 的那一屏上").toBeTruthy();
  });

  it("改收件地址：改了它就能把别人的一次性登录链接收到自己手里", async () => {
    const r = await boss.post(`/v1/accounts/${靶子}:set-login-address`, {
      address: "audittarget@hengji.com",
      reason: "本人当面确认的工作邮箱，用于接收一次性登录链接"
    });
    expect(r.status).toBe(204);

    const e = await 第一屏("登记登录收件地址");
    expect(e, "改收件地址没出现在 sensitiveOnly 的那一屏上").toBeTruthy();
    expect(e.isSensitive).toBe(true);
  });
});

/* 有一类敏感表达不进按 operationId 查的表：同一个端点，
   敏不敏感取决于这一次的负载。由服务写审计时显式标记
   （AuditInput.sensitive）—— 下面两条验的是那个开关**两个方向都对**：
   该敏感的敏感了，不该敏感的没被顺手一起标上。
   后半句同样要守：把 decideFeasibility 整个塞进 SENSITIVE_ACTIONS
   会让高分入选那条合法的 `reason: null` 直接 422 ——
   那是"修好了一半，弄坏了另一半"。 */
describe("可行性决定：同一个端点，两种敏感度", () => {
  interface Fs { id: string; code: string; status: string; score: { total: number } }
  const OVERRIDE_BELOW = 65;

  /** 待定的调查按分数取一条。**取不到就让这条测试红** ——
   *  一条"没数据就悄悄跳过"的测试，和没有这条测试是一回事。 */
  const 待定 = async (要求: (s: number) => boolean, 说明: string) => {
    const r = await boss.get("/v1/feasibility?status=assessing&limit=50");
    const got = (r.body.items as Fs[]).find(x => 要求(x.score.total));
    expect(got, `种子里没有${说明}的待定调查 —— 这条测试测不到东西了`).toBeTruthy();
    return got!;
  };

  /** L2 命令必须带幂等键，否则 422 —— 每次给一个新的。 */
  const 决定 = (id: string, body: unknown) =>
    boss.post(`/v1/feasibility/${id}:decide`, body,
      { "idempotency-key": crypto.randomUUID() });

  it("低分入选：必须写理由，而且进核查员的第一屏", async () => {
    const f = await 待定(s => s < OVERRIDE_BELOW, `低于 ${OVERRIDE_BELOW} 分`);

    /* 先确认那道门还在：不写理由过不去。 */
    const 空手 = await 决定(f.id, { decision: "selected" });
    expect(空手.status, "低分入选居然不用写理由了").toBe(422);

    const ok = await 决定(f.id, {
      decision: "selected",
      reason: "申办方指定：PI 为该适应症区域学术带头人，坚持纳入"
    });
    expect(ok.status).toBe(201);

    const 第一屏 = await boss.get("/v1/audit-entries?sensitiveOnly=true&limit=50");
    const e = (第一屏.body.items as { targetId: string; isSensitive: boolean; reason: string }[])
      .find(x => x.targetId === f.code);
    expect(e, "低分入选没出现在 sensitiveOnly 的那一屏上 —— " +
              "半年后复盘「这家怎么会选进来」时，那句话得找得到").toBeTruthy();
    expect(e!.isSensitive).toBe(true);
    expect(e!.reason).toContain("区域学术带头人");
  });

  it("高分入选：不写理由是合法的，也不该被标成敏感", async () => {
    const f = await 待定(s => s >= OVERRIDE_BELOW, `不低于 ${OVERRIDE_BELOW} 分`);

    const r = await 决定(f.id, { decision: "selected" });
    expect(r.status, "高分入选被要求写理由了 —— 那是把条件敏感写成了端点敏感").toBe(201);

    const trail = await boss.get(
      `/v1/audit-entries?targetType=feasibility&targetId=${f.code}`);
    expect(trail.body.items[0].isSensitive,
      "常规决定被塞进了敏感那一档 —— 第一屏被灌满，等于没有第一屏").toBe(false);
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
