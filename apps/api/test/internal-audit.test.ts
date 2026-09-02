import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { boot, resetDb, as, type Caller } from "./harness.js";

const idem = () => ({ "Idempotency-Key": randomUUID() });

/* ════════════════════════════════════════════════════════════════════
   内部稽查与 CAPA 有效性。

   **文件名是 internal-audit** —— `audit.test.ts` 已经被审计轨迹
   （`audit_entry`：谁在什么时候改了什么）占着。两者中文都叫"审计/稽查"，
   但毫无关系。这个重名在 db/ 和 apps/api/ 各踩了一次。

   这一组盯的是**这套判定怎么失去意义**：
     · 写措施的人自己验证关闭 —— 「已关闭」在核查时一文不值；
     · 机构办能对我方发起内部稽查 —— 自查变成他查；
     · 复发指向一条今天才提出的事件 —— 整类问题被误判成 CAPA 无效；
     · 「待观察」里混着「根本没人写措施」。
   ════════════════════════════════════════════════════════════════════ */

let app: INestApplication;
let qa: Caller, crc: Caller, pm: Caller, cra: Caller, boss: Caller, inst: Caller;

beforeAll(async () => {
  resetDb(); app = await boot();
  qa   = await as(app, "weilan");
  crc  = await as(app, "wutong");
  pm   = await as(app, "hanxue");
  cra  = await as(app, "linmin");
  boss = await as(app, "lingyuan");
  inst = await as(app, "zhanghm");
}, 180_000);
afterAll(async () => { await app?.close(); });

const audits = async (c: Caller, qs = "") =>
  (await c.get(`/v1/internal-audits?limit=100${qs}`)).body.items as any[];

describe("稽查台账", () => {
  it("种子里的四次稽查都在，每一条都答得出「谁查的、查了什么」", async () => {
    const items = await audits(qa);
    expect(items.length).toBeGreaterThanOrEqual(4);
    for (const a of items) {
      expect(a.auditorName).toBeTruthy();
      expect(a.scope.length).toBeGreaterThanOrEqual(4);
    }
  });

  it("**外部方一条都看不到** —— 自查报告给被查方看，下次就查不出东西了", async () => {
    expect(await audits(inst)).toHaveLength(0);
    const b = await inst.get("/v1/internal-audits/board");
    expect(b.status).toBe(200);
    expect(b.body.sites).toHaveLength(0);
  });

  it("最近的排最前 —— 稽查看的是当前状态", async () => {
    const items = await audits(qa);
    const days = items.map(a => a.auditedOn);
    expect([...days].sort().reverse()).toEqual(days);
  });

  it("复发那一条带得出源事件编号，以及源事件当时关没关", async () => {
    const items = await audits(qa);
    const rep = items.flatMap(a => a.findings).filter((f: any) => f.repeatOf);
    expect(rep.length, "种子里有一条复发发现").toBeGreaterThan(0);
    expect(rep[0].repeatOfCode).toMatch(/^QI-/);
    expect(typeof rep[0].repeatAfterClose).toBe("boolean");
  });
});

