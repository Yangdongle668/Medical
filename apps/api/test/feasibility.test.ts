import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { boot, resetDb, as, type Caller } from "./harness.js";

/** L2 命令必须带幂等键。每次一把新的 —— 这几条测试要的是"真的执行了"，
 *  不是重放。 */
const idem = () => ({ "Idempotency-Key": randomUUID() });

/* ════════════════════════════════════════════════════════════════════
   中心可行性调查。

   三组断言，每一组对应一条业务判断：

   ① **对外部方整表关闭。** 这里存的是「我们在评估哪几家医院、
      各打了多少分、谁被拒了」—— 让被比较的医院看见它，
      是可以直接毁掉合作关系的那种泄漏。

   ② **系统不阻止低分入选，但必须留下一句话。** 拦不住，也不该拦：
      商务上的取舍本来就不归一套评分决定。

   ③ **回填实际入组是评分唯一能自我修正的地方。**
      没有它，评分只是一套自洽的说法。
   ════════════════════════════════════════════════════════════════════ */

let app: INestApplication;
let boss: Caller, pm: Caller, cra: Caller, inst: Caller, pi: Caller;

beforeAll(async () => {
  resetDb(); app = await boot();
  boss = await as(app, "lingyuan");
  pm   = await as(app, "hanxue");
  cra  = await as(app, "linmin");
  inst = await as(app, "zhanghm");
  pi   = await as(app, "chenguod");
}, 180_000);
afterAll(async () => { await app?.close(); });

describe("行范围", () => {
  it("经营层看得到全部六条", async () => {
    const r = await boss.get("/v1/feasibility?limit=50");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.items).toHaveLength(6);
  });

  it("**外部方一行都看不到** —— 机构办与 PI 都是空的", async () => {
    for (const [who, c] of [["机构办", inst], ["PI", pi]] as const) {
      const r = await c.get("/v1/feasibility?limit=50");
      expect(r.status, `${who}: ${JSON.stringify(r.body)}`).toBe(200);
      expect(r.body.items, `${who} 不该看到任何候选中心`).toHaveLength(0);
    }
  });

  it("PM 只看本组承接项目下的", async () => {
    const mine = await pm.get("/v1/feasibility?limit=50");
    expect(mine.status).toBe(200);
    const sites = await pm.get("/v1/study-sites?limit=100");
    const myStudies = new Set(
      sites.body.items.map((s: { study: { id: string } }) => s.study.id));
    for (const f of mine.body.items)
      expect(myStudies.has(f.study.id), `${f.code} 不在 PM 的项目范围里`).toBe(true);
    expect(mine.body.items.length).toBeLessThan(6);
  });

  it("CRA 读得到（有 feas 模块），但写不了（没有 bid 动作）", async () => {
    const read = await cra.get("/v1/feasibility?limit=50");
    expect(read.status).toBe(200);

    const write = await cra.post("/v1/feasibility", {
      studyId: (await cra.get("/v1/studies?limit=1")).body.items[0].id,
      hospital: "某某医院", city: "某市", dept: "某科", piName: "某某",
      surveyedOn: "2026-08-20",
      answers: { ptYear: 100, pastN: 1, pastBest: 1, compet: 1, ethicsDays: 40,
                 startDays: 60, teamN: 4, piCommit: 2, eligPct: null }
    });
    expect(write.status).toBe(403);
  });
});

