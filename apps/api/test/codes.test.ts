import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { boot, resetDb, as, type Caller } from "./harness.js";

const idem = () => ({ "Idempotency-Key": randomUUID() });

/* ════════════════════════════════════════════════════════════════════
   编号：一处规则，一处发号。

   在此之前，同一个系统里有三套编号办法：

     ① 手输 —— 中心编号、筛选号、分组代号靠人现想现打。
        代价不是"多打几个字"，是**没有人能保证两个人想的是同一套**：
        演示数据里同一张 subject 表上并排躺着 S-0203 和 SS-01-P001，
        574 条对 24 条。
     ② `Date.now().toString(36)` —— 六处。生成 NP-MTV8AZLR 这样的串：
        唯一、不撞，但不可读、不可排序、不可口述。而同一张表里
        seed 灌进去的是 NP-2026-011。
     ③ `count(*) + 1` —— 三处。格式对，取号方式错：**行数不是序号**。
        缺口一出现就永远撞在缺口后面那个已经用掉的号上，
        而那些列上都有 UNIQUE (tenant_id, code) —— 撞了就是 500。

   下面这组盯的正是这三件事。
   ════════════════════════════════════════════════════════════════════ */

let app: INestApplication;
let boss: Caller, admin: Caller, pm: Caller, crc: Caller, dm: Caller;

beforeAll(async () => {
  resetDb(); app = await boot();
  boss  = await as(app, "lingyuan");
  admin = await as(app, "admin");
  pm    = await as(app, "hanxue");
  crc   = await as(app, "wutong");
  dm    = await as(app, "miaoqing");   // 只有 dm / cra / pm / qa 有 raiseQ
}, 180_000);
afterAll(async () => { await app?.close(); });

const seq = (code: string) => Number(code.slice(code.lastIndexOf("-") + 1));

describe("发号：按最大号取，不按行数", () => {
  it("**立项受理号越过 seed 留下的缺口** —— 按条数会撞在 038 上", async () => {
    const before = ((await boss.get("/v1/site-acceptances?limit=200")).body.items as
      { code: string }[]).map(a => a.code).filter(c => c.startsWith("AC-2026-"));
    /* 这条测试的前提：演示数据里的受理号是稀疏的。 */
    expect(before.length, "AC-2026 一条都没有，这条测试证明不了什么").toBeGreaterThan(1);
    const 最大 = Math.max(...before.map(seq));
    expect(最大, `AC-2026 的号是连续的（${before.join(" ")}），缺口才是这条测试的前提`)
      .toBeGreaterThan(before.length);

    const study = ((await boss.get("/v1/studies?limit=100")).body.items as
      { id: string }[])[0]!;
    const r = await boss.post("/v1/site-acceptances", {
      studyId: study.id, hospital: "发号测试医院",
      docs: ["方案", "知情同意书", "研究者手册"]
    }, idem());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(seq(r.body.code), "新受理号撞进了缺口里").toBe(最大 + 1);
  });

  it("连着发四个可行性号：彼此不撞，也不撞已有的", async () => {
    const study = ((await pm.get("/v1/studies?limit=100")).body.items as
      { id: string }[])[0]!;
    const 已有 = ((await pm.get("/v1/feasibility?limit=200")).body.items as
      { code: string }[]).map(f => f.code);

    const 新的: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await pm.post("/v1/feasibility", {
        studyId: study.id, hospital: `发号医院 ${i}`, city: "杭州",
        dept: "肿瘤内科", piName: "秦望", surveyedOn: "2026-09-10",
        answers: { ptYear: 600, pastN: 3, pastBest: 5, compet: 1,
          ethicsDays: 30, startDays: 45, teamN: 6, piCommit: 4, eligPct: 0.35 }
      }, idem());
      expect(r.status, `第 ${i + 1} 次：${JSON.stringify(r.body)}`).toBe(201);
      新的.push(r.body.code);
    }
    expect(new Set(新的).size, `发重了：${新的.join(" ")}`).toBe(4);
    for (const c of 新的) expect(已有).not.toContain(c);
    /* 四个是**连号**的 —— 起点不能拿"我看得见的最大号"来算：
       PM 的行范围是 team，他看得见的可行性只是全部里的一部分。
       而"按自己看得见的算最大号"正是发号必须绕开 RLS 的理由 ——
       在 RLS 下取号，取到的是别人已经用掉的号。 */
    const n = seq(新的[0]!);
    expect(新的.map(seq)).toEqual([n, n + 1, n + 2, n + 3]);
    for (const c of 新的) expect(c).toMatch(/^FS-\d{4}-\d{3}$/);
  });
});

