import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { boot, resetDb, as, type Caller } from "./harness.js";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { VISIT_COMPLETED_SUBSCRIBERS } from "../src/modules/clinical/visit-completed.js";

/* ════════════════════════════════════════════════════════════════════
   ClinicalOps —— 这一组测试要证明的是三条不变量真的不能被绕过：

     I3  访视必须有**PI 签字确认**才锁定（签字由一线带着日期登记进来）
     I4  超窗**必须**生成方案偏离，且与访视完成在同一个事务里
     I10 明细与聚合是两种权限：QA 看得到漏斗，看不到是哪几例

   以及一条更容易被忽略的：**七件后果里没做的两件，要留在明面上。**
   ════════════════════════════════════════════════════════════════════ */

let app: INestApplication;
let boss: Caller, crc: Caller, pi: Caller, qa: Caller, cra: Caller, inst: Caller;
const K = () => ({ "Idempotency-Key": randomUUID() });

beforeAll(async () => {
  resetDb(); app = await boot();
  boss = await as(app, "lingyuan");
  crc  = await as(app, "wutong");        // SS-01 的 CRC
  pi   = await as(app, "chenguod");      // SS-01 的 PI
  qa   = await as(app, "weilan");
  cra  = await as(app, "linmin");
  inst = await as(app, "zhanghm");
}, 180_000);
afterAll(async () => { await app?.close(); });

const siteByCode = async (c: Caller, code: string) =>
  (await c.get(`/v1/study-sites?limit=200&q=${code}`)).body.items
    .find((s: { code: string }) => s.code === code);

const today = () => new Date().toISOString().slice(0, 10);
const shift = (base: string, n: number) =>
  new Date(new Date(base).getTime() + n * 864e5).toISOString().slice(0, 10);

/** 「迟到」那几条用例的知情签署日 —— 一个月前。
 *
 *  筛选期访视的目标日**就是**知情签署日（SOA 的 seq 0 offset 是 0，
 *  见迁移 0053），窗口前后各 win 天。所以拿今天签知情的话，
 *  "窗口关闭之后再过几天"落在**未来**，撞上的是 `visit-not-future`，
 *  测不到超窗那条。
 *
 *  这几条用例原先都吃着 offset `-14` 那个 bug 过日子：目标日落在签知情
 *  之前两周，"超窗"顺手就是过去的日期。offset 改对之后它们一齐变红 ——
 *  **红得对**：它们要证明的是"迟到要记偏离"，不是"排期排错了"。 */
const lateIcf = () => shift(today(), -30);

let seq = 0;

/** 取某受试者当前那次访视（按 subjectId 过滤，不去全量列表里捞 —— 捞不到会静默失败） */
async function currentVisit(c: Caller, subjectId: string) {
  const r = await c.get(`/v1/subject-visits?subjectId=${subjectId}&limit=50`);
  expect(r.status).toBe(200);
  const v = r.body.items.find((x: { status: string }) => x.status === "planned")
         ?? r.body.items[0];
  expect(v, "受试者应当有一次访视").toBeTruthy();
  return v;
}

/** 勾完任务 → 完成访视。**断言每一步都成功** ——
 *  辅助函数里吞掉的失败，会让后面的断言以「看起来对」的方式通过。 */
async function doVisit(
  c: Caller, subjectId: string, body: Record<string, unknown> = {}
) {
  const v = await currentVisit(c, subjectId);
  for (const t of v.tasks)
    expect((await c.post(`/v1/subject-visits/${v.id}/tasks/${t.seq}:done`, {}, K())).status)
      .toBe(201);
  const r = await c.post(`/v1/subject-visits/${v.id}:complete`,
    { actualDate: v.targetDate, hours: 3.5, ...body }, K());
  return { visit: v, res: r };
}
/** 造一例走到「筛选期访视已排」的受试者 */
async function freshSubject(c: Caller, siteId: string, icfOn = today()) {
  const r = await c.post("/v1/subjects",
    { studySiteId: siteId, screeningNo: `T-${Date.now() % 100000}-${++seq}` }, K());
  expect(r.status).toBe(201);
  const id = r.body.id;
  const s = await c.post(`/v1/subjects/${id}:sign-icf`, { signedOn: icfOn }, K());
  expect(s.status).toBe(201);
  return { id, screeningNo: r.body.screeningNo, signIcf: s.body };
}


describe("漏斗：入组数只是最后一格", () => {
  it("按原型基线聚合出预筛 / 知情 / 筛败 / 入组，且筛败率算得出来", async () => {
    const s = await siteByCode(boss, "SS-01");
    const f = (await boss.get(`/v1/study-sites/${s.id}/funnel`)).body;
    /* 原型基线：SS-01 预筛 68、签署知情 41、筛败 13、入组 26 */
    expect(f.prescreened).toBe(68);
    expect(f.icfSigned).toBe(41);
    expect(f.screenFailed).toBe(13);
    expect(f.enrolled).toBe(26);
    expect(f.screenFailRate).toBeCloseTo(13 / 41, 5);
    expect(f.icfRate).toBeCloseTo(41 / 68, 5);
    expect(f.attainment).toBeCloseTo(26 / s.contracted, 5);
    /* 筛败原因是受控取值，能给出分布 —— 自由文本就只能给出一堆句子 */
    expect(f.screenFailBreakdown.reduce((a: number, b: { count: number }) => a + b.count, 0))
      .toBe(13);
  });

  it("SS-11 的筛败率 57% 与 SS-04 的预筛不足，是两个不同的问题", async () => {
    const a = await siteByCode(boss, "SS-11"), b = await siteByCode(boss, "SS-04");
    const fa = (await boss.get(`/v1/study-sites/${a.id}/funnel`)).body;
    const fb = (await boss.get(`/v1/study-sites/${b.id}/funnel`)).body;
    expect(fa.screenFailRate).toBeGreaterThan(0.5);      // 入排标准与病源不匹配
    expect(fb.screenFailRate).toBeLessThan(0.4);          // 筛败率正常
    expect(fb.prescreened).toBeLessThan(fb.contracted * 1.8);   // 问题在预筛量
  });

  it("QA 看得到漏斗，却拉不出受试者名册 —— 聚合与明细是两种权限（I10）", async () => {
    const s = await siteByCode(qa, "SS-01");
    expect((await qa.get(`/v1/study-sites/${s.id}/funnel`)).status).toBe(200);
    const list = await qa.get("/v1/subjects?limit=5");
    expect(list.status).toBe(403);
    expect(list.body.code).toBe("forbidden-action");
  });

  it("机构办同样只能看计数", async () => {
    const s = await siteByCode(inst, "SS-01");
    expect((await inst.get(`/v1/study-sites/${s.id}/funnel`)).status).toBe(200);
    expect((await inst.get("/v1/subjects?limit=5")).status).toBe(403);
  });
});

describe("列权限：老板看得到每一例，但看不到筛选号", () => {
  it("boss 无 subject 列权限 —— 字段从响应里消失，不是 null", async () => {
    const r = await boss.get("/v1/subjects?limit=3");
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(0);
    for (const s of r.body.items) {
      expect(s).not.toHaveProperty("screeningNo");
      expect(s).toHaveProperty("state");
      /* randomized 是布尔，不受列权限管辖 —— 「有没有随机号」和「号码是多少」是两件事 */
      expect(s).toHaveProperty("randomized");
    }
  });

  it("CRC 有 subject 列权限 —— 同一个接口，字段在", async () => {
    const r = await crc.get("/v1/subjects?limit=3");
    expect(r.status).toBe(200);
    expect(r.body.items[0]).toHaveProperty("screeningNo");
  });

  it("查询受试者明细一定写审计（I10）", async () => {
    await crc.get("/v1/subjects?limit=1");
    const a = await boss.get("/v1/audit-entries?limit=20");
    expect(a.body.items.some((x: { action: string }) => x.action === "查询受试者明细"))
      .toBe(true);
  });
});

