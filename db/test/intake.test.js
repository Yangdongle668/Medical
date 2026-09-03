import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { owner, appConn, accountIds, asAccount } from "./helpers.js";

/* ════════════════════════════════════════════════════════════════════
   立项与建档（迁移 0037）。

   这一组钉的是**约束本身**：
     · 「已批准」而没有项目档案 —— 这条流程最容易漏的一格；
     · 「已批准」而没有批准人 —— 核查时「谁拍的板」没有答案；
     · 退回不说理由；
     · **外部方看得见我们按什么毛利率接项目** —— 下一轮就不用谈了。
   ════════════════════════════════════════════════════════════════════ */

let o;
beforeAll(async () => { o = owner(); await o.connect(); });
afterAll(async () => { await o.end(); });

const tx = async fn => {
  await o.query("BEGIN");
  try { return await fn(); } finally { await o.query("ROLLBACK"); }
};

const one = async () =>
  (await o.query(`SELECT id, code FROM intake_application LIMIT 1`)).rows[0];

describe("立项申请的形状约束", () => {
  it("**「已批准」必须有项目档案** —— 这是最容易漏的一格", async () => {
    const a = await one();
    await expect(tx(() => o.query(
      `UPDATE intake_application
          SET state = 'approved',
              decided_by = (SELECT id FROM account WHERE login = 'lingyuan'),
              decided_on = CURRENT_DATE
        WHERE id = $1`, [a.id])))
      .rejects.toThrow(/intake_approved_has_study/);
  });

  it("**反过来也不行**：没批准的不该挂着一个项目", async () => {
    const a = await one();
    await expect(tx(() => o.query(
      `UPDATE intake_application SET study_id = (SELECT id FROM study LIMIT 1)
        WHERE id = $1`, [a.id])))
      .rejects.toThrow(/intake_approved_has_study/);
  });

  it("结论与它的证据同时存在 —— 「已退回」而没有批准人不行", async () => {
    const a = await one();
    await expect(tx(() => o.query(
      `UPDATE intake_application SET state = 'returned', decision_note = '价格太低'
        WHERE id = $1`, [a.id])))
      .rejects.toThrow(/intake_decided_shape/);
  });

  it("**退回必须写理由**", async () => {
    const a = await one();
    await expect(tx(() => o.query(
      `UPDATE intake_application
          SET state = 'returned',
              decided_by = (SELECT id FROM account WHERE login = 'lingyuan'),
              decided_on = CURRENT_DATE, decision_note = '低'
        WHERE id = $1`, [a.id])))
      .rejects.toThrow(/intake_returned_needs_reason/);
  });

  it("待审批的不能带批准人 —— 「还没批但已经有人签了」说不通", async () => {
    const a = await one();
    await expect(tx(() => o.query(
      `UPDATE intake_application
          SET decided_by = (SELECT id FROM account WHERE login = 'lingyuan')
        WHERE id = $1`, [a.id])))
      .rejects.toThrow(/intake_decided_shape/);
  });
});

describe("合同中心数", () => {
  it("**每个项目都答得出合同写了几个中心**", async () => {
    const { rows } = await o.query(
      `SELECT count(*)::int AS n FROM study WHERE planned_sites IS NULL`);
    expect(rows[0].n).toBe(0);
  });

  it("种子里确实存在建档滞后 —— 那正是这一版要看见的东西", async () => {
    const { rows } = await o.query(
      `SELECT st.code, st.planned_sites,
              (SELECT count(*) FROM study_site s WHERE s.study_id = st.id) AS built
         FROM study st`);
    const gaps = rows.filter(r => r.planned_sites > Number(r.built));
    expect(gaps.length, "合同写了、系统里还没建的中心").toBeGreaterThan(0);
  });

  it("合同中心数不能是 0", async () => {
    const st = (await o.query(`SELECT id FROM study LIMIT 1`)).rows[0];
    await expect(tx(() => o.query(
      `UPDATE study SET planned_sites = 0 WHERE id = $1`, [st.id])))
      .rejects.toThrow(/study_planned_sites_positive/);
  });
});

describe("立项是我方的商务决策", () => {
  let app, ids;
  beforeAll(async () => { app = appConn(); await app.connect(); ids = await accountIds(o); });
  afterAll(async () => { await app.end(); });

  it("**机构办一条立项申请都看不到**", async () => {
    await asAccount(app, ids["zhanghm"], async () => {
      const { rows } = await app.query(
        `SELECT count(*)::int AS n FROM intake_application`);
      expect(rows[0].n, "看得到我们按什么毛利率接项目，下一轮谈判就不用谈了").toBe(0);
    });
  });

  it("经营层照旧看得到", async () => {
    await asAccount(app, ids["lingyuan"], async () => {
      const { rows } = await app.query(
        `SELECT count(*)::int AS n FROM intake_application`);
      expect(rows[0].n).toBeGreaterThanOrEqual(2);
    });
  });
});