describe("评分", () => {
  it("逐项拆解一起下发 —— 拒绝一家医院时要说得出凭什么", async () => {
    const r = await boss.get("/v1/feasibility?limit=50");
    const one = r.body.items[0];
    expect(Object.keys(one.score.parts).sort()).toEqual(
      ["competition", "eligibility", "past", "source", "startup", "team"]);
    const sum = Object.values(one.score.parts as Record<string, number>)
      .reduce((a, b) => a + b, 0);
    /* 截断到 0–100 之前，逐项之和就是总分 */
    expect(one.score.total).toBeCloseTo(Math.min(100, Math.max(0, sum)), 6);
  });

  it("带口径版本号 —— 报表要能标出按哪版算的", async () => {
    const r = await boss.get("/v1/feasibility?limit=50");
    expect(r.body.items[0].score.calcVersion).toMatch(/^\d{4}\.\d+$/);
  });

  it("**入排匹配度为空的原样是 null** —— 不是 0", async () => {
    /* 用 0 代替它，那家"当时根本没问过"的医院会变成
       "入排匹配度是 0"，扣满 9 分 —— 而那次教训恰恰是因为当时没这一栏。 */
    const r = await boss.get("/v1/feasibility?limit=50");
    const old = r.body.items.find((f: { code: string }) => f.code === "FS-2024-003");
    expect(old.answers.eligPct).toBeNull();
    expect(old.score.parts.eligibility).toBe(0);
  });

  it("西安交大那条评分低，且实际入组是 0 —— 当初的分数说对了", async () => {
    const r = await boss.get("/v1/feasibility?limit=50");
    const xian = r.body.items.find((f: { code: string }) => f.code === "FS-2025-002");
    expect(xian.score.level).toBe("crit");
    expect(Number(xian.actualRate)).toBe(0);
  });
});

describe("入选与拒绝", () => {
  const assessing = async () => {
    const r = await boss.get("/v1/feasibility?limit=50&status=assessing");
    return r.body.items as { id: string; code: string; score: { total: number } }[];
  };

  it("高分入选不需要理由", async () => {
    const good = (await assessing()).find(f => f.score.total >= 65);
    expect(good, "种子里应该有一条高分待定的").toBeDefined();
    const r = await boss.post(`/v1/feasibility/${good!.id}:decide`,
      { decision: "selected" }, idem());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.status).toBe("selected");
    expect(r.body.sideEffects).toHaveLength(0);
  });

  it("**低分入选：不拦，但必须写理由**", async () => {
    const bad = (await assessing()).find(f => f.score.total < 65);
    expect(bad, "种子里应该有一条低分待定的").toBeDefined();

    const bare = await boss.post(`/v1/feasibility/${bad!.id}:decide`,
      { decision: "selected" }, idem());
    expect(bare.status).toBe(422);
    expect(bare.body.detail).toContain("必须写下理由");

    const ok = await boss.post(`/v1/feasibility/${bad!.id}:decide`, {
      decision: "selected",
      reason: "申办方指定：该 PI 是本适应症区域学术带头人，坚持纳入"
    }, idem());
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data.overrideReason).toContain("学术带头人");
    /* 当场看见和事后从审计里查出来是两回事 */
    expect(ok.body.sideEffects.map((s: { type: string }) => s.type))
      .toContain("FeasibilityOverride");
  });

  it("决定不能改 —— 要改就重新做一次调查", async () => {
    const decided = (await boss.get("/v1/feasibility?limit=50&status=selected"))
      .body.items[0];
    const again = await boss.post(`/v1/feasibility/${decided.id}:decide`,
      { decision: "rejected", reason: "想反悔" }, idem());
    expect(again.status).toBe(422);
    expect(again.body.detail).toContain("已经定过了");
  });

  it("拒绝必须写理由 —— 「评分不够」不是答案", async () => {
    const created = await boss.post("/v1/feasibility", {
      studyId: (await boss.get("/v1/studies?limit=1")).body.items[0].id,
      hospital: "测试市第三医院", city: "测试市", dept: "呼吸科", piName: "测试医生",
      surveyedOn: "2026-08-20",
      answers: { ptYear: 900, pastN: 6, pastBest: 5, compet: 0, ethicsDays: 30,
                 startDays: 40, teamN: 8, piCommit: 5, eligPct: 0.5 }
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    /* 这一条评分很高，所以「必填理由」只可能来自"拒绝"那一支 */
    expect(created.body.score.total).toBeGreaterThanOrEqual(65);

    const bare = await boss.post(`/v1/feasibility/${created.body.id}:decide`,
      { decision: "rejected" }, idem());
    expect(bare.status).toBe(422);

    const ok = await boss.post(`/v1/feasibility/${created.body.id}:decide`, {
      decision: "rejected", reason: "申办方已在同城选定另一家，避免相互抢病人"
    }, idem());
    expect(ok.status).toBe(201);
    expect(ok.body.data.rejectReason).toContain("抢病人");
  });

  it("overrideOnly 只留下「评分不够却入选了」的", async () => {
    const r = await boss.get("/v1/feasibility?limit=50&overrideOnly=true");
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(0);
    for (const f of r.body.items) {
      expect(f.status).toBe("selected");
      expect(f.score.total).toBeLessThan(65);
    }
  });
});