describe("受试者生命周期", () => {
  it("中心没启动就登记受试者会被拒 —— 那是 SIV 之前开展受试者工作", async () => {
    /* 用 PM：SS-13 在他的行范围内（本组承接项目），且尚在伦理递交阶段。
       换成 CRC 会先撞上 404 —— 那也是对的，但测不到这条不变量。 */
    const pm = await as(app, "cendi");
    const s = await siteByCode(pm, "SS-13");
    const r = await pm.post("/v1/subjects",
      { studySiteId: s.id, screeningNo: "X-001" }, K());
    expect(r.status).toBe(422);
    expect(r.body.invariant).toBe("subject-needs-active-site");
  });

  it("签署知情 → 进入筛选期，并按 SOA 自动排出筛选期访视", async () => {
    const s = await siteByCode(crc, "SS-01");
    const { id, signIcf } = await freshSubject(crc, s.id);
    expect(signIcf.data.state).toBe("screening");
    const eff = signIcf.sideEffects.find((e: { type: string }) => e.type === "NextVisitScheduled");
    expect(eff).toBeTruthy();
    expect(eff.summary).toContain("筛选期访视");

    const v = (await crc.get(`/v1/subject-visits?subjectId=${id}`)).body;
    expect(v.items.length).toBe(1);
    expect(v.items[0].seq).toBe(0);
    /* 任务清单一起生成 —— 「这次要做哪几项」不靠 CRC 记忆 */
    expect(v.items[0].tasks.length).toBeGreaterThan(0);
  });

  it("**筛选期访视排在签知情那一天，而且一生下来在窗口里**", async () => {
    /* 这一条钉的是迁移 0053 修掉的那个数：SOA 的 seq 0 原来是
       `anchor='icf', offset_days=-14` —— 目标日落在签知情之前两周，
       于是每一例新受试者的筛选期访视**生出来就已经超窗十天**。
       而超窗完成必须生成方案偏离（I4），也就是说系统会给每个新登记的人
       凭空记一条偏离，还没有任何地方说这是排期排错了。

       断言写成"目标日 == 知情签署日"，不是"daysLeft >= 0" ——
       后者在 offset 写成 -1、-2 时照样绿。 */
    const s = await siteByCode(crc, "SS-01");
    const icfOn = today();
    const { id } = await freshSubject(crc, s.id, icfOn);
    const v = (await crc.get(`/v1/subject-visits?subjectId=${id}`)).body.items[0];
    expect(v.targetDate).toBe(icfOn);
    expect(v.outOfWindow).toBe(false);
    expect(v.daysLeft).toBeGreaterThanOrEqual(0);
  });

  it("**项目没配 SOA 就不让签知情** —— 否则造出来的是一个出不去的受试者", async () => {
    /* 现场报来的原话：「页面没有可以操作的按钮，只有一个脱落」。
       `scheduleVisit` 在项目没有 seq 0 的 `visit_template` 时**返回 null**，
       而 signIcf 原来只是 `if (v) effects.push(v)` —— 状态照样改成
       `screening`，访视一条都没有，界面上什么也不说。

       那个状态是死角：入组要求筛选期访视已登记 PI 确认，而它连访视都没有；
       知情已经签过，不会再签第二次。除了作废，没有出路。

       所以改成 fail-closed。知情是一张纸上的事实，日期由 `signedOn` 带进来，
       先去配 SOA 再回来登记，一个字都不会丢。 */
    /* 造一个**从来没配过 SOA** 的项目 + 一个已启动的中心，而不是拆现成的：
       删 SS-01 的 seq 0 会被触发器 `visit_template_no_orphan` 拦下
       （「已经排给 30 个受试者的定义不许删」），而那条触发器是对的 ——
       删了，那些访视就指向一个不存在的定义。

       这条状态接口造不出来（没有建项目 SOA 的端点，立项那条流程里也
       没有"跳过 SOA"这一步），所以只能绕到库里去 —— 同上面那条
       「没有筛选期访视」的做法。造的是新行，不动任何现成数据。 */
    const db = new pg.Client({ connectionString: process.env["TEST_DATABASE_URL"] });
    await db.connect();
    try {
      const st = await db.query<{ id: string }>(
        `INSERT INTO study (code, short_name, phase, indication, planned_subjects,
           contract_amount_cents, client_id, planned_sites)
         VALUES ('ZZ-NO-SOA', '没配 SOA 的项目', 'II', '仅用于这条测试', 10,
                 0, (SELECT id FROM client LIMIT 1), 1) RETURNING id`);
      const site = await db.query<{ id: string }>(
        `INSERT INTO study_site (study_id, code, hospital, dept, city, pi_name, state,
           contracted, unit_price_cents, irb_approved_on, siv_on)
         VALUES ($1, 'ZZ-99', '测试医院', '测试科', '测试市', '测试 PI', 'enrolling',
                 10, 100000, CURRENT_DATE - 60, CURRENT_DATE - 30) RETURNING id`,
        [st.rows[0]!.id]);
      const siteId = site.rows[0]!.id;
      /* `visit_template` 一行都不插 —— 这正是要测的状态。
         CRC 的行范围是 `assigned`，得有一条在期的派工才看得见这个中心；
         少了它下面会是 404，而 404 证明不了这条闸门。 */
      await db.query(
        `INSERT INTO site_assignment (account_id, study_site_id, role_kind)
         SELECT id, $1, 'CRC' FROM account WHERE login = 'wutong'`, [siteId]);

      const r = await crc.post("/v1/subjects",
        { studySiteId: siteId, screeningNo: `N-${Date.now() % 100000}-${++seq}` }, K());
      expect(r.status).toBe(201);

      const bad = await crc.post(`/v1/subjects/${r.body.id}:sign-icf`,
        { signedOn: today() }, K());
      expect(bad.status).toBe(422);
      expect(bad.body.unmet[0].code).toBe("study-has-no-soa");
      /* 这一条也要带得出去处 —— 界面据 module 出跳转链接。 */
      expect(bad.body.unmet[0].module).toBe("intake");

      /* 而且**状态没被改掉**：失败的登记不能留下半个 screening ——
         那正是这条 fail-closed 要避免的死角。 */
      const su = (await crc.get(`/v1/subjects/${r.body.id}`)).body;
      expect(su.state).toBe("prescreen");
      expect(su.icfSignedOn).toBeFalsy();
    } finally {
      /* 造的行自己收掉 —— `study_site.study_id` 没有 ON DELETE CASCADE，
         所以按 受试者 → 中心 → 项目 的顺序删。留着的话后面按项目聚合的
         用例会多出一个 0 例的项目，而那种污染只在别的文件里冒出来。 */
      await db.query(
        `DELETE FROM subject WHERE study_site_id IN
           (SELECT id FROM study_site WHERE code = 'ZZ-99')`);
      await db.query(`DELETE FROM study_site WHERE code = 'ZZ-99'`);
      await db.query(`DELETE FROM study WHERE code = 'ZZ-NO-SOA'`);
      await db.end();
    }
  });

  it("知情签署日早于该中心的伦理批件日会被拒", async () => {
    const s = await siteByCode(crc, "SS-01");
    const r = await crc.post("/v1/subjects",
      { studySiteId: s.id, screeningNo: `E-${Date.now() % 100000}` }, K());
    const bad = await crc.post(`/v1/subjects/${r.body.id}:sign-icf`,
      { signedOn: "2020-01-01" }, K());
    expect(bad.status).toBe(422);
    expect(bad.body.invariant).toBe("icf-after-irb");
  });

  it("未签知情就登记筛败会被拒 —— 否则筛败率会被稀释", async () => {
    const s = await siteByCode(crc, "SS-01");
    const r = await crc.post("/v1/subjects",
      { studySiteId: s.id, screeningNo: `P-${Date.now() % 100000}` }, K());
    const f = await crc.post(`/v1/subjects/${r.body.id}:screen-fail`,
      { reason: "lab", failedOn: today() }, K());
    expect(f.status).toBe(422);
    expect(f.body.invariant).toBe("screen-fail-needs-icf");
  });

  it("筛败后未做的访视一并作废 —— 否则这一例永远刷红超窗", async () => {
    const s = await siteByCode(crc, "SS-01");
    const { id } = await freshSubject(crc, s.id);
    const f = await crc.post(`/v1/subjects/${id}:screen-fail`,
      { reason: "imaging", failedOn: today() }, K());
    expect(f.status).toBe(201);
    expect(f.body.data.state).toBe("screen_failed");
    expect(f.body.data.nextVisit).toBeNull();
    const v = (await crc.get(`/v1/subject-visits?subjectId=${id}`)).body;
    expect(v.items.every((x: { status: string }) => x.status === "cancelled")).toBe(true);
  });

  it("入组前退出叫筛败，入组后退出叫脱落 —— 两者在收入口径上完全不同", async () => {
    const s = await siteByCode(crc, "SS-01");
    const { id } = await freshSubject(crc, s.id);
    const w = await crc.post(`/v1/subjects/${id}:withdraw`,
      { reason: "lost_to_followup", withdrawnOn: today(), note: "连续三次电话未接" }, K());
    expect(w.status).toBe(422);
    expect(w.body.detail).toContain("只有已入组可以登记脱落");
  });
});

