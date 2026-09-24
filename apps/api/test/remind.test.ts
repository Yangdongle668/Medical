import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { boot, resetDb, as, type Caller } from "./harness.js";
import { planReminders, localParts, RemindService } from "../src/modules/workbench/remind.service.js";
import { LoginDelivery } from "../src/infra/login-delivery.js";

/* ════════════════════════════════════════════════════════════════════
   邮件提醒。先钉那条纯函数（什么时候发什么），再跑真的一轮：
   发给对的人、同一件事同一个档只发一次、退订了就不发、正文里没有筛选号。
   ════════════════════════════════════════════════════════════════════ */

const H = 3_600_000;
type Item = Parameters<typeof planReminders>[0][number];
const item = (x: Partial<Item>): Item => ({
  kind: "visit", urgency: "soon", dueOn: null, dueAt: null, title: "t", detail: "d",
  studySiteId: null, siteCode: null, ref: { type: "subject_visit", id: randomUUID() }, ...x
} as Item);
const OPTS = { tz: "Asia/Shanghai", digestHour: 8 };

describe("planReminders", () => {
  const now = new Date("2026-09-28T01:00:00Z");        // 周一，北京 09:00

  it("SAE 三个档：还剩 12 小时、还剩 4 小时、已过 24 小时；更早不发", () => {
    const sae = (leftH: number) => item({ kind: "sae", dueAt: new Date(now.getTime() + leftH * H).toISOString() });
    const marks = (leftH: number) => planReminders([sae(leftH)], now, OPTS).urgent.map(u => u.mark);
    expect(marks(20)).toEqual([]);
    expect(marks(11)).toEqual(["12h"]);
    expect(marks(3)).toEqual(["20h"]);
    expect(marks(-1)).toEqual(["24h"]);
  });

  it("今天关窗的访视当天发一次，档就是本地日期", () => {
    const p = planReminders([item({ urgency: "today" }), item({ urgency: "soon" })], now, OPTS);
    expect(p.urgent.map(u => u.mark)).toEqual(["2026-09-28"]);
  });

  it("摘要：工作日、本地过了 8 点、有待办才发", () => {
    const one = [item({})];
    expect(planReminders(one, now, OPTS).digest).toBe("2026-09-28");
    expect(planReminders([], now, OPTS).digest).toBeNull();
    expect(planReminders(one, new Date("2026-09-27T23:00:00Z"), OPTS).digest, "北京 07:00").toBeNull();
    expect(planReminders(one, new Date("2026-09-27T01:00:00Z"), OPTS).digest, "周日").toBeNull();
  });

  it("日期按本地算：北京周一 07:59 仍是周一，UTC 那边还是周日", () => {
    expect(localParts(new Date("2026-09-27T23:59:00Z"), "Asia/Shanghai"))
      .toEqual({ date: "2026-09-28", hour: 7, weekday: 1 });
  });
});

let app: INestApplication;
let crc: Caller;
const K = () => ({ "Idempotency-Key": randomUUID() });

/* 这一组的时刻都按北京时间写（周一 09:00 = UTC 01:00）；测试默认把业务时区钉成 UTC，这里换回来 */
const savedTz = process.env["SITEDESK_TZ"];
beforeAll(async () => {
  process.env["SITEDESK_TZ"] = "Asia/Shanghai";
  resetDb(); app = await boot();
  crc = await as(app, "wutong");
}, 180_000);
afterAll(async () => { await app?.close(); if (savedTz === undefined) delete process.env["SITEDESK_TZ"]; else process.env["SITEDESK_TZ"] = savedTz; });

/** 跑一轮，收下这一轮发出去的邮件（按收件地址分）。 */
async function round(now: Date) {
  const spy = vi.spyOn(LoginDelivery.prototype, "notify").mockResolvedValue("sent");
  try {
    await app.get(RemindService).tick(now);
    return spy.mock.calls.map(c => c[0]);
  } finally { spy.mockRestore(); }
}