describe("发号：格式统一，不再有第二套", () => {
  it("**立项申请号是 NP-年-序号**，不是 Date.now 那串", async () => {
    const a = await pm.post("/v1/intake-applications", {
      drug: "格式测试", sponsorName: "长空药业", phase: "II期", indication: "格式测试",
      plannedSites: 3, plannedSubjects: 30, enrollMonths: 8,
      contractCents: 300_0000_00, estimatedCostCents: 200_0000_00
    }, idem());
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body.data.code).toMatch(/^NP-\d{4}-\d{3}$/);
  });

  it("质量事件里四种前缀共用一张表，互不干扰", async () => {
    /* 数据质疑 Q- 与质量事件 QI- 落在同一张 quality_event 上。
       发号按「前缀 + 号段」取最大，所以 Q-1191 不会影响 QI-2026-0143。 */
    /* 筛败的受试者提不了质疑（不再录数据），入组中的才行。 */
    const subj = ((await dm.get("/v1/subjects?limit=200")).body.items as
      { id: string; state: string; screeningNo?: string }[])
      .find(s => s.screeningNo && ["enrolled", "screening"].includes(s.state));
    expect(subj, "seed 里应当有一个在组或筛选中的受试者").toBeTruthy();
    const q = await dm.post("/v1/data-queries", {
      subjectId: subj!.id, form: "AE 表", fieldName: "开始日期",
      detail: "开始日期晚于结束日期，请核对原始病历"
    }, idem());
    expect(q.status, JSON.stringify(q.body)).toBe(201);
    expect(q.body.code ?? q.body.data?.code).toMatch(/^Q-\d{4}$/);
  });
});

describe("发号：手输的三处不再需要手输", () => {
  it("**中心编号省略即自动**，接着 SS 的最大号往下发", async () => {
    const 已有 = ((await boss.get("/v1/study-sites?limit=200")).body.items as
      { code: string }[]).map(s => s.code).filter(c => /^SS-\d+$/.test(c));
    const 最大 = Math.max(...已有.map(seq));
    const study = ((await boss.get("/v1/studies?limit=100")).body.items as
      { id: string }[])[0]!;

    const r = await boss.post("/v1/study-sites", {
      studyId: study.id, hospital: "自动编号医院", dept: "呼吸科",
      city: "南京", piName: "顾方", contracted: 12,
      unitPriceCents: 3_0000_00, startupFeeCents: 8_0000_00
    }, idem());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.code).toBe(`SS-${String(最大 + 1).padStart(2, "0")}`);
  });

  it("传了编号就用传的 —— 申办方指定中心号是真实存在的情况", async () => {
    const study = ((await boss.get("/v1/studies?limit=100")).body.items as
      { id: string }[])[0]!;
    const r = await boss.post("/v1/study-sites", {
      studyId: study.id, code: "SPONSOR-77", hospital: "申办方指定医院",
      dept: "心内科", city: "苏州", piName: "邵宁", contracted: 8,
      unitPriceCents: 2_0000_00, startupFeeCents: 5_0000_00
    }, idem());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.code).toBe("SPONSOR-77");
  });

  it("**筛选号跟着中心走**：SS-NN-P001，省略即自动", async () => {
    /* 只有已启动的中心才能登记受试者 —— 找一个正在入组的。 */
    const site = ((await crc.get("/v1/study-sites?limit=200")).body.items as
      { id: string; code: string; state: string }[])
      .find(s => ["siv", "enrolling", "enrolled", "followup"].includes(s.state));
    expect(site, "seed 里应当有一个已启动的中心").toBeTruthy();

    const a = await crc.post("/v1/subjects", { studySiteId: site!.id }, idem());
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body.screeningNo).toMatch(new RegExp(`^${site!.code}-P\\d{3}$`));

    /* 连着两个不撞 */
    const b = await crc.post("/v1/subjects", { studySiteId: site!.id }, idem());
    expect(b.status).toBe(201);
    expect(b.body.screeningNo).not.toBe(a.body.screeningNo);
    expect(seq(b.body.screeningNo)).toBe(seq(a.body.screeningNo) + 1);
  });

  it("分组代号省略即自动，接着 G 的最大号", async () => {
    const 已有 = ((await admin.get("/v1/teams?limit=100")).body.items as
      { code: string }[]).map(t => t.code).filter(c => /^G-\d+$/.test(c));
    const 最大 = Math.max(...已有.map(seq));
    const r = await admin.post("/v1/teams", { name: "自动编号组" }, idem());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.code).toBe(`G-${String(最大 + 1).padStart(2, "0")}`);
  });
});

describe("规则表本身", () => {
  it("**没登记过的 kind 会报一句说得明白的话**，不会发一个奇怪的编号", async () => {
    /* 走不到 HTTP —— 直接问数据库。写错 kind 在服务层是个拼写错误，
       而一个"能容忍拼错"的发号函数会安静地发出 undefined-2026-001。 */
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: process.env["TEST_DATABASE_URL"] });
    try {
      const acct = await pool.query<{ id: string }>(
        "SELECT id FROM account WHERE login = 'lingyuan'");
      await pool.query("BEGIN");
      await pool.query("SELECT set_config('app.account_id', $1, true)", [acct.rows[0]!.id]);
      await expect(pool.query("SELECT app.next_code('没这种东西')"))
        .rejects.toThrow(/没有登记编号规则/);
      await pool.query("ROLLBACK");
    } finally { await pool.end(); }
  });

  it("child 形状不给上级编号也会拒绝 —— 而不是发出 -P001", async () => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: process.env["TEST_DATABASE_URL"] });
    try {
      const acct = await pool.query<{ id: string }>(
        "SELECT id FROM account WHERE login = 'lingyuan'");
      await pool.query("BEGIN");
      await pool.query("SELECT set_config('app.account_id', $1, true)", [acct.rows[0]!.id]);
      await expect(pool.query("SELECT app.next_code('subject')"))
        .rejects.toThrow(/上级编号/);
      await pool.query("ROLLBACK");
    } finally { await pool.end(); }
  });
});