describe("CAPA 有效性", () => {
  it("**复发的类型判成无效**，且分得清关闭后还是整改期内", async () => {
    const b = (await qa.get("/v1/internal-audits/board")).body;
    const bad = b.capa.filter((c: any) => c.verdict === "ineffective");
    expect(bad.length, "种子里有一条复发").toBeGreaterThan(0);
    const one = bad[0];
    expect(one.repeatAfterClose + one.repeatWhileOpen).toBeGreaterThan(0);
    /* 无效的排在最前 —— 它是这张表唯一要人立刻动手的那一行 */
    expect(b.capa[0].verdict).toBe("ineffective");
  });

  it("**「没人管」从「待观察」里拆出来** —— 欠着措施不是在观察", async () => {
    const b = (await qa.get("/v1/internal-audits/board")).body;
    expect(b.owesCapaPlan, "种子里有三条机构质控发现还没提交整改措施")
      .toBeGreaterThan(0);
    const unowned = b.capa.filter((c: any) => c.verdict === "unowned");
    expect(unowned.length).toBeGreaterThan(0);
    for (const c of unowned) expect(c.owesPlan).toBeGreaterThan(0);
  });

  it("质疑不进这张表 —— 它走自己的闭环", async () => {
    const b = (await qa.get("/v1/internal-audits/board")).body;
    expect(b.capa.map((c: any) => c.category)).not.toContain("数据质疑");
  });

  it("**每个中心都评级，不只是入组中的那些**", async () => {
    const b = (await boss.get("/v1/internal-audits/board")).body;
    expect(b.sites.length).toBeGreaterThanOrEqual(15);
    for (const s of b.sites) {
      expect(["A", "B", "C", "D"]).toContain(s.grade);
      expect(s.reasons.length, `${s.siteCode} 没给理由`).toBeGreaterThan(0);
    }
    /* A 级也要说话 */
    const clean = b.sites.filter((s: any) => s.grade === "A");
    if (clean.length) expect(clean[0].reasons).toEqual(["无扣分项"]);
  });

  it("**按中心筛也算得出来** —— 三条查询各编各的参数号", async () => {
    /* 这一条盯的是一个只在带筛选时才出现的坑：
       三条 SQL 共用一个参数数组，会得到一条只引用 $2 不引用 $1 的语句，
       Postgres 报「无法确定 $1 的类型」，而错误指不到那一行。
       不带筛选时恰好只有一个参数，所以默认路径上它不响。 */
    const site = (await boss.get("/v1/study-sites?limit=1")).body.items[0];
    const r = await boss.get(`/v1/internal-audits/board?studySiteId=${site.id}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.sites).toHaveLength(1);
    expect(r.body.sites[0].studySiteId).toBe(site.id);

    /* 顶上那三个数也要跟着筛 —— 否则页头说「3 项进行中」而下面一条都没有。 */
    const all = (await boss.get("/v1/internal-audits/board")).body;
    expect(r.body.openAudits).toBeLessThanOrEqual(all.openAudits);
    expect(r.body.repeatFindings).toBeLessThanOrEqual(all.repeatFindings);
  });

  it("扣分最高的排最前", async () => {
    const b = (await boss.get("/v1/internal-audits/board")).body;
    const p = b.sites.map((s: any) => s.penalty);
    expect([...p].sort((x: number, y: number) => y - x)).toEqual(p);
  });
});

describe("谁能查、谁能关", () => {
  const siteId = async () =>
    (await qa.get("/v1/study-sites?limit=1&state=enrolling")).body.items[0].id;
  const open = async (c: Caller) => c.post("/v1/internal-audits", {
    studySiteId: await siteId(), kind: "site",
    scope: "针对该中心质疑挂起与源数据签名问题的专项稽查"
  }, idem());

  it("**机构办发起不了内部稽查** —— 它有 closeQA，但没有 audit", async () => {
    expect((await open(inst)).status).toBe(403);
  });

  it("**PM 也发起不了** —— 稽查是 QA 的第二道防线，不是项目管理动作", async () => {
    expect((await open(pm)).status).toBe(403);
  });

  it("QA 发起：范围落库，状态是进行中", async () => {
    const r = await open(qa);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.state).toBe("open");
    expect(r.body.data.findings).toHaveLength(0);
    expect(r.body.sideEffects[0].summary).toContain("自动结案");
  });

  it("稽查日期不能在将来", async () => {
    const r = await qa.post("/v1/internal-audits", {
      studySiteId: await siteId(), kind: "system", auditedOn: "2027-01-01",
      scope: "体系稽查：SOP 执行与培训记录"
    }, idem());
    expect(r.status).toBe(422);
    expect(r.body.invariant).toBe("audit-future-date");
  });

  it("记一条发现 → 稽查进入待整改", async () => {
    const a = (await open(qa)).body.data;
    const r = await qa.post(`/v1/internal-audits/${a.id}:finding`, {
      severity: "major", finding: "筛选失败日志未按 SOP 逐例记录失败原因"
    }, idem());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.state).toBe("remediating");
    expect(r.body.data.openFindings).toBe(1);
  });

  it("**复发不能指向一条不早于本次稽查的事件**", async () => {
    const a = (await open(qa)).body.data;
    /* 今天新提一条质量事件，再把它当成"复发的源头" */
    const fresh = await qa.get("/v1/quality-events?limit=100");
    const today = fresh.body.items.find((e: any) =>
      e.raisedOn >= a.auditedOn && e.kind !== "query");
    if (!today) return;   // 种子里没有今天提出的事件时跳过
    const r = await qa.post(`/v1/internal-audits/${a.id}:finding`, {
      severity: "minor", finding: "同一个问题又出现了，指向今天的事件",
      repeatOf: today.id
    }, idem());
    expect(r.status).toBe(422);
    expect(r.body.invariant).toBe("repeat-not-earlier");
  });

  it("**验证说明必填，全部关闭时自动结案**", async () => {
    const a = (await open(qa)).body.data;
    await qa.post(`/v1/internal-audits/${a.id}:finding`, {
      severity: "minor", finding: "研究者签名缺日期共 4 处"
    }, idem());

    const short = await qa.post(`/v1/internal-audits/${a.id}/findings/0:close`,
      { verification: "已整改" }, idem());
    expect(short.status, "「已整改」三个字不是验证").toBe(422);

    const ok = await qa.post(`/v1/internal-audits/${a.id}/findings/0:close`,
      { verification: "已抽查复核 20 份原始病历，签名与日期齐全，证据已归档" }, idem());
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data.state).toBe("closed");
    expect(ok.body.sideEffects[0].summary).toContain("自动结案");
  });

  it("结案之后不能再加发现 —— 新发现要新开一次稽查", async () => {
    const a = (await open(qa)).body.data;
    await qa.post(`/v1/internal-audits/${a.id}:finding`,
      { severity: "minor", finding: "一条用来结案的发现项，随后立刻关闭" }, idem());
    await qa.post(`/v1/internal-audits/${a.id}/findings/0:close`,
      { verification: "已抽查复核，问题未再出现，整改证据已归档" }, idem());
    const r = await qa.post(`/v1/internal-audits/${a.id}:finding`,
      { severity: "minor", finding: "结案之后又想起来一条" }, idem());
    expect(r.status).toBe(422);
    expect(r.body.invariant).toBe("audit-closed");
  });
});

describe("CAPA：写措施的人不能自己验证关闭", () => {
  const anEvent = async (c: Caller) => {
    const r = await c.get("/v1/quality-events?limit=100");
    return r.body.items.find((e: any) =>
      e.kind !== "query" && e.state !== "closed");
  };

  it("CRC 写得了措施 —— 他是整改责任人", async () => {
    const e = await anEvent(crc);
    expect(e, "CRC 范围内应该有未关闭的质量事件").toBeTruthy();
    const r = await crc.post(`/v1/quality-events/${e.id}:capa`, {
      plan: "研究者集中补签并留痕；CRC 建立每周源数据完整性自查清单并留档",
      dueOn: "2026-12-31"
    }, idem());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.capaPlan).toContain("每周源数据完整性自查");
    expect(r.body.data.owesCapaPlan).toBe(false);
    expect(r.body.sideEffects[0].summary).toContain("写措施的人不能自己关");
  });

  it("**CRC 关不掉** —— 验证关闭是 closeQA", async () => {
    const e = await anEvent(crc);
    const r = await crc.post(`/v1/quality-events/${e.id}:close`,
      { reason: "我已经改好了" }, idem());
    expect(r.status).toBe(403);
  });

  it("**经营层写不了措施** —— 没有 capaWrite", async () => {
    const e = await anEvent(boss);
    const r = await boss.post(`/v1/quality-events/${e.id}:capa`, {
      plan: "这条措施不该写得进去，经营层没有 capaWrite", dueOn: "2026-12-31"
    }, idem());
    expect(r.status).toBe(403);
  });

  it("**质疑不走 CAPA** —— 它有自己的闭环", async () => {
    const q = (await cra.get("/v1/quality-events?limit=100&kind=query")).body.items[0];
    const r = await cra.post(`/v1/quality-events/${q.id}:capa`, {
      plan: "给质疑挂一份整改措施是错的，它走回复与判定", dueOn: "2026-12-31"
    }, idem());
    expect(r.status).toBe(422);
    expect(r.body.invariant).toBe("capa-not-on-query");
  });

  it("整改期限不能早于问题提出日", async () => {
    const e = await anEvent(cra);
    const r = await cra.post(`/v1/quality-events/${e.id}:capa`, {
      plan: "期限填成去年，多半是填错了年份，应当被拦下来", dueOn: "2020-01-01"
    }, idem());
    expect(r.status).toBe(422);
    expect(r.body.invariant).toBe("capa-due-before-found");
  });

  it("**已指派但没写措施的，owesCapaPlan 为真**", async () => {
    const r = await qa.get("/v1/quality-events?limit=100");
    const owed = r.body.items.filter((e: any) => e.owesCapaPlan);
    expect(owed.length, "种子里三条机构质控发现只指了人、没交措施")
      .toBeGreaterThan(0);
    for (const e of owed) {
      expect(e.capaOwnerName).toBeTruthy();
      expect(e.capaPlan).toBeNull();
    }
  });
});
