import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { boot, resetDb, as, type Caller } from "./harness.js";

const idem = () => ({ "Idempotency-Key": randomUUID() });

/* ════════════════════════════════════════════════════════════════════
   数据质疑：闭环的两端。

   原型自己写着：QUERIES 里 by:"数据管理" 出现了 5 次，
   但系统里没有这个角色 —— 质疑凭空产生、凭空关闭。

   这一组盯的就是那两端：
     · 发起时没有责任 CRC —— 无人认领的质疑等于没提；
     · 中心回复了就自动关闭 —— 回复了不等于问题解决了；
     · CRC 自己能关掉指派给自己的质疑 —— 那这套流程一分钱不值；
     · 退回不说理由 —— 把「凭空」的毛病搬到了另一端。
   ════════════════════════════════════════════════════════════════════ */

let app: INestApplication;
let dm: Caller, crc: Caller, cra: Caller, qa: Caller, boss: Caller, inst: Caller;

beforeAll(async () => {
  resetDb(); app = await boot();
  dm   = await as(app, "miaoqing");    // 数据管理
  crc  = await as(app, "wutong");      // 吴桐：种子里 5 条质疑的责任 CRC
  cra  = await as(app, "linmin");      // 监查员
  qa   = await as(app, "weilan");      // 质量保证
  boss = await as(app, "lingyuan");
  inst = await as(app, "zhanghm");     // 机构办（外部）
}, 180_000);
afterAll(async () => { await app?.close(); });

const list = async (c: Caller, qs = "") =>
  (await c.get(`/v1/data-queries?limit=100${qs}`)).body.items as any[];

describe("质疑台账", () => {
  it("DM 看得到全部；每一条都答得出「谁提的、谁负责」", async () => {
    const items = await list(dm);
    expect(items.length).toBeGreaterThanOrEqual(7);
    for (const q of items) {
      expect(q.raisedByName, `${q.code} 提出人`).toBeTruthy();
      expect(q.ownerName, `${q.code} 责任 CRC`).toBeTruthy();
      expect(q.form).toBeTruthy();
      expect(q.fieldName).toBeTruthy();
    }
  });

  it("**数据管理提的记成 dm** —— 此前只能记成 cra", async () => {
    const items = await list(dm);
    const byDm = items.filter(q => q.raisedBy === "dm");
    expect(byDm.length, "原型里 by:'数据管理' 有 5 条").toBe(5);
    expect(byDm[0].raisedByName).toBe("苗青");
  });

  it("**挂得最久的排最前** —— 不按提出日倒序", async () => {
    const items = await list(dm);
    const ages = items.map(q => q.ageDays);
    expect([...ages].sort((a, b) => b - a)).toEqual(ages);
    expect(ages[0]).toBeGreaterThan(ages.at(-1)!);
  });

  it("超 7 天只筛「待中心回复」的 —— 待关闭的不算中心不回复", async () => {
    const stale = await list(dm, "&staleOnly=true");
    expect(stale.length).toBeGreaterThan(0);
    for (const q of stale) {
      expect(q.state).toBe("open");
      expect(q.ageDays).toBeGreaterThan(7);
      expect(q.stale).toBe(true);
    }
    /* 种子里 Q-1165 已回复、挂了 12 天 —— 它不该出现在这一栏 */
    expect(stale.some(q => q.code === "Q-1165")).toBe(false);
  });

  it("CRC 的 mine 只给指派给自己的", async () => {
    const mine = await list(crc, "&mine=true");
    expect(mine.length).toBeGreaterThan(0);
    for (const q of mine) expect(q.ownerName).toBe("吴桐");
  });

  it("外部方（机构办）一条都看不到 —— 数据质疑是内部的数据质量闭环", async () => {
    expect(await list(inst)).toHaveLength(0);
  });

  it("筛选号受 subject 列权限管辖", async () => {
    const one = (await list(dm))[0];
    expect(one.screeningNo, "DM 有 subject 列权限").toBeTruthy();
    const noField = (await list(boss)).find(q => q.subjectId !== null);
    if (noField) expect("screeningNo" in noField, "经营层没有 subject 列权限").toBe(false);
  });
});

