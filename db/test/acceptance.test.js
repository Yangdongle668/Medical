import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { owner, appConn, accountIds, asAccount } from "./helpers.js";

/* ════════════════════════════════════════════════════════════════════
   立项受理与中心文件（迁移 0038 / 0039）。

   这一组钉住三件事：

   1. **受理不对外部方关闭。** 它跟自查报告、监查排期、立项申请相反 ——
      那几张表对机构办藏起来是对的，这一张藏起来就废了一半：
      递交方要看到缺什么，受理方要出具受理通知。

   2. **受理发生在建档之前。** 所以行策略用四参数的 app.site_visible ——
      site_visible_by_id 要先有中心那一行才判得出来，而受理的时候
      那一行还不存在。种子里那两条原型受理**一条都找不到对应的中心**，
      它们正是这条路径的证据。

   3. **系统外受理的登记存根没有受理人，那是事实不是漏填。**
      台账里十五个中心的受理发生在几年前的医院里，
      多数医院的机构办根本不是本系统的用户。
      registered 的空清单要读成「没人在这儿查过」，不是「八项都齐」。
   ════════════════════════════════════════════════════════════════════ */

let o;
beforeAll(async () => { o = owner(); await o.connect(); });
afterAll(async () => { await o.end(); });

const tx = async fn => {
  await o.query("BEGIN");
  try { return await fn(); } finally { await o.query("ROLLBACK"); }
};

describe("受理的形状约束", () => {
  const inSystem = async () => (await o.query(
    `SELECT id, code FROM site_acceptance WHERE origin = 'in_system' LIMIT 1`)).rows[0];

  it("**已受理就要有受理日** —— 伦理那边问起来得答得出", async () => {
    const a = await inSystem();
    await expect(tx(() => o.query(
      `UPDATE site_acceptance SET state = 'accepted', accepted_on = NULL,
              accepted_by = (SELECT id FROM account WHERE login = 'zhanghm')
        WHERE id = $1`, [a.id])))
      .rejects.toThrow(/acceptance_accepted_shape/);
  });

  it("本系统办的受理**必须有受理人**", async () => {
    const a = await inSystem();
    await expect(tx(() => o.query(
      `UPDATE site_acceptance SET state = 'accepted', accepted_on = CURRENT_DATE,
              accepted_by = NULL WHERE id = $1`, [a.id])))
      .rejects.toThrow(/acceptance_actor_shape/);
  });

  it("**但系统外登记的可以没有** —— 受理人是医院里某个不在本系统的老师", async () => {
    const { rows } = await o.query(
      `SELECT count(*)::int AS n FROM site_acceptance
        WHERE origin = 'registered' AND accepted_by IS NULL`);
    expect(rows[0].n, "台账里的中心都早就过了立项，受理是既成事实").toBe(15);
  });

  it("登记一件没发生的事没有意义 —— registered 只能是已受理的", async () => {
    const a = (await o.query(
      `SELECT id FROM site_acceptance WHERE origin = 'registered' LIMIT 1`)).rows[0];
    await expect(tx(() => o.query(
      `UPDATE site_acceptance SET state = 'review', accepted_on = NULL,
              accepted_by = NULL WHERE id = $1`, [a.id])))
      .rejects.toThrow(/acceptance_registered_is_accepted/);
  });

  it("**发了补正通知就要说缺什么** —— 否则递交方把八份重寄一遍", async () => {
    const a = await inSystem();
    await expect(tx(() => o.query(
      `UPDATE site_acceptance SET state = 'amend', amend_note = NULL
        WHERE id = $1`, [a.id])))
      .rejects.toThrow(/acceptance_amend_needs_note/);
  });

  it("一家医院在同一个项目上只有一次受理", async () => {
    const a = (await o.query(
      `SELECT study_id, study_code, drug, sponsor_name, phase, hospital, submitted_by
         FROM site_acceptance LIMIT 1`)).rows[0];
    await expect(tx(() => o.query(
      `INSERT INTO site_acceptance (code, study_id, study_code, drug, sponsor_name,
                                    phase, hospital, submitted_by)
       VALUES ('AC-DUP-001', $1, $2, $3, $4, $5, $6, $7)`,
      [a.study_id, a.study_code, a.drug, a.sponsor_name, a.phase,
       a.hospital, a.submitted_by])))
      .rejects.toThrow(/site_acceptance_tenant_id_study_id_hospital_key|duplicate key/);
  });
});

