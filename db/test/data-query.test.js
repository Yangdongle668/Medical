import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { owner, appConn, accountIds, asAccount } from "./helpers.js";

/* ════════════════════════════════════════════════════════════════════
   数据质疑（迁移 0032）。

   这一组钉的是**约束本身**，不是服务层的判断：
     · 「已回复待关闭」而没有回复内容 —— DM 判定的是一片空白；
     · 质疑之外的事件挂上责任 CRC —— 读的人会以为偏离也走回复流程；
     · 催了几次却答不出上次是什么时候催的；
     · **外部方看得到数据质疑** —— 两条质量闭环混成一条。

   服务层挡得住的，绕过服务层（直连 SQL、将来的批量导入）挡不住。
   ════════════════════════════════════════════════════════════════════ */

let o;
beforeAll(async () => { o = owner(); await o.connect(); });
afterAll(async () => { await o.end(); });

const tx = async fn => {
  await o.query("BEGIN");
  try { return await fn(); } finally { await o.query("ROLLBACK"); }
};

/** 拿一条种子里的质疑与一条非质疑事件。 */
const pick = async kind =>
  (await o.query(
    `SELECT id, code, state FROM quality_event WHERE kind = $1 LIMIT 1`, [kind])).rows[0];

describe("数据质疑的形状约束", () => {
  it("**「已回复待关闭」必须有回复内容**", async () => {
    const q = await pick("query");
    await expect(tx(() => o.query(
      `UPDATE quality_event SET state = 'pending_review',
              answer = NULL, answered_on = NULL WHERE id = $1`, [q.id])))
      .rejects.toThrow(/quality_query_review_needs_answer/);
  });

  it("回复日期与回复内容同生共死", async () => {
    const q = await pick("query");
    await expect(tx(() => o.query(
      `UPDATE quality_event SET answered_on = CURRENT_DATE, answer = NULL
        WHERE id = $1`, [q.id])))
      .rejects.toThrow(/quality_answer_shape/);
  });

  it("**质疑专用的列不能挂到别的事件上**", async () => {
    /* 种子里只有 sae 与 query 两类（方案偏离是访视超窗时**在事务里生成**的，
       不预置）—— 用 sae 那条同样能证明这条约束。 */
    const other = await pick("sae");
    expect(other, "种子里应该有非质疑的质量事件").toBeTruthy();
    await expect(tx(() => o.query(
      `UPDATE quality_event SET form = '合并用药 CM' WHERE id = $1`, [other.id])))
      .rejects.toThrow(/quality_query_only/);
    await expect(tx(() => o.query(
      `UPDATE quality_event SET owner_account_id =
         (SELECT id FROM account WHERE login = 'wutong') WHERE id = $1`, [other.id])))
      .rejects.toThrow(/quality_query_only/);
  });

  it("每条质疑都答得出「哪张表单、哪个字段」", async () => {
    const q = await pick("query");
    await expect(tx(() => o.query(
      `UPDATE quality_event SET field_name = NULL WHERE id = $1`, [q.id])))
      .rejects.toThrow(/quality_query_needs_field/);

    const { rows } = await o.query(
      `SELECT count(*)::int AS n FROM quality_event
        WHERE kind = 'query' AND (form IS NULL OR field_name IS NULL)`);
    expect(rows[0].n, "种子里不该有拆不出表单/字段的质疑").toBe(0);
  });

  it("催办次数与上次催办的日期同生共死", async () => {
    const q = await pick("query");
    await expect(tx(() => o.query(
      `UPDATE quality_event SET chase_count = 2, last_chased_on = NULL
        WHERE id = $1`, [q.id])))
      .rejects.toThrow(/quality_chase_shape/);
  });

  it("**数据管理是一个合法的提出方** —— 此前它只能记成 cra", async () => {
    const { rows } = await o.query(
      `SELECT count(*)::int AS n FROM quality_event WHERE raised_by = 'dm'`);
    expect(rows[0].n).toBeGreaterThan(0);
  });

  it("提出方仍然是一份封闭清单", async () => {
    /* 清单本身在长（0035 补了 sponsor / site），但它必须**是一份清单** ——
       随手写一个来源进去，「同类问题总是被谁发现的」就再也分不了组。 */
    const q = await pick("query");
    await expect(tx(() => o.query(
      `UPDATE quality_event SET raised_by = 'whoever' WHERE id = $1`, [q.id])))
      .rejects.toThrow(/quality_event_raised_by_check/);
  });
});

describe("两条质量闭环不能混", () => {
  let app, ids;
  beforeAll(async () => { app = appConn(); await app.connect(); ids = await accountIds(o); });
  afterAll(async () => { await app.end(); });

  it("**机构办看不到数据质疑，但看得到本院的方案偏离**", async () => {
    await asAccount(app, ids["zhanghm"], async () => {
      const q = await app.query(
        `SELECT count(*)::int AS n FROM quality_event WHERE kind = 'query'`);
      expect(q.rows[0].n, "机构办是外部的质量反馈闭环，DM 是内部的数据质量闭环").toBe(0);

      const other = await app.query(
        `SELECT count(*)::int AS n FROM quality_event WHERE kind <> 'query'`);
      expect(other.rows[0].n, "本院的其他质量事件照旧看得到").toBeGreaterThan(0);
    });
  });

  it("研究者（外部）同样看不到", async () => {
    await asAccount(app, ids["chenguod"], async () => {
      const { rows } = await app.query(
        `SELECT count(*)::int AS n FROM quality_event WHERE kind = 'query'`);
      expect(rows[0].n).toBe(0);
    });
  });

  it("内部角色照旧看得到 —— 关掉的是外部，不是所有人", async () => {
    await asAccount(app, ids["miaoqing"], async () => {
      const { rows } = await app.query(
        `SELECT count(*)::int AS n FROM quality_event WHERE kind = 'query'`);
      expect(rows[0].n).toBeGreaterThanOrEqual(7);
    });
  });

  it("**外部方也写不进去** —— 只挡读不挡写等于没挡", async () => {
    const site = (await o.query(
      `SELECT s.id FROM study_site s WHERE s.hospital = '北京协和医院' LIMIT 1`)).rows[0];
    await app.query("BEGIN");
    try {
      await app.query("SELECT set_config('app.account_id', $1, true)", [ids["zhanghm"]]);
      await expect(app.query(
        `INSERT INTO quality_event (code, study_site_id, kind, severity, title, detail,
           form, field_name, raised_by, raised_on)
         VALUES ('Q-EXT', $1, 'query', 'minor', 'x · y', '机构办不该能提数据质疑',
                 'x', 'y', 'institution', CURRENT_DATE)`, [site.id]))
        .rejects.toThrow(/row-level security/);
    } finally { await app.query("ROLLBACK"); }
  });
});