describe("负荷统计", () => {
  it("**未关闭的也算进平均挂起** —— 否则不关就能把数做好看", async () => {
    const s = (await dm.get("/v1/data-queries/stats")).body;
    expect(s.load.closed).toBe(0);            // 种子里一条都没关
    expect(s.load.meanAgeDays).toBeGreaterThan(0);
    /* 只算已关闭的话，分母是 0，这个数会是 null 或者干脆不存在 ——
       而底下正压着一条挂了 21 天没人管的。 */
    expect(s.load.worstAgeDays).toBeGreaterThanOrEqual(21);
    expect(s.load.meetsTarget).toBe(false);
  });

  it("每中心给密度**和集中度** —— 只给密度那句免责声明就没有用", async () => {
    const s = (await dm.get("/v1/data-queries/stats")).body;
    expect(s.sites.length).toBeGreaterThan(0);
    for (const site of s.sites) {
      expect(site.hospital).toBeTruthy();
      expect(["too-few", "form", "entry"]).toContain(site.verdict);
      if (site.perSubject !== null) expect(site.band).not.toBeNull();
    }
  });

  it("**入组 0 例的中心密度是 null，且排在最后** —— 不是最干净的那一端", async () => {
    const s = (await dm.get("/v1/data-queries/stats")).body;
    const noEnroll = s.sites.filter((x: any) => x.perSubject === null);
    if (noEnroll.length) {
      const firstNull = s.sites.findIndex((x: any) => x.perSubject === null);
      const after = s.sites.slice(firstNull);
      expect(after.every((x: any) => x.perSubject === null),
        "算不出密度的必须全在末尾").toBe(true);
      for (const x of noEnroll) expect(x.band).toBeNull();
    }
  });

  it("统计不分页 —— 「第一页的平均」不是平均", async () => {
    const s = (await dm.get("/v1/data-queries/stats")).body;
    const all = await list(dm);
    expect(s.load.total).toBe(all.length);
    expect(s.calcVersion).toBeTruthy();
  });
});

describe("发起", () => {
  const subjectOf = async () => {
    const r = await dm.get("/v1/subjects?limit=100&state=enrolled");
    return r.body.items[0];
  };

  it("**CRC 不能发起** —— 没有 raiseQ 动作权限", async () => {
    const su = await subjectOf();
    const r = await crc.post("/v1/data-queries", {
      subjectId: su.id, form: "合并用药 CM", fieldName: "起始日期",
      detail: "CM 起始日期早于知情同意签署日期，请核实源数据。"
    }, idem());
    expect(r.status).toBe(403);
  });

  it("CRA 能发起 —— **SDV 的产出恰恰就是质疑**", async () => {
    const su = await subjectOf();
    const r = await cra.post("/v1/data-queries", {
      subjectId: su.id, form: "实验室检查 LB", fieldName: "中性粒细胞计数",
      detail: "C2D1 中性粒细胞已达 3 级，但未见对应 AE 记录，请确认是否漏报。"
    }, idem());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.raisedBy).toBe("cra");
    expect(r.body.data.raisedByName).toBe("林敏");
    expect(r.body.data.state).toBe("open");
    /* 责任 CRC 从受试者取，并在这一刻固化 */
    expect(r.body.data.ownerAccountId).toBeTruthy();
    expect(r.body.sideEffects[0].summary).toContain("指派给");
  });

  it("质疑内容太短会被拒 —— 中心答不了", async () => {
    const su = await subjectOf();
    const r = await dm.post("/v1/data-queries", {
      subjectId: su.id, form: "不良事件 AE", fieldName: "开始日期", detail: "错了"
    }, idem());
    expect(r.status).toBe(422);
  });

  it("**受试者没有责任 CRC 就不给建** —— 无人认领的质疑等于没提", async () => {
    const db = new (await import("pg")).default.Client(
      { connectionString: process.env["TEST_DATABASE_URL"] });
    await db.connect();
    const { rows } = await db.query(
      `SELECT id FROM subject WHERE crc_account_id IS NULL LIMIT 1`);
    let orphan = rows[0]?.id as string | undefined;
    if (!orphan) {
      const any = await db.query(`SELECT id FROM subject LIMIT 1`);
      orphan = any.rows[0].id;
      await db.query(`UPDATE subject SET crc_account_id = NULL WHERE id = $1`, [orphan]);
    }
    await db.end();

    const r = await dm.post("/v1/data-queries", {
      subjectId: orphan, form: "生命体征 VS", fieldName: "收缩压",
      detail: "收缩压 210 mmHg 超出合理区间，疑为录入错误，请核实。"
    }, idem());
    expect(r.status).toBe(422);
    expect(r.body.invariant).toBe("query-needs-owner");
  });
});

