import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { boot, resetDb, as, type Caller } from "./harness.js";

let app: INestApplication, boss: Caller;

beforeAll(async () => {
  resetDb();
  app = await boot();
  boss = await as(app, "lingyuan");
}, 120_000);
afterAll(async () => { await app?.close(); });

/* ════════════════════════════════════════════════════════════════════
   发件箱重放 —— **客户端发了键，服务端就必须认这把键**。

   ── 这些测试是为哪个 bug 写的 ────────────────────────────────────
   前端给 `L2 || (非 GET && 非 auth)` 的每个端点生成幂等键
   （api/client.ts），发件箱用同一个判据在断网时收下请求，
   重连时**原样带着那把键重放**（api/outbox.ts 的 QUEUEABLE）。
   client.ts 里那段注释把这件事说得很清楚：

       请求发出去、服务端处理完、响应在回来的路上丢了，也长这个样子。
       所以入队重发是有可能"发第二次"的 —— 而这正是幂等键存在的理由：
       重放带着同一把键，服务端认得它，返回首次的结果，不会产生第二次副作用。
       **安全性来自那把键，不来自"它应该没到"这种猜测。**

   而 70 个写端点里有 10 个既没有 command() 也没有 idempotent()，
   连 `@Headers("idempotency-key")` 都没有 —— 键发过去，服务端根本不读。
   实测（改之前）：

       createBid         同一把键发两次 → **两条投标**，两个 id，都是 201
       createFeasibility 同一把键发两次 → 第二次 **500**（撞唯一约束）

   五个是建档类，重放就是多一条记录；另外五个改的是同一个值，
   重放的代价是**审计轨迹里多一条** —— 而 updateAccount 与
   updateRolePermissions 恰好是核查员第一屏上的那两条。

   ── 为什么这里逐个端点点名，而不是只留一条守卫 ──────────────────
   `tools/arch-check.mjs` 那条守卫查的是「有没有包外壳」，是结构；
   这里查的是「重放之后库里是不是还只有一条」，是行为。
   包了外壳但 body 传错（比如漏了 params 里的 id），结构那条照样绿。
   ════════════════════════════════════════════════════════════════════ */

/** 断网重发的形状：同一把键、同样的载荷，发两次。 */
const 重放 = async (path: string, body: unknown) => {
  const key = crypto.randomUUID();
  const a = await boss.post(path, body, { "idempotency-key": key });
  const b = await boss.post(path, body, { "idempotency-key": key });
  return { a, b };
};

describe("发件箱重放：建档类端点不能重放出第二条", () => {
  it("createBid —— 改之前这里是两条投标", async () => {
    const body = {
      sponsor: "重放测试申办方", name: "重放测试项目", submittedOn: "2026-09-01",
      sites: 10, subjects: 200, ourQuoteCents: 100_000_000, ourPersonDays: 500
    };
    const { a, b } = await 重放("/v1/bids", body);
    expect(a.status).toBe(201);
    expect(b.status, "重放应当返回首次的结果，不是再建一条").toBe(201);
    expect(b.body.id, "重放返回的不是首次那一条").toBe(a.body.id);

    const mine = (await boss.get("/v1/bids?limit=200")).body.items
      .filter((x: { name: string }) => x.name === "重放测试项目");
    expect(mine.length, "同一把幂等键重放，库里却有两条投标").toBe(1);
  });

  it("createFeasibility —— 改之前第二次是 500（撞唯一约束）", async () => {
    const study = (await boss.get("/v1/studies?limit=1")).body.items[0];
    const body = {
      studyId: study.id, hospital: "重放测试医院", city: "北京", dept: "内科",
      piName: "张三", surveyedOn: "2026-09-01",
      answers: { ptYear: 300, pastN: 5, pastBest: 3, compet: 1,
                 ethicsDays: 30, startDays: 60, teamN: 5, piCommit: 4, eligPct: 0.4 }
    };
    const { a, b } = await 重放("/v1/feasibility", body);
    expect(a.status).toBe(201);
    expect(b.status, "重放撞在唯一约束上回了 500 —— 那不是幂等，是碰巧没重复").toBe(201);
    expect(b.body.code).toBe(a.body.code);
  });

  it("createTeam", async () => {
    const { a, b } = await 重放("/v1/teams", { code: "RPLY", name: "重放测试组" });
    expect(a.status).toBe(201);
    expect(b.status, "重放撞在唯一编码上回了 422").toBe(201);
    expect(b.body.id).toBe(a.body.id);
  });
});