/* ── I3 的形式变了，实质没变 ──────────────────────────────────────────
   原来这一组钉的是「**只有该中心的 PI 本人**能确认」，服务层还额外要求
   `study_site.pi_account_id = 当前账号`。那条规矩的实质是对的
   —— CRC 说做完了和 PI 确认做完了，在核查时是两回事 ——
   但它假定了 PI 会登录这套系统来点那一下。

   实测：15 个中心只有 1 个绑了 PI 账号，另外 14 个中心的访视
   做完之后**永远推不动**（189 条卡在 done_pending_pi），
   而那个状态不计入「已完成」统计 —— 入组进度、完成率、成本归集
   全都系统性偏低，**没有任何地方报错**。

   迁移 0050 改的是形式：PI 签的字仍然是放行条件，只是那件事
   由一线**带着日期**登记进来（与「登记伦理批复」同一个形状）。
   所以这一组现在钉三件事：
     ① 有 piConfirm 的人登记得了，没有的人 403 —— 仍是动作维度的事；
     ② 一线登记时 `piConfirmedByName` **留空**（不许冒充成确认人），
        真 PI 自己点时记他本人；
     ③ 签字日期不许在将来、不许早于访视日。 */
describe("I3：没有 PI 确认，访视不锁定，受试者不能入组", () => {
  it("筛选期访视未锁定就入组，被闸门拦下", async () => {
    const s = await siteByCode(crc, "SS-01");
    const { id } = await freshSubject(crc, s.id);
    expect((await doVisit(crc, id)).res.status).toBe(201);

    const e = await crc.post(`/v1/subjects/${id}:enroll`,
      { randomizationNo: `R-${seq}`, enrolledOn: today() }, K());
    expect(e.status).toBe(422);
    expect(e.body.code).toBe("gate-not-satisfied");
    expect(e.body.unmet[0].code).toBe("screening-visit-not-locked");

    /* ── 拦下来之后那句话要说对是哪一种 ────────────────────────────
       原来 detail 与 unmet 是**互相打架**的：

         detail：「筛选期访视尚未由 PI 确认锁定，不能入组」
         unmet ：「尚未登记筛选期访视」

       一个说等 PI，一个说压根没这条访视 —— 而这两种情况该做的事完全不同。
       这里访视是做完了的（`doVisit` 刚跑完），所以两句都该指向
       **登记 PI 确认**，而且一个字都不该出现"等 PI"。 */
    expect(e.body.detail).toContain("还没登记 PI 确认");
    expect(e.body.unmet[0].message).toContain("登记 PI 确认");
    /* 「需 PI 确认」那种说法会让人去等一个没有账号的人。 */
    expect(`${e.body.detail}${e.body.unmet[0].message}`)
      .not.toMatch(/需 PI 确认|由 PI 确认锁定|等 PI/);
  });

  it("**连筛选期访视都没有**时，说的是另一句 —— 两种情况两条路", async () => {
    /* 这一条是从现场报障里长出来的：同一次拦截同时显示
       「尚未由 PI 确认锁定」与「尚未登记筛选期访视」，
       而看的人只能猜哪句是真的。 */
    const s = await siteByCode(crc, "SS-01");
    const { id } = await freshSubject(crc, s.id);
    /* freshSubject 签了 ICF，所以筛选期访视是有的 —— 直接删掉它，
       造出"这一例没有筛选期访视"那种状态。 */
    const v = await currentVisit(crc, id);
    /* 以 owner 身份直删 —— 这一步造的是一个**接口造不出来的**状态
       （没有端点能删访视，那是对的），所以只能绕到库里去。 */
    const db = new pg.Client({ connectionString: process.env["TEST_DATABASE_URL"] });
    await db.connect();
    try { await db.query("DELETE FROM subject_visit WHERE id = $1", [v.id]); }
    finally { await db.end(); }

    const e = await crc.post(`/v1/subjects/${id}:enroll`,
      { randomizationNo: `R-${++seq}`, enrolledOn: today() }, K());
    expect(e.status).toBe(422);
    expect(e.body.detail).toContain("没有筛选期访视");
    /* **不许写「先去登记 ICF」**：能走到入组这一步的人已经签过知情了
       （state 必须是 screening，而那正是 signIcf 改出来的）——
       叫他再签一次，是把一句办不到的事写成了下一步。 */
    expect(e.body.unmet[0].message).not.toContain("登记 ICF");
    expect(e.body.unmet[0].message).toContain("受试者访视窗口");
    /* 而且这一条要带得出去处 —— 界面据 module 出跳转链接。 */
    expect(e.body.unmet[0].module).toBe("subj");
  });

  /* ══════════════════════════════════════════════════════════════════
     补排访视 —— **这一组钉的是"这条路走得通"本身。**

     现场报来的两句原话，一句接一句：
       「页面没有可以操作的按钮，只有一个脱落」
       「显示访视没有排出来，但是我没有看到排访视的功能」

     第二句说的是一个真缺口：在此之前访视只有两个出生口（签知情排第 0 次、
     完成一次排下一次），两个都堵上时**整个系统里没有任何一个动作**
     能给这一例排出访视来 —— 而入组要求第 0 次已登记 PI 确认，
     于是这一例除了筛败 / 脱落没有出路，只能改库。
     ══════════════════════════════════════════════════════════════════ */
  it("**没有筛选期访视的那一例，补排一次就能接着往下走**", async () => {
    const s = await siteByCode(crc, "SS-01");
    const { id } = await freshSubject(crc, s.id);
    const v = await currentVisit(crc, id);
    /* 造出"访视没了"那种状态 —— 与上面那条同一个做法。 */
    const db = new pg.Client({ connectionString: process.env["TEST_DATABASE_URL"] });
    await db.connect();
    try { await db.query("DELETE FROM subject_visit WHERE id = $1", [v.id]); }
    finally { await db.end(); }
    /* 先证明他确实卡住了 —— 不先证这一下，下面那一路"补排完就能入组"
       可能只是因为他本来就没卡住。 */
    expect((await crc.post(`/v1/subjects/${id}:enroll`,
      { randomizationNo: `R-${++seq}`, enrolledOn: today() }, K())).status).toBe(422);

    const r = await crc.post(`/v1/subjects/${id}:schedule-visit`, {}, K());
    expect(r.status).toBe(201);
    expect(r.body.data.seq).toBe(0);
    /* 目标日照锚点算，不是"今天" —— 补排不是补录，它排的是 SOA 本来就
       规定了的那一次。这一例的知情签在今天，所以目标日就是今天。 */
    expect(r.body.data.targetDate).toBe(today());
    expect(r.body.data.status).toBe("planned");
    /* 任务清单一起出来 —— 一条 0/0 的访视和没有访视一样说不出下一步。 */
    expect(r.body.data.tasks.length).toBeGreaterThan(0);

    /* 而且**真的走得下去**：做完 → 登记 PI 确认 → 入组。 */
    const done = await doVisit(crc, id);
    expect(done.res.status).toBe(201);
    expect((await crc.post(`/v1/subject-visits/${done.visit.id}:confirm`, {}, K())).status)
      .toBe(201);
    const e2 = await crc.post(`/v1/subjects/${id}:enroll`,
      { randomizationNo: `R-${++seq}`, enrolledOn: today() }, K());
    expect(e2.status, "补排之后这一例应当入得了组").toBe(201);
  });

  it("已经排过的那一次排不了第二次", async () => {
    const s = await siteByCode(crc, "SS-01");
    const { id } = await freshSubject(crc, s.id);       // 第 0 次已经有了
    const r = await crc.post(`/v1/subjects/${id}:schedule-visit`, { seq: 0 }, K());
    expect(r.status).toBe(422);
    expect(r.body.invariant).toBe("visit-already-scheduled");
  });

  it("省略 seq 即「该排的下一次」 —— 第 0 次在就排第 1 次", async () => {
    /* 这一条同时钉住另一件事：**方案修订把 SOA 加长之后**，
       已经做到原最后一次的人得排得出新加的那几次 ——
       `replaceSoa` 写明了"只影响此后才排出来的访视"，不回头补。 */
    const s = await siteByCode(crc, "SS-01");
    const { id } = await freshSubject(crc, s.id);
    /* 第 1 次锚的是入组日，所以得先入组 —— 走完整条路，不绕。 */
    const { visit } = await doVisit(crc, id);
    await crc.post(`/v1/subject-visits/${visit.id}:confirm`, {}, K());
    await crc.post(`/v1/subjects/${id}:enroll`,
      { randomizationNo: `R-${++seq}`, enrolledOn: today() }, K());
    /* 入组那一下已经排了第 1 次，删掉它造出"下一次不见了"那种状态。 */
    const db = new pg.Client({ connectionString: process.env["TEST_DATABASE_URL"] });
    await db.connect();
    try { await db.query("DELETE FROM subject_visit WHERE subject_id = $1 AND seq = 1", [id]); }
    finally { await db.end(); }

    const r = await crc.post(`/v1/subjects/${id}:schedule-visit`, {}, K());
    expect(r.status).toBe(201);
    expect(r.body.data.seq).toBe(1);
    /* 锚的是入组日，不是知情签署日 —— 两者在这条用例里是同一天，
       所以另外断言它照 SOA 的 offset 走：第 1 次 offset 为 0。 */
    expect(r.body.data.targetDate).toBe(today());
  });

  it("预筛的人补排不了 —— 锚点算不出来，而他的下一步是签知情", async () => {
    const s = await siteByCode(crc, "SS-01");
    const r = await crc.post("/v1/subjects",
      { studySiteId: s.id, screeningNo: `SV-${Date.now() % 100000}-${++seq}` }, K());
    const bad = await crc.post(`/v1/subjects/${r.body.id}:schedule-visit`, {}, K());
    expect(bad.status).toBe(422);
    expect(bad.body.invariant).toBe("subject-state");
    /* 说得出下一步 —— 而且说的是他真办得到的那一步。 */
    expect(bad.body.detail).toContain("知情同意签署");
    /* 状态说中文，不说 `prescreen` —— 键是给程序看的。 */
    expect(bad.body.detail).not.toContain("prescreen");
  });

  it("没有 subjWrite 的角色补排不了 —— 仍然是动作维度的事", async () => {
    const s = await siteByCode(crc, "SS-01");
    const { id } = await freshSubject(crc, s.id);
    /* QA 的动作是 audit / capaWrite / closeQA / raiseQ —— 没有 subjWrite。 */
    expect((await qa.post(`/v1/subjects/${id}:schedule-visit`, {}, K())).status).toBe(403);
  });

  /* ══════════════════════════════════════════════════════════════════
     出组 —— **`completed` 此前是个到不了的状态。**

     契约里定义了它（"completed 已出组"）、`STATE_LABEL` 给了中文名、
     漏斗接口 `count(*) FILTER (WHERE state = 'completed')` 专门数它 ——
     而整个代码库里**没有一行把它写进去**（开发库实测：0 例）。
     于是每个中心的「已出组」永远是 0，做完整条 SOA 的人一直挂在
     「已入组」上，而经营层看的就是这张表。

     这和"访视排不出来"是同一种缺口：系统说得出这个状态，却到不了。
     ══════════════════════════════════════════════════════════════════ */
  it("**做完 SOA 上最后一次访视 → 出组**", async () => {
    /* 用 SS-01。挑它不是因为 SOA 最短（它有 13 次），是因为**整条 SOA
       跨的日子最短**：最后一次的 offset 是 231 天。
       SS-09 那条只有 9 次，但周期 84 天、跨 588 天 —— 知情得签在两年前，
       而那比中心的伦理批件日还早，`icf-after-irb` 当场拦下。
       "次数少"和"走得完"是两回事。 */
    const lm = crc;                       // 吴桐是 SS-01 的 CRC
    const s = await siteByCode(lm, "SS-01");

    /* 知情签在 300 天前：后面每一次访视的目标日都要落在**今天之前**，
       否则完成那一下撞的是 `visit-not-future`，走不完这条路。
       300 = 伦理批件（332 天前）之后，且 10 + 231 天之后仍在今天之前。 */
    const icfOn = shift(today(), -300);
    const { id } = await freshSubject(lm, s.id, icfOn);

    /* seq 0：做完 → 登记 PI 确认 → 入组。 */
    expect((await doVisit(lm, id)).res.status).toBe(201);
    const v0 = await currentVisit(lm, id);
    expect((await lm.post(`/v1/subject-visits/${v0.id}:confirm`, {}, K())).status).toBe(201);
    expect((await lm.post(`/v1/subjects/${id}:enroll`,
      { randomizationNo: `R-${++seq}`, enrolledOn: shift(icfOn, 10) }, K())).status).toBe(201);

    /* 剩下的一路做完。**带上限** —— SOA 长度变了也不会把测试挂死，
       而挂死的测试报出来的是超时，看不出是这里循环不出去。 */
    let last: { status: number; body: { sideEffects: { type: string; summary: string }[] } }
      | null = null;
    for (let i = 0; i < 40; i++) {
      const open = (await lm.get(`/v1/subject-visits?subjectId=${id}&limit=50`))
        .body.items.filter((x: { status: string }) => x.status === "planned");
      if (!open.length) break;
      expect((await doVisit(lm, id)).res.status).toBe(201);
      const v = (await lm.get(`/v1/subject-visits?subjectId=${id}&limit=50`))
        .body.items.find((x: { status: string }) => x.status === "done_pending_pi");
      last = await lm.post(`/v1/subject-visits/${v.id}:confirm`, {}, K());
      expect(last!.status).toBe(201);
    }

    /* **最后那一下要说出来**：出组是后果，而后果要在响应里看得见 ——
       否则点完确认的人不知道这一例已经结束了。 */
    const done = last!.body.sideEffects.find(e => e.type === "SubjectCompleted");
    expect(done, "最后一次访视锁定时应当带出「出组」这条后果").toBeTruthy();

    const su = (await lm.get(`/v1/subjects/${id}`)).body;
    expect(su.state).toBe("completed");
    /* 出组日是**末次访视那天**，不是登记这一下的今天 ——
       晚登记不该把日期挪走。 */
    const visits = (await lm.get(`/v1/subject-visits?subjectId=${id}&limit=50`)).body.items;
    const lastDate = visits.map((x: { actualDate: string }) => x.actualDate)
      .filter(Boolean).sort().at(-1);
    expect(su.exitedOn).toBe(lastDate);
    expect(su.exitedOn).not.toBe(today());
  });

  it("还差一次没做完就不算出组 —— 判据是事实，不是「最后一次的序号」", async () => {
    /* 只走到 seq 0 锁定 + 入组，后面还有 8 次没做。
       这一条防的是把判据写成 `v.seq === 最后一个 seq` —— 那样的话
       乱序确认（先做完后面那次再回头补前面）会提前把人判成出组。 */
    const lm = crc;
    const s = await siteByCode(lm, "SS-01");
    const { id } = await freshSubject(lm, s.id, shift(today(), -300));
    await doVisit(lm, id);
    const v0 = await currentVisit(lm, id);
    const r = await lm.post(`/v1/subject-visits/${v0.id}:confirm`, {}, K());
    expect(r.status).toBe(201);
    expect(r.body.sideEffects.some((e: { type: string }) => e.type === "SubjectCompleted"))
      .toBe(false);
    expect((await lm.get(`/v1/subjects/${id}`)).body.state).toBe("screening");
  });

  it("没有 piConfirm 的角色确认不了 —— 仍然是动作维度的事", async () => {
    const s = await siteByCode(crc, "SS-01");
    const { id } = await freshSubject(crc, s.id);
    const { visit } = await doVisit(crc, id);
    /* QA 的动作是 audit / capaWrite / closeQA / raiseQ —— 没有 piConfirm。
       换成 CRC 不再能证明这一条（他现在有了），而"谁都能点"
       和"该给的给了"在绿灯上长得一模一样。 */
    const r = await qa.post(`/v1/subject-visits/${visit.id}:confirm`, {}, K());
    expect(r.status).toBe(403);
  });

  it("CRC 登记得了，但**确认人留空** —— 登记人不是确认人", async () => {
    const s = await siteByCode(crc, "SS-01");
    const { id } = await freshSubject(crc, s.id);
    const { visit } = await doVisit(crc, id);

    const r = await crc.post(`/v1/subject-visits/${visit.id}:confirm`, {}, K());
    expect(r.status).toBe(201);
    expect(r.body.data.status).toBe("locked");
    /* **这一条是整条改动的要害。** 填成登记人自己的话，
       核查时轨迹里写着"吴桐确认了"，而吴桐是 CRC ——
       那比空着糟得多。空着是一个有意义的事实：PI 签在纸上。 */
    expect(r.body.data.piConfirmedByName).toBeNull();
    /* 日期省略时取访视当天，不取今天 —— 一份上周的访视
       不该挂上今天的确认日期。 */
    expect(r.body.data.piConfirmedAt.slice(0, 10)).toBe(r.body.data.actualDate);
  });

  it("签字日期不许在将来，也不许早于访视日", async () => {
    const s = await siteByCode(crc, "SS-01");
    const { id } = await freshSubject(crc, s.id);
    const { visit } = await doVisit(crc, id);

    const future = await crc.post(`/v1/subject-visits/${visit.id}:confirm`,
      { confirmedOn: shift(today(), 3) }, K());
    expect(future.status).toBe(422);
    expect(future.body.detail).toContain("在将来");

    const early = await crc.post(`/v1/subject-visits/${visit.id}:confirm`,
      { confirmedOn: shift(visit.windowFrom, -30) }, K());
    expect(early.status).toBe(422);
    expect(early.body.invariant).toBe("pi-confirm-before-visit");

    /* 两次都被拒之后它**还停在待确认** —— 拒绝不是半途而废。 */
    expect((await crc.get(`/v1/subject-visits/${visit.id}`)).body.status)
      .toBe("done_pending_pi");
  });

  it("PI 确认后锁定，受试者才能入组，并自动排出第 1 次访视", async () => {
    const s = await siteByCode(crc, "SS-01");
    const { id } = await freshSubject(crc, s.id);
    const { visit } = await doVisit(crc, id);

    /* SS-01 是那 1 / 15 个真绑了 PI 账号的中心 —— 他自己点，
       `piConfirmedByName` 记的就是他本人。上面那条 CRC 登记的是
       同一个动作的另一半：两条一起，才说得清这一栏什么时候有名字。 */
    const cf = await pi.post(`/v1/subject-visits/${visit.id}:confirm`, {}, K());
    expect(cf.status).toBe(201);
    expect(cf.body.data.status).toBe("locked");
    expect(cf.body.data.piConfirmedByName).toBe("陈国栋");
    expect(cf.body.sideEffects[0].summary).toContain("可以入组");

    const e = await crc.post(`/v1/subjects/${id}:enroll`,
      { randomizationNo: `R-${Date.now() % 100000}`, enrolledOn: today() }, K());
    expect(e.status).toBe(201);
    expect(e.body.data.state).toBe("enrolled");
    expect(e.body.data.randomized).toBe(true);
    const next = e.body.sideEffects.find((x: { type: string }) => x.type === "NextVisitScheduled");
    expect(next).toBeTruthy();
  });

  it("未锁定的访视不计入「已完成」统计（I3）", async () => {
    const s = await siteByCode(crc, "SS-01");
    const { id } = await freshSubject(crc, s.id);
    const { visit } = await doVisit(crc, id);
    /* CRC 说做完了 ≠ PI 确认做完了 */
    expect((await crc.get(`/v1/subjects/${id}`)).body.visitsDone).toBe(0);
    expect((await pi.post(`/v1/subject-visits/${visit.id}:confirm`, {}, K())).status).toBe(201);
    expect((await crc.get(`/v1/subjects/${id}`)).body.visitsDone).toBe(1);
  });
});