describe("回复 → 判定：中间那一格就是全部意义", () => {
  const openOne = async () => (await list(crc, "&mine=true&state=open"))[0];

  it("**CRC 回复后是「待关闭」，不是「已关闭」**", async () => {
    const q = await openOne();
    const r = await crc.post(`/v1/data-queries/${q.id}:answer`, {
      answer: "已核对原始病历，CM 起始日期录入错误，已更正为 2026-08-03，源文件第 12 页。"
    }, idem());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.state).toBe("pending_review");
    expect(r.body.data.answeredOn).toBeTruthy();
    expect(r.body.sideEffects[0].summary).toContain("不等于关闭了");
  });

  it("回复太短会被拒 —— 只写「已修正」DM 判定不了", async () => {
    const q = await openOne();
    const r = await crc.post(`/v1/data-queries/${q.id}:answer`, { answer: "已修正" }, idem());
    expect(r.status).toBe(422);
  });

  it("**CRC 关不掉自己回复的质疑** —— 没有 closeQ", async () => {
    const q = (await list(crc, "&mine=true&state=pending_review"))[0];
    expect(q, "上一条用例应该留下一条待关闭的").toBeTruthy();
    const r = await crc.post(`/v1/data-queries/${q.id}:close`,
      { reason: "我已经改好了" }, idem());
    expect(r.status).toBe(403);
  });

  it("**QA 也关不掉** —— closeQA 管的是质量事件，两条线不能混", async () => {
    const q = (await list(dm, "&state=pending_review"))[0];
    const r = await qa.post(`/v1/data-queries/${q.id}:close`,
      { reason: "回复合格" }, idem());
    expect(r.status).toBe(403);
  });

  it("**没有回复的关不掉** —— 那只是把问题从列表上抹掉", async () => {
    const q = (await list(dm, "&state=open"))[0];
    const r = await dm.post(`/v1/data-queries/${q.id}:close`,
      { reason: "先关了再说" }, idem());
    expect(r.status).toBe(422);
    expect(r.body.invariant).toBe("query-close-needs-answer");
  });

  it("DM 退回，状态回到待回复，**且理由留在行上**", async () => {
    const q = (await list(dm, "&state=pending_review"))[0];
    const r = await dm.post(`/v1/data-queries/${q.id}:return`,
      { reason: "回复未提供源数据依据，请附原始病历页码" }, idem());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.state).toBe("open");
    expect(r.body.data.returnedReason).toContain("源数据依据");
    /* 回复内容保留 —— 退回不是"当他没答过" */
    expect(r.body.data.answer).toBeTruthy();
  });

  it("DM 关闭：状态到 closed 并记下共挂了多少天", async () => {
    const q = (await list(crc, "&mine=true&state=open"))[0];
    await crc.post(`/v1/data-queries/${q.id}:answer`, {
      answer: "已附原始病历第 12 页扫描件，源数据与更正后的 eCRF 一致。"
    }, idem());
    const r = await dm.post(`/v1/data-queries/${q.id}:close`,
      { reason: "回复合格，已核对源数据" }, idem());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.state).toBe("closed");
    expect(r.body.data.resolution).toContain("回复合格");
    expect(r.body.sideEffects[0].summary).toContain("共挂起");

    const again = await dm.post(`/v1/data-queries/${q.id}:close`,
      { reason: "再关一次" }, idem());
    expect(again.status).toBe(422);
    expect(again.body.invariant).toBe("query-already-closed");
  });
});

describe("催办", () => {
  it("**催办要落库** —— 「我们催过了」没有记录等于没发生", async () => {
    const q = (await list(dm, "&staleOnly=true"))[0];
    expect(q.chaseCount).toBe(0);
    const r = await dm.post(`/v1/data-queries/${q.id}:chase`,
      { reason: "电话联系吴桐，承诺本周五前回复" }, idem());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.chaseCount).toBe(1);
    expect(r.body.data.lastChasedOn).toBeTruthy();
  });

  it("催到第三次要提醒升级，而不是再打一个电话", async () => {
    const q = (await list(dm, "&staleOnly=true"))[0];
    await dm.post(`/v1/data-queries/${q.id}:chase`, { reason: "第二次电话催办" }, idem());
    const r = await dm.post(`/v1/data-queries/${q.id}:chase`,
      { reason: "第三次电话催办" }, idem());
    expect(r.body.data.chaseCount).toBeGreaterThanOrEqual(3);
    expect(r.body.sideEffects[0].summary).toContain("升级到 PM");
  });

  it("**不在「待中心回复」的催不了** —— 球不在中心那边", async () => {
    const q = (await list(dm, "&state=closed"))[0];
    expect(q, "上一组用例应该关掉过一条").toBeTruthy();
    const r = await dm.post(`/v1/data-queries/${q.id}:chase`,
      { reason: "再催一次看看" }, idem());
    expect(r.status).toBe(422);
    expect(r.body.invariant).toBe("query-chase-open-only");
  });
});