describe("发件箱重放：改值类端点不能在轨迹里记两条", () => {
  /* 这几条重放不会改出第三种结果（设的是同一个值），
     但每重放一次就多一条审计 —— 而第一屏里两条一模一样的
     「调整账号角色」，读的人只能自己猜是重放还是真做了两次。 */
  /* 按**前缀**数，不按完整标签。`updateAccount` 的审计标签是按负载算的
     （改了角色是「调整账号角色」，没改角色是「调整账号归属」）——
     而不带幂等的那次重放，第二遍看到账号已经是目标角色了，
     于是它记的是「归属」那一条。挑着标签数的话，这条测试会在
     **没有幂等的代码上照样是绿的**，测的其实是标签怎么选，不是重放几次。 */
  const 轨迹条数 = async (前缀: string, targetId: string) => {
    const r = await boss.get("/v1/audit-entries?sensitiveOnly=true&limit=100");
    return (r.body.items as { action: string; targetId: string }[])
      .filter(x => x.action.startsWith(前缀) && x.targetId === targetId).length;
  };

  let 靶子 = "";
  beforeAll(async () => {
    const roles = (await boss.get("/v1/roles")).body.items;
    const cra = roles.find((r: { code: string }) => r.code === "cra");
    const r = await boss.post("/v1/accounts",
      { login: "replaytarget", displayName: "重放测试账号", roleId: cra.id },
      { "idempotency-key": crypto.randomUUID() });
    expect(r.status).toBe(201);
    靶子 = r.body.id;
  });

  it("updateAccount —— 改角色只该在核查员第一屏上留一条", async () => {
    const roles = (await boss.get("/v1/roles")).body.items;
    const qa = roles.find((r: { code: string }) => r.code === "qa");
    const key = crypto.randomUUID();
    const body = { roleId: qa.id, reason: "借调至质量组，按新岗位调整角色" };

    const a = await boss.patch(`/v1/accounts/${靶子}`, body, { "idempotency-key": key });
    const b = await boss.patch(`/v1/accounts/${靶子}`, body, { "idempotency-key": key });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await 轨迹条数("调整账号", "replaytarget"),
      "重放在审计轨迹里记了两条 —— 核查员分不出是重放还是真改了两次").toBe(1);
  });

  it("setAccountPassword —— 撤会话与留痕都只该发生一次", async () => {
    const key = crypto.randomUUID();
    const body = { password: "Temp-9f3k2m8Q", reason: "本人报告无法登录，当面交付初始口令" };
    const a = await boss.post(`/v1/accounts/${靶子}:set-password`, body,
      { "idempotency-key": key });
    const b = await boss.post(`/v1/accounts/${靶子}:set-password`, body,
      { "idempotency-key": key });
    expect(a.status).toBe(204);
    expect(b.status).toBe(204);
    expect(await 轨迹条数("重设账号口令", "replaytarget")).toBe(1);
  });

  it("setLoginAddress", async () => {
    const key = crypto.randomUUID();
    const body = { address: "replaytarget@hengji.com",
                   reason: "本人当面确认的工作邮箱，用于接收一次性登录链接" };
    const a = await boss.post(`/v1/accounts/${靶子}:set-login-address`, body,
      { "idempotency-key": key });
    const b = await boss.post(`/v1/accounts/${靶子}:set-login-address`, body,
      { "idempotency-key": key });
    expect(a.status).toBe(204);
    expect(b.status).toBe(204);
    expect(await 轨迹条数("登记登录收件地址", "replaytarget")).toBe(1);
  });
});

describe("幂等键仍然只对应一次操作", () => {
  /* 补了外壳不等于放松了约束：同一把键换个载荷、换个目标、换个端点，
     都还是 409。**尤其是换个目标** —— 那几条 PATCH 的哈希里带着 params
     的 id，漏掉 id 的话「给 A 改角色」和「给 B 改角色」会哈希成同一件事。 */
  it("同一把键用在两个不同的账号上 → 409", async () => {
    const roles = (await boss.get("/v1/roles")).body.items;
    const qa = roles.find((r: { code: string }) => r.code === "qa");
    const accounts = (await boss.get("/v1/accounts?limit=50")).body.items;
    const 甲 = accounts.find((a: { login: string }) => a.login === "linmin");
    const 乙 = accounts.find((a: { login: string }) => a.login === "wutong");
    expect(甲 && 乙, "种子里少了这两个账号，这条测试测不到东西了").toBeTruthy();

    const key = crypto.randomUUID();
    const body = { roleId: qa.id, reason: "借调至质量组，按新岗位调整角色" };
    const a = await boss.patch(`/v1/accounts/${甲.id}`, body, { "idempotency-key": key });
    expect(a.status).toBe(200);
    const b = await boss.patch(`/v1/accounts/${乙.id}`, body, { "idempotency-key": key });
    expect(b.status, "同一把键改了另一个人，却被当成重放静默放过").toBe(409);
    expect(b.body.code).toBe("idempotency-key-reused");
  });

  it("同一把键用在两个不同的端点上 → 409", async () => {
    const key = crypto.randomUUID();
    const body = { code: "RPL2", name: "重放测试组二" };
    const a = await boss.post("/v1/teams", body, { "idempotency-key": key });
    expect(a.status).toBe(201);
    const b = await boss.post("/v1/bids", {
      sponsor: "另一个申办方", name: "另一个项目", submittedOn: "2026-09-01",
      sites: 1, subjects: 1, ourQuoteCents: 1, ourPersonDays: 1
    }, { "idempotency-key": key });
    expect(b.status).toBe(409);
    expect(b.body.code).toBe("idempotency-key-reused");
  });
});