const WUTONG = "wutong@hengji.example";     // SS-01 的 CRC
const LINMIN = "linmin@hengji.example";     // 监查员

describe("跑一轮", () => {
  const monday9 = new Date("2026-09-28T01:00:00Z");

  it("知悉 14 小时还没上报的 SAE：CRC 收到紧急提醒；再跑不重复；到下一档再发", async () => {
    const site = (await crc.get("/v1/study-sites?limit=200&q=SS-01")).body.items
      .find((s: { code: string }) => s.code === "SS-01");
    const now = new Date();
    const r = await crc.post(`/v1/study-sites/${site.id}/sae`, {
      title: "提醒测试 SAE", detail: "受试者住院，研究者次日知悉",
      occurredAt: new Date(now.getTime() - 14 * H).toISOString() }, K());
    expect(r.status).toBe(201);
    /* 只看紧急那一类 —— 真实时钟下这一轮可能恰好也发了当天的摘要，摘要里同样列着它 */
    const about = (ms: { to: string; subject: string; text: string }[], to: string) =>
      ms.filter(m => m.to === to && m.subject.startsWith("【紧急】") && m.text.includes("提醒测试 SAE"));

    const first = await round(now);
    const mine = about(first, WUTONG);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.subject).toMatch(/^【紧急】/);

    expect(about(await round(new Date(now.getTime() + 60_000)), WUTONG), "同一档发了两遍").toEqual([]);

    /* 九小时后只剩一小时 → 20h 档 */
    expect(about(await round(new Date(now.getTime() + 9 * H)), WUTONG)).toHaveLength(1);
  });

  it("监查员不上报，但跟进的 SAE 也在他的紧急提醒里", async () => {
    const sae = (await crc.get("/v1/me/inbox")).body.items
      .find((i: { kind: string; title: string }) => i.kind === "sae" && i.title.includes("提醒测试 SAE"));
    expect(sae).toBeDefined();
    /* 上一条已经把当前档用掉了；换一个更晚的时刻（已过 24 小时）看 CRA 那一边 */
    const later = new Date(Date.parse(sae.dueAt) + H);
    const got = (await round(later)).filter(m => m.to === LINMIN
      && m.subject.startsWith("【紧急】") && m.text.includes("提醒测试 SAE"));
    expect(got.length).toBeGreaterThanOrEqual(1);
    expect(got[0]!.text).toContain("由中心上报");
  });

  it("每日摘要：工作日早上一封，同一天不再发；正文里没有筛选号", async () => {
    const d1 = (await round(monday9)).filter(m => m.subject.startsWith("今天的待办"));
    expect(d1.some(m => m.to === WUTONG)).toBe(true);
    for (const m of d1) {
      expect(m.text).toContain("/today");
      expect(m.text, "筛选号跟着邮件出了系统").not.toMatch(/\bS-\d{4}\b|\bSS-\d{2}-P\d{3}\b/);
    }
    const d2 = (await round(new Date(monday9.getTime() + 2 * H))).filter(m => m.subject.startsWith("今天的待办"));
    expect(d2).toEqual([]);
  });

  it("关了摘要就不发摘要，紧急的照发；偏好只是自己的", async () => {
    const p = await crc.patch("/v1/me/notify-prefs", { digest: false, urgent: true }, K());
    expect(p.status).toBe(200);
    expect(p.body).toEqual({ digest: false, urgent: true, hasEmail: true });

    const tuesday9 = new Date(monday9.getTime() + 24 * H);
    const got = (await round(tuesday9)).filter(m => m.subject.startsWith("今天的待办"));
    expect(got.some(m => m.to === WUTONG), "关了摘要还在发").toBe(false);
    expect(got.some(m => m.to === LINMIN), "别人的摘要不该跟着关").toBe(true);

    /* 别人看不到、也改不了他的偏好：换个人读到的是自己那一行（没有 = 全开） */
    const cra = await as(app, "linmin");
    expect((await cra.get("/v1/me/notify-prefs")).body).toMatchObject({ digest: true, urgent: true });
  });
});