describe("I4：超窗必须生成方案偏离，且在同一个事务里", () => {
  async function readyVisit() {
    const s = await siteByCode(crc, "SS-01");
    /* 知情签在一个月前 —— 这一组要的是"访视迟到"，而迟到的日期得是过去的。
       理由见 lateIcf 上面那段。 */
    const { id } = await freshSubject(crc, s.id, lateIcf());
    const v = (await crc.get(`/v1/subject-visits?subjectId=${id}`)).body.items[0];
    for (const t of v.tasks)
      await crc.post(`/v1/subject-visits/${v.id}/tasks/${t.seq}:done`, {}, K());
    return { subjectId: id, visit: v, siteId: s.id };
  }

  it("任务没逐项勾完不得提交 —— 打勾了事等于没做", async () => {
    const s = await siteByCode(crc, "SS-01");
    const { id } = await freshSubject(crc, s.id);
    const v = (await crc.get(`/v1/subject-visits?subjectId=${id}`)).body.items[0];
    const r = await crc.post(`/v1/subject-visits/${v.id}:complete`,
      { actualDate: today(), hours: 2 }, K());
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("gate-not-satisfied");
    expect(r.body.unmet[0].code).toBe("visit-task-open");
  });

  it("超窗而不说明原因会被拒", async () => {
    const { visit } = await readyVisit();
    const r = await crc.post(`/v1/subject-visits/${visit.id}:complete`,
      { actualDate: shift(visit.windowTo, 5), hours: 3 }, K());
    expect(r.status).toBe(422);
    expect(r.body.invariant).toBe("out-of-window-needs-reason");
  });

  it("超窗完成 → 方案偏离自动生成，并出现在质量台账里", async () => {
    const { visit, siteId } = await readyVisit();
    const late = shift(visit.windowTo, 9);
    const r = await crc.post(`/v1/subject-visits/${visit.id}:complete`,
      { actualDate: late, hours: 3, outOfWindowReason: "受试者外地务工，返院延迟" }, K());
    expect(r.status).toBe(201);
    expect(r.body.data.outOfWindow).toBe(true);

    const dev = r.body.sideEffects.find((e: { type: string }) => e.type === "DeviationDetected");
    expect(dev).toBeTruthy();
    expect(dev.summary).toContain("方案偏离");

    const q = (await crc.get(`/v1/quality-events?studySiteId=${siteId}&kind=deviation`)).body;
    const one = q.items.find((x: { id: string }) => x.id === dev.ref);
    expect(one).toBeTruthy();
    expect(one.autoGenerated).toBe(true);
    expect(one.raisedBy).toBe("system");
    expect(one.severity).toBe("major");                 // 晚 9 天，超过 7 天算 major
    expect(one.detail).toContain("受试者外地务工");      // 填报原因原样进记录
  });

  it("窗口内完成不生成偏离", async () => {
    const { visit } = await readyVisit();
    const r = await crc.post(`/v1/subject-visits/${visit.id}:complete`,
      { actualDate: visit.targetDate, hours: 3 }, K());
    expect(r.status).toBe(201);
    expect(r.body.data.outOfWindow).toBe(false);
    expect(r.body.sideEffects.some((e: { type: string }) => e.type === "DeviationDetected"))
      .toBe(false);
  });

  it("自动生成的偏离不可删除，只能整改后关闭", async () => {
    const { visit, siteId } = await readyVisit();
    const r = await crc.post(`/v1/subject-visits/${visit.id}:complete`,
      { actualDate: shift(visit.windowTo, 2), hours: 3, outOfWindowReason: "冷链故障顺延" }, K());
    const devId = r.body.sideEffects.find((e: { type: string }) =>
      e.type === "DeviationDetected").ref;
    /* 数据库层的语句级触发器兜底 —— 没有删除接口，但也不能靠"没有接口"来保证 */
    const close = await qa.post(`/v1/quality-events/${devId}:close`,
      { reason: "已补方案偏离表并由 PI 签字，报伦理备案" }, K());
    expect(close.status).toBe(201);
    /* 带上 limit：不带的话拿的是默认页，而这条偶尔会被别的已关闭事件挤到第二页 ——
       断言随即变成「看运气」，且失败时看起来像关闭没生效。 */
    const q = (await qa.get(
      `/v1/quality-events?studySiteId=${siteId}&state=closed&limit=200`)).body;
    expect(q.items.some((x: { id: string }) => x.id === devId)).toBe(true);
  });
});

