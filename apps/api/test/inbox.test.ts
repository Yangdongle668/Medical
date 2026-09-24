import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { boot, resetDb, as, type Caller } from "./harness.js";
import { randomUUID } from "node:crypto";

/* ════════════════════════════════════════════════════════════════════
   我的待办（GET /v1/me/inbox）。

   它直接调各模块的 service，**绕过了控制器上的动作守卫与出口前的每一道
   单独检查**，所以这里要钉的首先是"它没有比源头给得更多"：
     · 行范围：CRC 待办里的访视，全都在他自己的访视清单里；
     · 动作：没有 subjRead 的角色，受试者类整类不出现；
     · 列：没有受试者列权限的角色，拿不到筛选号。
   然后才是"它给得对"：排序、SAE 时钟、合成的审批条目。
   ════════════════════════════════════════════════════════════════════ */

let app: INestApplication;
let boss: Caller, crc: Caller, qa: Caller, cra: Caller;
const K = () => ({ "Idempotency-Key": randomUUID() });
const RANK = { overdue: 0, today: 1, soon: 2 } as const;

interface Item {
  kind: string; urgency: keyof typeof RANK; title: string; detail: string;
  dueOn: string | null; dueAt: string | null; siteCode: string | null;
  screeningNo?: string; ref: { type: string; id: string | null };
}

beforeAll(async () => {
  resetDb(); app = await boot();
  boss = await as(app, "lingyuan");
  crc  = await as(app, "wutong");
  qa   = await as(app, "weilan");
  cra  = await as(app, "linmin");
}, 180_000);
afterAll(async () => { await app?.close(); });

const inbox = async (c: Caller) => {
  const r = await c.get("/v1/me/inbox");
  expect(r.status).toBe(200);
  return r.body as {
    items: Item[]; counts: { overdue: number; today: number; soon: number };
    truncatedKinds: string[];
  };
};

describe("我的待办 · 没有比源头给得更多", () => {
  it("CRC 待办里的访视，全都在他自己的访视清单里（行范围）", async () => {
    const b = await inbox(crc);
    const visits = b.items.filter(i => i.kind === "visit");
    expect(visits.length, "种子里 CRC 应当有未完成的访视").toBeGreaterThan(0);
    const own = (await crc.get("/v1/subject-visits?status=planned&limit=200")).body.items
      .map((v: { id: string }) => v.id);
    for (const v of visits) expect(own).toContain(v.ref.id);
  });

  it("QA 没有 subjRead：访视、PI 签字、EDC 三类整类不出现，而不是 403", async () => {
    const b = await inbox(qa);
    expect(b.items.filter(i => ["visit", "pi_confirm", "edc"].includes(i.kind))).toEqual([]);
  });

  it("筛选号只走受列权限管辖的那个字段 —— 标题里不写它", async () => {
    const b = await inbox(crc);
    const withNo = b.items.filter(i => i.screeningNo);
    expect(withNo.length, "CRC 有这一列，应当看得到").toBeGreaterThan(0);
    for (const i of b.items) for (const n of withNo)
      expect(`${i.title} ${i.detail}`, "筛选号写进了标题，列权限就被绕过去了")
        .not.toContain(n.screeningNo!);
    /* 经营层没有 `subject` 这一列：整个响应里一个筛选号都不该有 */
    for (const i of (await inbox(boss)).items) expect(i).not.toHaveProperty("screeningNo");
  });

  it("只给办得了的：CRA 没有 subjWrite —— 不出现 CRC 该完成的访视与 EDC，但有 PI 签字登记", async () => {
    const b = await inbox(cra);
    expect(b.items.filter(i => ["visit", "edc", "sae"].includes(i.kind))).toEqual([]);
    const pending = (await cra.get("/v1/subject-visits?pendingPi=true&limit=5")).body.items;
    if (pending.length) expect(b.items.some(i => i.kind === "pi_confirm")).toBe(true);
  });
});

describe("我的待办 · 给得对", () => {
  it("按紧急程度排：已过期 → 今天 → 这几天（SAE 另外提到最前）；计数与条目一致", async () => {
    const b = await inbox(crc);
    const ranks = b.items.filter(i => i.kind !== "sae").map(i => RANK[i.urgency]);
    expect(ranks).toEqual([...ranks].sort((x, y) => x - y));
    expect(b.counts.overdue + b.counts.today + b.counts.soon).toBe(b.items.length);
  });

  it("超窗的访视是「已过期」，与访视清单的 outOfWindow 同一个口径", async () => {
    const b = await inbox(crc);
    const late = (await crc.get("/v1/subject-visits?status=planned&outOfWindow=true&limit=200"))
      .body.items.map((v: { id: string }) => v.id);
    for (const v of b.items.filter(i => i.kind === "visit"))
      expect(v.urgency === "overdue", `${v.title}`).toBe(late.includes(v.ref.id));
  });

  it("SAE 知悉 30 小时还没上报：排在最前，标「已过期」", async () => {
    const site = (await crc.get("/v1/study-sites?limit=200&q=SS-01")).body.items
      .find((s: { code: string }) => s.code === "SS-01");
    const occurredAt = new Date(Date.now() - 30 * 3_600_000).toISOString();
    const r = await crc.post(`/v1/study-sites/${site.id}/sae`,
      { title: "待办测试 SAE", detail: "受试者住院，研究者判定与药物可能相关", occurredAt }, K());
    expect(r.status).toBe(201);

    const b = await inbox(crc);
    const sae = b.items.find(i => i.kind === "sae" && i.ref.id === r.body.id);
    expect(sae).toBeDefined();
    expect(sae!.urgency).toBe("overdue");
    expect(Date.parse(sae!.dueAt!)).toBe(Date.parse(occurredAt) + 24 * 3_600_000);
    /* 按日期排的话，一个月前超窗的访视会压在它上面 —— SAE 按小时走，必须第一条 */
    const firstNonSae = b.items.findIndex(i => i.kind !== "sae");
    const lastSae = b.items.map(i => i.kind).lastIndexOf("sae");
    expect(lastSae, "SAE 应当排在所有别的待办前面").toBeLessThan(firstNonSae);

    /* 补上报时刻之后，它就不是待办了 */
    const done = await crc.post(`/v1/quality-events/${r.body.id}:sae-reported`,
      { reportedAt: new Date().toISOString() }, K());
    expect(done.status).toBe(201);
    expect((await inbox(crc)).items.some(i => i.ref.id === r.body.id)).toBe(false);
  });

  it("待审工时合成一条，自己填的不算；没有 approve 的角色没有这一条", async () => {
    const bossId = (await boss.get("/v1/me")).body.account.id;
    const b = await inbox(boss);
    const others = (await boss.get("/v1/timesheets?unapprovedOnly=true&limit=200")).body.items
      .filter((t: { accountId: string }) => t.accountId !== bossId);
    const a = b.items.filter(i => i.kind === "approval");
    expect(a.length).toBe(others.length ? 1 : 0);
    if (others.length) expect(a[0]!.title).toContain(`${others.length}`);
    expect((await inbox(crc)).items.some(i => i.kind === "approval")).toBe(false);
  });

  it("每类至多 20 条", async () => {
    const b = await inbox(boss);
    const per = new Map<string, number>();
    for (const i of b.items) per.set(i.kind, (per.get(i.kind) ?? 0) + 1);
    for (const [k, n] of per) expect(n, k).toBeLessThanOrEqual(20);
  });
});
