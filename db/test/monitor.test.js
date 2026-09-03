import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { owner, appConn, accountIds, asAccount } from "./helpers.js";

/* ════════════════════════════════════════════════════════════════════
   监查访视（迁移 0033 / 0034）。

   这一组钉的是**约束本身**，不是服务层的判断：
     · 「已排期」而没有确认日期 —— 什么时候跟中心敲定的没有答案；
     · 报告日期早于现场日期 —— 报告滞后会算出负数，把均值拉好看；
     · 勾了跟进项却不知道是谁勾的；
     · **外部方看得见我们的监查计划** —— 监查策略交给了被监查的一方。
   ════════════════════════════════════════════════════════════════════ */

let o;
beforeAll(async () => { o = owner(); await o.connect(); });
afterAll(async () => { await o.end(); });

const tx = async fn => {
  await o.query("BEGIN");
  try { return await fn(); } finally { await o.query("ROLLBACK"); }
};

const pick = async (state = "reported") =>
  (await o.query(
    `SELECT id, code, performed_on FROM monitor_visit WHERE state = $1 LIMIT 1`,
    [state])).rows[0];

describe("监查访视的形状约束", () => {
  it("**「已排期」必须有确认日期** —— 否则改期扯皮时拿不出那个日子", async () => {
    const v = await pick();
    await expect(tx(() => o.query(
      `UPDATE monitor_visit SET state = 'scheduled', confirmed_on = NULL,
              report_submitted_on = NULL WHERE id = $1`, [v.id])))
      .rejects.toThrow(/monitor_scheduled_needs_confirm/);
  });

  it("「报告已提交」与提交日期同生共死", async () => {
    const v = await pick();
    await expect(tx(() => o.query(
      `UPDATE monitor_visit SET report_submitted_on = NULL WHERE id = $1`, [v.id])))
      .rejects.toThrow(/monitor_reported_needs_date/);
  });

  it("**报告不可能早于现场** —— 日期倒挂会把报告滞后算成负数", async () => {
    const v = await pick();
    await expect(tx(() => o.query(
      `UPDATE monitor_visit SET report_submitted_on = performed_on - 1
        WHERE id = $1`, [v.id])))
      .rejects.toThrow(/monitor_report_after_visit/);
  });

  it("一次 0 天的监查在成本口径上等于没去过", async () => {
    const v = await pick();
    await expect(tx(() => o.query(
      `UPDATE monitor_visit SET days = 0 WHERE id = $1`, [v.id])))
      .rejects.toThrow(/monitor_visit_days_check|violates check constraint/);
  });

  it("勾了跟进项就要知道是谁勾的", async () => {
    const it0 = (await o.query(
      `SELECT visit_id, seq FROM monitor_visit_item WHERE done_at IS NOT NULL LIMIT 1`
    )).rows[0];
    expect(it0, "种子里应该有勾掉的跟进项").toBeTruthy();
    await expect(tx(() => o.query(
      `UPDATE monitor_visit_item SET done_by = NULL
        WHERE visit_id = $1 AND seq = $2`, [it0.visit_id, it0.seq])))
      .rejects.toThrow(/monitor_item_done_needs_actor/);
  });

  it("**未启动的中心不该有监查记录** —— 种子的一条自洽性", async () => {
    const { rows } = await o.query(
      `SELECT s.code FROM study_site s
        WHERE s.state IN ('intake','irb_submit','irb_approve','contract')
          AND EXISTS (SELECT 1 FROM monitor_visit v
                       WHERE v.study_site_id = s.id AND v.performed_on IS NOT NULL)`);
    expect(rows.map(r => r.code), "还没启动却已经「去过」的中心").toEqual([]);
  });
});

describe("监查策略不能交给被监查的一方", () => {
  let app, ids;
  beforeAll(async () => { app = appConn(); await app.connect(); ids = await accountIds(o); });
  afterAll(async () => { await app.end(); });

  it("**机构办一条排期都看不到**", async () => {
    await asAccount(app, ids["zhanghm"], async () => {
      const { rows } = await app.query(`SELECT count(*)::int AS n FROM monitor_visit`);
      expect(rows[0].n, "看得到我们打算什么时候去、抽多少比例，等于把策略交出去").toBe(0);
    });
  });

  it("研究者（外部）同样看不到", async () => {
    await asAccount(app, ids["chenguod"], async () => {
      const { rows } = await app.query(`SELECT count(*)::int AS n FROM monitor_visit`);
      expect(rows[0].n).toBe(0);
    });
  });

  it("跟进项跟着访视走 —— 外部方也看不到", async () => {
    await asAccount(app, ids["zhanghm"], async () => {
      const { rows } = await app.query(`SELECT count(*)::int AS n FROM monitor_visit_item`);
      expect(rows[0].n).toBe(0);
    });
  });

  it("内部角色照旧看得到", async () => {
    await asAccount(app, ids["linmin"], async () => {
      const { rows } = await app.query(`SELECT count(*)::int AS n FROM monitor_visit`);
      expect(rows[0].n).toBeGreaterThan(0);
    });
  });
});

describe("monitor 动作权限", () => {
  it("**三处清单一致**：action_key 表里有它", async () => {
    const { rows } = await o.query(
      `SELECT label FROM action_key WHERE code = 'monitor'`);
    expect(rows[0]?.label).toContain("监查");
  });

  it("给了 CRA / PM / 管理员，没给 CRC 与 QA", async () => {
    const { rows } = await o.query(
      `SELECT r.code, ra.allowed FROM role r
         JOIN role_action ra ON ra.role_id = r.id AND ra.action_key = 'monitor'
        ORDER BY r.code`);
    const on = rows.filter(r => r.allowed).map(r => r.code).sort();
    expect(on).toEqual(["admin", "cra", "pm"]);
    /* CRC 有 timeWrite —— 借那个动作来用的话，CRC 就能给自己排监查。 */
    expect(rows.find(r => r.code === "crc").allowed).toBe(false);
    expect(rows.find(r => r.code === "qa").allowed).toBe(false);
  });
});