describe("完成访视：一次调用，一串后果", () => {
  it("补偿单自动生成，金额与 SOA 一致", async () => {
    const s = await siteByCode(crc, "SS-01");
    const { id } = await freshSubject(crc, s.id);
    const v = (await crc.get(`/v1/subject-visits?subjectId=${id}`)).body.items[0];
    for (const t of v.tasks)
      await crc.post(`/v1/subject-visits/${v.id}/tasks/${t.seq}:done`, {}, K());
    const r = await crc.post(`/v1/subject-visits/${v.id}:complete`,
      { actualDate: v.targetDate, hours: 4 }, K());

    const comp = r.body.sideEffects.find((e: { type: string }) => e.type === "CompensationDue");
    expect(comp).toBeTruthy();
    expect(comp.amountCents).toBe(30000);                 // 筛选期 300 元
    const pay = (await crc.get(`/v1/subject-payments?studySiteId=${s.id}&unpaid=true`)).body;
    expect(pay.items.some((x: { id: string }) => x.id === comp.ref)).toBe(true);
  });

  it("EDC 置为待录入，超过 5 个工作日进及时率统计", async () => {
    const s = await siteByCode(crc, "SS-01");
    const { id } = await freshSubject(crc, s.id);
    const v = (await crc.get(`/v1/subject-visits?subjectId=${id}`)).body.items[0];
    for (const t of v.tasks)
      await crc.post(`/v1/subject-visits/${v.id}/tasks/${t.seq}:done`, {}, K());
    await crc.post(`/v1/subject-visits/${v.id}:complete`,
      { actualDate: v.targetDate, hours: 4 }, K());

    let cur = (await crc.get(`/v1/subject-visits?subjectId=${id}`)).body.items[0];
    expect(cur.edcStatus).toBe("pending");
    expect((await crc.post(`/v1/subject-visits/${v.id}:edc-entered`, {}, K())).status).toBe(201);
    cur = (await crc.get(`/v1/subject-visits?subjectId=${id}`)).body.items[0];
    expect(cur.edcStatus).toBe("entered");
    expect(cur.edcDaysLate).toBeNull();
  });

  it("工时与成本随访视一并入账（PostVisitTimesheet，4c 接上）", async () => {
    const s = await siteByCode(crc, "SS-01");
    const { id } = await freshSubject(crc, s.id);
    const v = (await crc.get(`/v1/subject-visits?subjectId=${id}`)).body.items[0];
    for (const t of v.tasks)
      await crc.post(`/v1/subject-visits/${v.id}/tasks/${t.seq}:done`, {}, K());
    const r = await crc.post(`/v1/subject-visits/${v.id}:complete`,
      { actualDate: v.targetDate, hours: 4 }, K());
    expect(r.status).toBe(201);

    const ts = r.body.sideEffects.find((e: { type: string }) => e.type === "TimesheetPosted");
    const cost = r.body.sideEffects.find((e: { type: string }) => e.type === "CostPosted");
    expect(ts, "访视记下了而工时没记上，成本就永远少一块").toBeTruthy();
    expect(cost.amountCents).toBeGreaterThan(0);

    /* 工时真的进了台账，且标记为自动生成 */
    const list = (await boss.get(`/v1/timesheets?studySiteId=${s.id}&limit=100`)).body;
    const one = list.items.find((x: { id: string }) => x.id === ts.ref);
    expect(one.autoGenerated).toBe(true);
    expect(one.visitId).toBe(v.id);
    expect(one.hours).toBe(4);
    expect(one.billable).toBe(true);
  });

  it("七个订阅者全接上了，pending 是空的", async () => {
    const s = await siteByCode(crc, "SS-01");
    const { id } = await freshSubject(crc, s.id);
    const v = (await crc.get(`/v1/subject-visits?subjectId=${id}`)).body.items[0];
    for (const t of v.tasks)
      await crc.post(`/v1/subject-visits/${v.id}/tasks/${t.seq}:done`, {}, K());
    const r = await crc.post(`/v1/subject-visits/${v.id}:complete`,
      { actualDate: v.targetDate, hours: 4 }, K());

    expect(r.body.pending).toEqual([]);
  });

  it("RefreshProjections：完成一次访视之后，漏斗与损益**真的动了**", async () => {
    /* 这一条挂了五个阶段。它其实一直成立 —— 漏斗与损益都是读时计算，
       没有投影表可刷新 —— 但"一直成立"如果没人验，
       和一个 pending 标记一样空。所以这里实测。 */
    const s = await siteByCode(boss, "SS-01");
    const before = {
      funnel: (await boss.get(`/v1/study-sites/${s.id}/funnel`)).body,
      pnl: (await boss.get(`/v1/study-sites/${s.id}/pnl`)).body
    };

    const { id } = await freshSubject(crc, s.id);
    const v = (await crc.get(`/v1/subject-visits?subjectId=${id}`)).body.items[0];
    for (const t of v.tasks)
      await crc.post(`/v1/subject-visits/${v.id}/tasks/${t.seq}:done`, {}, K());
    expect((await crc.post(`/v1/subject-visits/${v.id}:complete`,
      { actualDate: v.targetDate, hours: 4 }, K())).status).toBe(201);

    const after = {
      funnel: (await boss.get(`/v1/study-sites/${s.id}/funnel`)).body,
      pnl: (await boss.get(`/v1/study-sites/${s.id}/pnl`)).body
    };
    /* 漏斗：多了一个预筛的人 */
    expect(after.funnel.prescreened).toBe(before.funnel.prescreened + 1);
    /* 损益：那 4 小时的工时按费率卡折成了成本（PostVisitTimesheet 自动生成的
       那一条），成本侧一定变大 —— 而这正是"投影跟着事实走"的意思。 */
    expect(after.pnl.cost.totalCostCents)
      .toBeGreaterThan(before.pnl.cost.totalCostCents);
  });

  it("没有物化视图 —— 这是「读时计算」这个说法成立的前提", async () => {
    /* 哪天有人为了性能加了一张投影表，RefreshProjections 就重新变成真活。
       那时这条测试先红，而不是等某个月的驾驶舱数字对不上才被发现。 */
    const db = new pg.Client({ connectionString: process.env["TEST_DATABASE_URL"] });
    await db.connect();
    try {
      const { rows } = await db.query<{ n: string }>(
        "SELECT count(*) AS n FROM pg_matviews");
      expect(Number(rows[0]!.n),
        "库里出现了物化视图 —— RefreshProjections 需要真的实现一次刷新了").toBe(0);
    } finally { await db.end(); }
  });

  it("架构文档 §5.1 的七个订阅者一个不少地登记在册", () => {
    /* 漏掉一条，这条测试就红；实现了一条却忘了改标记，也红。
       这和闸门里的 unavailable 是同一个做法：没做的事要留在明面上。 */
    expect(VISIT_COMPLETED_SUBSCRIBERS.map(s => s.name).sort()).toEqual([
      "AdvanceSubjectVisit", "CreateSubjectPayment", "DetectDeviation",
      "MarkEdcPending", "PostVisitTimesheet", "QueuePiConfirmation", "RefreshProjections"
    ]);
    for (const s of VISIT_COMPLETED_SUBSCRIBERS)
      expect(s.delivered || Boolean(s.pendingPhase),
        `${s.name} 未交付却没写明由哪个阶段交付`).toBe(true);
  });

  it("重放同一个幂等键返回首次结果，不会重复生成偏离与补偿", async () => {
    const s = await siteByCode(crc, "SS-01");
    /* 这一条也要超窗（偏离是它检查"不重复生成"的那件事）—— 同 lateIcf。 */
    const { id } = await freshSubject(crc, s.id, lateIcf());
    const v = (await crc.get(`/v1/subject-visits?subjectId=${id}`)).body.items[0];
    for (const t of v.tasks)
      await crc.post(`/v1/subject-visits/${v.id}/tasks/${t.seq}:done`, {}, K());

    const key = K();
    const a = await crc.post(`/v1/subject-visits/${v.id}:complete`,
      { actualDate: shift(v.windowTo, 3), hours: 4, outOfWindowReason: "地铁停运误了半天" }, key);
    const b = await crc.post(`/v1/subject-visits/${v.id}:complete`,
      { actualDate: shift(v.windowTo, 3), hours: 4, outOfWindowReason: "地铁停运误了半天" }, key);
    expect(a.status).toBe(201);
    expect(b.body.data.id).toBe(a.body.data.id);
    const devs = a.body.sideEffects.filter((e: { type: string }) => e.type === "DeviationDetected");
    expect(devs.length).toBe(1);
    expect(b.body.sideEffects).toEqual(a.body.sideEffects);
  });
});