describe("受理记录能独立于我方台账被读出来", () => {
  it("**项目那几项抄在行上，不去 join** —— 否则机构办看到的是一张空表", async () => {
    /* 受理发生在建档之前：那时候医院在我方台账里一个中心都没有，
       study 按行策略对它不可见，client 对外部方干脆整个关闭。
       内联 join 过去，这张为机构办存在的表会对机构办返回空列表。 */
    const { rows } = await o.query(
      `SELECT count(*)::int AS n FROM site_acceptance
        WHERE study_code IS NULL OR drug IS NULL
           OR sponsor_name IS NULL OR phase IS NULL`);
    expect(rows[0].n).toBe(0);
  });

  it("抄下来的项目号跟它指向的项目对得上", async () => {
    const { rows } = await o.query(
      `SELECT a.code FROM site_acceptance a
         JOIN study st ON st.id = a.study_id
        WHERE a.study_code <> st.code`);
    expect(rows.map(r => r.code)).toEqual([]);
  });
});

describe("受理发生在建档之前", () => {
  it("**原型那两条受理一条都找不到对应的中心** —— 那不是数据错了", async () => {
    const { rows } = await o.query(
      `SELECT code, hospital FROM site_acceptance
        WHERE origin = 'in_system' AND study_site_id IS NULL ORDER BY code`);
    expect(rows.length, "材料先递到医院，受理通过、伦理批下来，中心才进台账")
      .toBe(2);
    expect(rows.map(r => r.code)).toEqual(["AC-2026-038", "AC-2026-041"]);
  });

  it("既成事实的那十五条都回填了中心", async () => {
    const { rows } = await o.query(
      `SELECT count(*)::int AS n FROM site_acceptance
        WHERE origin = 'registered' AND study_site_id IS NULL`);
    expect(rows[0].n).toBe(0);
  });

  it("**受理日推得出来，不是编的**：递交 → 受理 → 伦理批件，顺序不能乱", async () => {
    const { rows } = await o.query(
      `SELECT a.code FROM site_acceptance a
         JOIN study_site s ON s.id = a.study_site_id
        WHERE a.submitted_on > a.accepted_on
           OR (s.irb_approved_on IS NOT NULL AND a.accepted_on > s.irb_approved_on)`);
    expect(rows.map(r => r.code)).toEqual([]);
  });

  it("每一个过了立项的中心都受理过 —— 否则闸门是一堵墙", async () => {
    const { rows } = await o.query(
      `SELECT s.code FROM study_site s
        WHERE s.state <> 'intake'
          AND NOT EXISTS (SELECT 1 FROM site_acceptance a
                           WHERE a.study_id = s.study_id AND a.hospital = s.hospital
                             AND a.state = 'accepted')
        ORDER BY s.code`);
    expect(rows.map(r => r.code)).toEqual([]);
  });
});