describe("回填与校准", () => {
  it("只有入选的中心谈得上实际入组速度", async () => {
    const assessing = (await boss.get("/v1/feasibility?limit=50&status=assessing"))
      .body.items[0];
    if (assessing) {
      const r = await boss.post(`/v1/feasibility/${assessing.id}:actual`,
        { actualRate: 2 }, idem());
      expect(r.status).toBe(422);
      expect(r.body.detail).toContain("没有入选");
    }
  });

  it("偏得离谱要当场说出来 —— 没人会主动去看那张回顾表", async () => {
    const selected = (await boss.get("/v1/feasibility?limit=50&status=selected"))
      .body.items.find((f: { score: { predictedPerMonth: number } }) =>
        f.score.predictedPerMonth > 0.5);
    expect(selected).toBeDefined();

    const r = await boss.post(`/v1/feasibility/${selected.id}:actual`,
      { actualRate: 0.1 }, idem());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.bias).toBeLessThan(0.5);
    expect(r.body.sideEffects.map((s: { type: string }) => s.type))
      .toContain("FeasibilityBias");
  });

  it("校准表答得出「当初说了不行」兑现了几次", async () => {
    const r = await boss.get("/v1/feasibility/calibration");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.selected).toBeGreaterThan(0);
    expect(r.body.meanBias).not.toBeNull();
    /* 种子里两家低分入选的，实际月入组是 0.5 与 0 —— 都低于 1 例 */
    expect(r.body.overrides).toBeGreaterThan(0);
    expect(r.body.overridesGoneBad).toBeGreaterThan(0);
    expect(r.body.calcVersion).toMatch(/^\d{4}\.\d+$/);
  });

  it("**calibration 不能被当成一个 id** —— 路由顺序", async () => {
    /* 反过来注册的话这里会拿到 422「参数不符合契约」，
       而那句话看不出是路由撞了。 */
    const r = await boss.get("/v1/feasibility/calibration");
    expect(r.status).toBe(200);
    expect("selected" in r.body).toBe(true);
  });
});

describe("登记", () => {
  it("同一个项目对同一家医院同一个科室只能有一份", async () => {
    const studyId = (await boss.get("/v1/studies?limit=1")).body.items[0].id;
    const body = {
      studyId, hospital: "重复登记医院", city: "某市", dept: "肿瘤科",
      piName: "某某", surveyedOn: "2026-08-20",
      answers: { ptYear: 100, pastN: 1, pastBest: 1, compet: 1, ethicsDays: 40,
                 startDays: 60, teamN: 4, piCommit: 2, eligPct: null }
    };
    expect((await boss.post("/v1/feasibility", body)).status).toBe(201);
    const dup = await boss.post("/v1/feasibility", body);
    expect(dup.status).toBeGreaterThanOrEqual(400);
  });

  it("编号在库里数 —— 且 UNIQUE 才是真正挡住重号的那一层", async () => {
    const studyId = (await boss.get("/v1/studies?limit=1")).body.items[0].id;
    const mk = (n: number) => boss.post("/v1/feasibility", {
      studyId, hospital: `并发登记医院${n}`, city: "某市", dept: "内科",
      piName: "某某", surveyedOn: "2026-08-20",
      answers: { ptYear: 100, pastN: 1, pastBest: 1, compet: 1, ethicsDays: 40,
                 startDays: 60, teamN: 4, piCommit: 2, eligPct: null }
    });
    const a = await mk(1), b = await mk(2);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.code).not.toBe(b.body.code);
    expect(a.body.code).toMatch(/^FS-2026-\d{3}$/);
    /* 注：`count(*) + 1` 只是把窗口收窄到一条语句，不是无竞态 ——
       并发撞上时由 UNIQUE 拒掉一条，而不是发出两个一样的编号。
       这条测试钉的是"顺序创建不重号 + 格式对"，
       并发那一半由数据库约束保证（见 0029 的 feasibility_code_uniq）。 */
  });
});
