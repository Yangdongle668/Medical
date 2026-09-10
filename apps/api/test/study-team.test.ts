import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { boot, resetDb, as, type Caller } from "./harness.js";

const idem = () => ({ "Idempotency-Key": randomUUID() });

/* ════════════════════════════════════════════════════════════════════
   把项目划给另一个组。

   **这是行范围本身，不是一个标签。** `row_rule=team` 的定义就是
   「本组承接的项目」—— 划走那一刻，原来那个组的 PM 看不见这个项目、
   看不见它下面的全部中心、看不见那些中心上的受试者与工时。

   在此之前这件事**只能直接改库**：批准立项会把项目归给提交人所在的组
   （见 intake.service），但归错了、要接手、要拆组并组，都没有入口。
   ════════════════════════════════════════════════════════════════════ */

let app: INestApplication;
let admin: Caller, pmA: Caller, pmB: Caller;

beforeAll(async () => {
  resetDb(); app = await boot();
  admin = await as(app, "admin");
  pmA   = await as(app, "hanxue");   // 一个组
  pmB   = await as(app, "cendi");    // 另一个组
}, 180_000);
afterAll(async () => { await app?.close(); });

const 项目 = async (c: Caller) =>
  (await c.get("/v1/studies?limit=100")).body.items as
    { id: string; code: string; team: { id: string; name: string } | null }[];

const 中心 = async (c: Caller) =>
  (await c.get("/v1/study-sites?limit=200")).body.items as { id: string; code: string }[];

describe("项目归属组", () => {
  it("**项目列表带得出归属组** —— 那是这一栏存在的全部理由", async () => {
    const all = await 项目(admin);
    expect(all.length).toBeGreaterThan(0);
    /* 演示数据里四个项目各有归属 */
    expect(all.every(s => s.team !== undefined), "team 这一栏根本没下发").toBe(true);
    expect(all.filter(s => s.team).length, "一个有归属组的项目都没有").toBeGreaterThan(0);
  });

  it("**划走之后，原来那个组的 PM 当场看不见它，连同它下面的中心**", async () => {
    const 甲 = (await 项目(pmA)).find(s => s.team);
    expect(甲, "hanxue 名下应当有一个有归属组的项目").toBeTruthy();
    const 甲的中心 = (await 中心(pmA)).length;

    /* 乙组现在看不到它 */
    expect((await 项目(pmB)).map(s => s.code)).not.toContain(甲!.code);

    /* 乙组要取**cendi 真正所在的那个组** —— 随便挑一个"不是甲组"的，
       可能挑到一个一个 PM 都没有的空组，那样"划过去之后乙看得见"
       就永远不成立，而失败原因和被测的东西无关。 */
    const 账号 = (await admin.get("/v1/accounts?limit=200")).body.items as
      { login: string; team: { id: string; name: string } | null }[];
    const 乙组 = 账号.find(a => a.login === "cendi")!.team!;
    expect(乙组.id, "cendi 应当在一个组里").not.toBe(甲!.team!.id);

    const r = await admin.post(`/v1/studies/${甲!.id}:set-team`,
      { teamId: 乙组.id, reason: "华东组人手不足，本项目移交华中组承接" }, idem());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.team.id).toBe(乙组.id);
    /* 后果要当场说出来 —— 点这一下的人未必想到它连着中心 */
    expect(r.body.sideEffects[0].summary).toContain("看不见");

    /* 甲组的 PM 从这一刻起看不见它，中心也跟着少 */
    expect((await 项目(pmA)).map(s => s.code)).not.toContain(甲!.code);
    expect((await 中心(pmA)).length).toBeLessThan(甲的中心);
    /* 而乙组看得见了 */
    expect((await 项目(pmB)).map(s => s.code)).toContain(甲!.code);
  });

  it("必须写原因 —— 缺了是 422，不是 500", async () => {
    const s = (await 项目(admin))[0]!;
    const teams = (await admin.get("/v1/teams?limit=100")).body.items as { id: string }[];
    const r = await admin.post(`/v1/studies/${s.id}:set-team`,
      { teamId: teams[0]!.id }, idem());
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("validation-failed");
  });

  it("划到它本来就在的那个组：拒绝 —— 没有变化不该留一条审计", async () => {
    const s = (await 项目(admin)).find(x => x.team)!;
    const r = await admin.post(`/v1/studies/${s.id}:set-team`,
      { teamId: s.team!.id, reason: "试试划到原地" }, idem());
    expect(r.status).toBe(422);
    expect(r.body.invariant).toBe("study-team-unchanged");
  });

  it("**收回归属**：谁也不承接，而它会明说这通常不是想要的", async () => {
    const s = (await 项目(admin)).find(x => x.team)!;
    const r = await admin.post(`/v1/studies/${s.id}:set-team`,
      { teamId: null, reason: "承接组解散，暂由经营层直管" }, idem());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.team).toBeNull();
    expect(r.body.sideEffects[0].summary).toContain("通常不是想要的结果");
    /* 收回之后，行范围 all 的人仍看得见 */
    expect((await 项目(admin)).map(x => x.code)).toContain(s.code);
  });

  it("**PM 自己划不动** —— 这是 manage 动作，不是项目管理动作", async () => {
    const s = (await 项目(pmA))[0];
    if (!s) return;                       // 上一条可能把他的项目划走了
    const teams = (await admin.get("/v1/teams?limit=100")).body.items as { id: string }[];
    const 别的组 = teams.find(t => t.id !== s.team?.id)!;
    const r = await pmA.post(`/v1/studies/${s.id}:set-team`,
      { teamId: 别的组.id, reason: "自己给自己划一个" }, idem());
    expect(r.status).toBe(403);
  });

  it("写审计，且标成敏感 —— 核查员第一屏要看得见", async () => {
    const s = (await 项目(admin)).find(x => x.team)!;
    const teams = (await admin.get("/v1/teams?limit=100")).body.items as { id: string }[];
    const 别的组 = teams.find(t => t.id !== s.team!.id)!;
    await admin.post(`/v1/studies/${s.id}:set-team`,
      { teamId: 别的组.id, reason: "年度分工调整，本项目改由该组承接" }, idem());

    const trail = (await admin.get("/v1/audit-entries?limit=50")).body.items as
      { action: string; targetId: string; isSensitive?: boolean; reason?: string }[];
    const 这一条 = trail.find(e => e.action.includes("改项目归属组") && e.targetId === s.code);
    expect(这一条, "改归属没有进审计").toBeTruthy();
    expect(这一条!.isSensitive, "改归属没被标成敏感").toBe(true);
    expect(这一条!.reason).toContain("年度分工调整");
  });
});