describe("中心文件只存事实，不存状态", () => {
  it("**库里没有 good/warn/crit 那一列** —— 存下来它会过期", async () => {
    const { rows } = await o.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'isf_item' AND column_name IN ('status','st','state')`);
    expect(rows.map(r => r.column_name)).toEqual([]);
  });

  it("不在的东西没有到期日 —— 缺失与过期是两种缺，不能互相顶替", async () => {
    const i = (await o.query(
      `SELECT id FROM isf_item WHERE present LIMIT 1`)).rows[0];
    await expect(tx(() => o.query(
      `UPDATE isf_item SET present = false, expires_on = '2026-12-01' WHERE id = $1`,
      [i.id]))).rejects.toThrow(/isf_missing_has_no_expiry/);
  });

  it("**只有库存没有补货线，「少到多少算少」没有答案**", async () => {
    const i = (await o.query(
      `SELECT id FROM isf_item WHERE quantity IS NULL LIMIT 1`)).rows[0];
    await expect(tx(() => o.query(
      `UPDATE isf_item SET quantity = 3 WHERE id = $1`, [i.id])))
      .rejects.toThrow(/isf_stock_shape/);
  });

  it("核对日与核对人同生共死", async () => {
    const i = (await o.query(
      `SELECT id FROM isf_item WHERE checked_on IS NOT NULL LIMIT 1`)).rows[0];
    await expect(tx(() => o.query(
      `UPDATE isf_item SET checked_by = NULL WHERE id = $1`, [i.id])))
      .rejects.toThrow(/isf_checked_shape/);
  });

  it("同一个中心同一类目下不会有两份同名文件", async () => {
    const i = (await o.query(
      `SELECT study_site_id, category, item FROM isf_item LIMIT 1`)).rows[0];
    await expect(tx(() => o.query(
      `INSERT INTO isf_item (study_site_id, category, item) VALUES ($1, $2, $3)`,
      [i.study_site_id, i.category, i.item])))
      .rejects.toThrow(/isf_item_study_site_id_category_item_key|duplicate key/);
  });
});

describe("受理与 ISF 对外部方开放，但仍按行范围收敛", () => {
  let app, ids;
  beforeAll(async () => { app = appConn(); await app.connect(); ids = await accountIds(o); });
  afterAll(async () => { await app.end(); });

  it("**机构办看得到递给自己那家医院的受理** —— 藏起来这张表就废了一半", async () => {
    await asAccount(app, ids["zhanghm"], async () => {
      const { rows } = await app.query(
        `SELECT DISTINCT hospital FROM site_acceptance ORDER BY hospital`);
      expect(rows.map(r => r.hospital)).toEqual(["北京协和医院"]);
    });
  });

  it("**包括那两条还没建档的** —— 中心那一行不存在，也判得出可见", async () => {
    await asAccount(app, ids["zhanghm"], async () => {
      const { rows } = await app.query(
        `SELECT code FROM site_acceptance WHERE study_site_id IS NULL ORDER BY code`);
      expect(rows.map(r => r.code),
        "四参数的 app.site_visible 就是为这一条存在的").toEqual(
        ["AC-2026-038", "AC-2026-041"]);
    });
  });

  it("别家医院的受理它一条都看不到", async () => {
    await asAccount(app, ids["zhanghm"], async () => {
      const { rows } = await app.query(
        `SELECT count(*)::int AS n FROM site_acceptance WHERE hospital <> '北京协和医院'`);
      expect(rows[0].n).toBe(0);
    });
  });

  it("机构办翻得到本院的研究者文件夹 —— 那摞纸本来就放在医院里", async () => {
    await asAccount(app, ids["zhanghm"], async () => {
      const { rows } = await app.query(
        `SELECT DISTINCT s.hospital FROM isf_item i
           JOIN study_site s ON s.id = i.study_site_id`);
      expect(rows.map(r => r.hospital)).toEqual(["北京协和医院"]);
    });
  });

  it("**开放不等于全看得见** —— 没派到那两个中心的 CRA 一条都翻不到", async () => {
    /* 种子里的 ISF 只落在 SS-01 与 SS-07 上，两个都派给了林敏与吴桐。
       段之屿带的是 SS-04 / SS-05 —— 他看不到，正说明这张表照样按行收敛，
       "不对外部方关闭"关的是**角色**那一维，不是行那一维。 */
    const mine = await asAccount(app, ids["linmin"], async () =>
      (await app.query(`SELECT count(*)::int AS n FROM isf_item`)).rows[0].n);
    const other = await asAccount(app, ids["duanzhiyu"], async () =>
      (await app.query(`SELECT count(*)::int AS n FROM isf_item`)).rows[0].n);
    const all = (await o.query(`SELECT count(*)::int AS n FROM isf_item`)).rows[0].n;
    expect(mine).toBe(all);
    expect(other).toBe(0);
  });
});