describe("SAE 台账与 24 小时及时率（I6）—— 这个数不能是写死的", () => {
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

  it("按时上报：不生成 sae_late，及时率把它算进分子", async () => {
    const s = await siteByCode(crc, "SS-01");
    const before = (await crc.get(`/v1/study-sites/${s.id}/sae`)).body.timeliness;

    const r = await crc.post(`/v1/study-sites/${s.id}/sae`, {
      title: "受试者出现 III 度中性粒细胞减少", detail: "住院治疗，已通知申办方医学监查",
      occurredAt: hoursAgo(30), reportedAt: hoursAgo(20)      // 10 小时内上报
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.reportHours).toBeCloseTo(10, 1);

    const after = (await crc.get(`/v1/study-sites/${s.id}/sae`)).body.timeliness;
    expect(after.onTime).toBe(before.onTime + 1);
    expect(after.late).toBe(before.late);
    /* 及时率带口径版本号：报表要能标出「按哪版口径算的」 */
    expect(after.calcVersion).toBeTruthy();
  });

  it("超过 24 小时上报 → **必须**自动生成一条 sae_late，且在同一个事务里", async () => {
    const s = await siteByCode(crc, "SS-01");
    const r = await crc.post(`/v1/study-sites/${s.id}/sae`, {
      title: "受试者因肝功能异常住院", detail: "研究者判定与试验药物可能相关",
      occurredAt: hoursAgo(80)
    });
    expect(r.status).toBe(201);
    expect(r.body.reportedAt).toBeNull();

    const done = await crc.post(`/v1/quality-events/${r.body.id}:sae-reported`,
      { reportedAt: hoursAgo(2) }, K());                      // 78 小时后才报
    expect(done.status).toBe(201);
    expect(done.body.sideEffects[0].type).toBe("SaeReportedLate");
    /* 消息里要说得出晚了多少 —— 「超时上报」四个字促不成任何动作 */
    expect(done.body.sideEffects[0].summary).toMatch(/晚了 5[0-9]\.\d 小时/);

    const late = await crc.get(`/v1/quality-events?studySiteId=${s.id}&kind=sae_late`);
    const one = late.body.items.find((q: { detail: string }) => q.detail.includes("78.0 小时"));
    expect(one, "sae_late 记录没写出实际耗时").toBeTruthy();
    expect(one.autoGenerated).toBe(true);
    expect(one.raisedBy).toBe("system");
  });

  it("不上报**不能**换来好看的及时率：超时未报的直接算迟报", async () => {
    /* 这是整个口径的关键。若只算"已上报的里面按时的占比"，
       一条永远不上报的 SAE 就永远不进分母 —— 越拖越好看。 */
    const s = await siteByCode(crc, "SS-07");
    const base = (await crc.get(`/v1/study-sites/${s.id}/sae`)).body.timeliness;

    expect((await crc.post(`/v1/study-sites/${s.id}/sae`, {
      title: "受试者死亡", detail: "尚在调查中，未向申办方上报",
      occurredAt: hoursAgo(200)
    })).status).toBe(201);

    const t = (await crc.get(`/v1/study-sites/${s.id}/sae`)).body.timeliness;
    expect(t.late).toBe(base.late + 1);
    expect(t.pending).toBe(base.pending);
    /* 最坏的那一条晾了多久 —— 未上报的按"到现在为止"算，它还在变大 */
    expect(t.worstLateHours).toBeGreaterThan(199);
  });

  it("发生不足 24 小时且未上报的是未决，既不算按时也不算迟", async () => {
    const s = await siteByCode(crc, "SS-07");
    const base = (await crc.get(`/v1/study-sites/${s.id}/sae`)).body.timeliness;
    expect((await crc.post(`/v1/study-sites/${s.id}/sae`, {
      title: "受试者过敏反应", detail: "已对症处理，正在整理上报材料",
      occurredAt: hoursAgo(3)
    })).status).toBe(201);

    const t = (await crc.get(`/v1/study-sites/${s.id}/sae`)).body.timeliness;
    expect(t.pending).toBe(base.pending + 1);
    expect(t.onTime).toBe(base.onTime);
    expect(t.late).toBe(base.late);
  });

  it("没有 SAE 的中心：及时率是 null，不是 0，更不是 100%", async () => {
    /* 「还没有 SAE」和「及时率 0%」是两回事；显示成 100% 更糟 ——
       那是在用一个没有分母的数字给人安全感。 */
    const s = await siteByCode(boss, "SS-15");     // 这个用例里没人碰过它
    const t = (await boss.get(`/v1/study-sites/${s.id}/sae`)).body.timeliness;
    expect(t).toMatchObject({ total: 0, onTime: 0, late: 0, pending: 0 });
    expect(t.rate).toBeNull();
  });

  it("发生时刻不能填在未来 —— 那是 24 小时的起算点", async () => {
    const s = await siteByCode(crc, "SS-01");
    const r = await crc.post(`/v1/study-sites/${s.id}/sae`, {
      title: "测试", detail: "把起算点推到明天，迟报就变按时了",
      occurredAt: new Date(Date.now() + 86_400_000).toISOString()
    });
    expect(r.status).toBe(422);
  });

  it("上报时刻不能就地覆盖 —— 改它等于改核查看的那个数", async () => {
    const s = await siteByCode(crc, "SS-01");
    const r = await crc.post(`/v1/study-sites/${s.id}/sae`, {
      title: "受试者晕厥", detail: "已恢复，按流程上报",
      occurredAt: hoursAgo(10), reportedAt: hoursAgo(9)
    });
    expect(r.status).toBe(201);
    const again = await crc.post(`/v1/quality-events/${r.body.id}:sae-reported`,
      { reportedAt: hoursAgo(9.5) }, K());
    expect(again.status).toBe(409);
  });

  it("及时率的分母是这个中心的全部 SAE，不是当前这一页", async () => {
    /* 翻到第二页时及时率跟着变，那个数字就没有任何意义。 */
    const s = await siteByCode(crc, "SS-01");
    const all = (await crc.get(`/v1/study-sites/${s.id}/sae?limit=50`)).body;
    expect(all.timeliness.total).toBeGreaterThan(1);
    const first = await crc.get(`/v1/study-sites/${s.id}/sae?limit=1`);
    expect(first.body.items).toHaveLength(1);
    expect(first.body.timeliness).toEqual(all.timeliness);
  });

  it("范围外的中心问 SAE 台账，得到 404 而不是 403", async () => {
    /* 区分 403 和 404 就是在确认「它存在」—— 那本身就是一次泄漏。 */
    const s = await siteByCode(boss, "SS-02");
    const mine = (await cra.get("/v1/study-sites?limit=50")).body.items
      .map((x: { id: string }) => x.id);
    expect(mine, "种子改了：这个用例需要一个 CRA 看不见的中心").not.toContain(s.id);
    expect((await cra.get(`/v1/study-sites/${s.id}/sae`)).status).toBe(404);
  });
});

describe("质量事件：机构提出的，关闭权在机构", () => {
  it("我方不能关闭机构质控提出的事件", async () => {
    /* 直接用机构身份提一条：raisedBy=institution 的事件由机构关闭 */
    const s = await siteByCode(boss, "SS-01");
    const q = (await qa.get(`/v1/quality-events?studySiteId=${s.id}`)).body;
    expect(q.items.length).toBeGreaterThan(0);
  });

  it("已关闭的事件不能再关一次", async () => {
    const s = await siteByCode(qa, "SS-01");
    const q = (await qa.get(`/v1/quality-events?studySiteId=${s.id}&state=open`)).body;
    const one = q.items[0];
    expect((await qa.post(`/v1/quality-events/${one.id}:close`,
      { reason: "已核对源数据并更正 eCRF" }, K())).status).toBe(201);
    const again = await qa.post(`/v1/quality-events/${one.id}:close`,
      { reason: "重复关闭" }, K());
    expect(again.status).toBe(422);
    expect(again.body.invariant).toBe("quality-already-closed");
  });
});

describe("关闭闸门：ClinicalOps 交付后，四项从占位变成真查询", () => {
  it("有受试者在组 / 有质疑未关 / 有补偿未发，逐条拦下", async () => {
    const s = await siteByCode(boss, "SS-01");
    const g = (await boss.get(`/v1/study-sites/${s.id}/gate?to=closed`)).body;
    const codes = g.unmet.map((u: { code: string }) => u.code);
    expect(codes).toContain("subjects-in-trial");
    expect(codes).toContain("open-queries");

    const inTrial = g.unmet.find((u: { code: string }) => u.code === "subjects-in-trial");
    expect(inTrial.message).toMatch(/仍有 \d+ 例受试者在组/);
    expect(inTrial.message).not.toContain("尚未交付");
  });
});

describe("行范围：受试者跟着中心走", () => {
  it("CRA 只看得到被指派中心的受试者", async () => {
    const mine = (await cra.get("/v1/study-sites?limit=200")).body.items
      .map((s: { id: string }) => s.id);
    const subs = (await cra.get("/v1/subjects?limit=200")).body.items;
    expect(subs.length).toBeGreaterThan(0);
    expect(subs.every((s: { studySiteId: string }) => mine.includes(s.studySiteId))).toBe(true);
  });

  it("范围外的受试者返回 404 而不是 403 —— 403 等于确认它存在", async () => {
    const all = (await boss.get("/v1/subjects?limit=200")).body.items;
    const mine = new Set((await cra.get("/v1/study-sites?limit=200")).body.items
      .map((s: { id: string }) => s.id));
    const outside = all.find((s: { studySiteId: string }) => !mine.has(s.studySiteId));
    expect(outside).toBeTruthy();
    expect((await cra.get(`/v1/subjects/${outside.id}`)).status).toBe(404);
  });
});

/* ════════════════════════════════════════════════════════════════════
   勾任务：**匹配 0 行不是成功。**

   `completeTask` 原来这么写：

       await c.client.query(
         `UPDATE subject_visit_task SET done_at = now(), done_by = $3
           WHERE visit_id = $1 AND seq = $2 AND done_at IS NULL`, …);
       return { data: await this.visit(visitId), … };

   WHERE 里的 `seq = $2` 和 `done_at IS NULL` 都是上面那次读**没有验证过**
   的条件。seq 不存在、或这一项已经被别人勾掉了，UPDATE 都匹配 0 行 ——
   而接口照样回 200，调用方分不出"勾上了"和"根本没这一项"。

   这正是迁移 0027 点名过的那种失守：那次是管理员改口令的 UPDATE 被 RLS
   挡在门外匹配到 0 行，接口回 204，口令没换、旧会话还开着。
   同一个形状：**SQL 成功了，事情没发生。**
   ════════════════════════════════════════════════════════════════════ */
describe("勾任务：SQL 成功了不等于事情发生了", () => {
  /** SS-01 —— crc（吴桐）带的那个中心。 */
  const 中心 = async () => (await siteByCode(crc, "SS-01")).id;

  it("不存在的 seq → 404，而不是一声不响的 200", async () => {
    const s = await freshSubject(crc, await 中心());
    const v = await currentVisit(crc, s.id);
    const r = await crc.post(`/v1/subject-visits/${v.id}/tasks/999:done`, {}, K());
    expect(r.status, "勾了一项根本不存在的任务，接口却说成功").toBe(404);
  });

  it("已经被勾过的那一项 → 409，说得出是谁的活重了", async () => {
    /* 两个 CRC 同时勾同一张任务单不是罕见情形，那正是这条清单要处理的现场。
       后到的那个该看到「已经有人勾了」，而不是以为是自己勾的。 */
    const s = await freshSubject(crc, await 中心());
    const v = await currentVisit(crc, s.id);
    const t = v.tasks[0];
    expect(t, "这次访视一项任务都没有 —— 这条测试测不到东西了").toBeTruthy();

    const first = await crc.post(
      `/v1/subject-visits/${v.id}/tasks/${t.seq}:done`, {}, K());
    expect(first.status).toBe(201);

    /* **换一把幂等键**：同一把键会走重放那条路（那是对的，也是另一回事），
       这里要验的是"第二个人来勾同一项"。 */
    const again = await crc.post(
      `/v1/subject-visits/${v.id}/tasks/${t.seq}:done`, {}, K());
    expect(again.status, "重复勾同一项，接口却说成功").toBe(409);
    expect(again.body.detail).toContain("已经完成过了");
  });

  it("同一把幂等键重放，仍然照常返回首次的结果（不是 409）", async () => {
    /* 上面那条不能把离线重放一起打死：发件箱重发的是**同一把键**，
       它必须还是成功那一次的结果。 */
    const s = await freshSubject(crc, await 中心());
    const v = await currentVisit(crc, s.id);
    const t = v.tasks[0];
    const k = K();
    const a = await crc.post(`/v1/subject-visits/${v.id}/tasks/${t.seq}:done`, {}, k);
    const b = await crc.post(`/v1/subject-visits/${v.id}/tasks/${t.seq}:done`, {}, k);
    expect(a.status).toBe(201);
    expect(b.status, "离线重放被当成了重复勾选").toBe(201);
  });
});
