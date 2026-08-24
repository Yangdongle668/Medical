import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { owner } from "./helpers.js";

let o;
beforeAll(async () => { o = owner(); await o.connect(); });
afterAll(async () => { await o.end(); });

const tx = async fn => {
  await o.query("BEGIN");
  try { return await fn(); } finally { await o.query("ROLLBACK"); }
};

describe("约束不是文档，是数据库拒绝写入", () => {
  it("row_rule=hospital 的账号缺 org_ref 会被拒 —— 否则他能登录却一行都看不到，且没有报错", () =>
    tx(async () => {
      await expect(o.query(`
        INSERT INTO account (login, display_name, role_id, is_external, org_ref)
        VALUES ('newinst','某机构老师',(SELECT id FROM role WHERE code='inst'),true,NULL)`))
        .rejects.toThrow(/必须填写 org_ref/);
    }));

  it("PI 不受该约束 —— 他按 pi 规则切行，与所属机构无关", () =>
    tx(async () => {
      const { rows } = await o.query(`
        INSERT INTO account (login, display_name, role_id, is_external, org_ref)
        VALUES ('newpi','某研究者',(SELECT id FROM role WHERE code='pi'),true,NULL) RETURNING id`);
      expect(rows[0].id).toBeTruthy();
    }));

  it("停用账号必须写原因", () =>
    tx(async () => {
      await expect(o.query(
        `UPDATE account SET status='disabled', disabled_at=now() WHERE login='tangyan'`))
        .rejects.toThrow(/account_disabled_needs_reason/);
    }));

  it("同一人对同一中心的派工区间不得重叠 —— 否则「他何时开始负责」没有答案", () =>
    tx(async () => {
      const a = await o.query("SELECT id FROM account WHERE login='linmin'");
      const s = await o.query("SELECT id FROM study_site WHERE code='SS-01'");
      await expect(o.query(`
        INSERT INTO site_assignment (account_id, study_site_id, role_kind, effective)
        VALUES ($1,$2,'CRA', daterange('2025-01-01', NULL, '[)'))`, [a.rows[0].id, s.rows[0].id]))
        .rejects.toThrow(/site_assignment_account_id_study_site_id_effective_excl/);
    }));

  it("一个项目同一时间只能归一个组，否则「本组的中心」有歧义", () =>
    tx(async () => {
      const t = await o.query("SELECT id FROM team WHERE code='G-02'");
      const s = await o.query("SELECT id FROM study WHERE code='HJ-2024-017'");
      await expect(o.query("INSERT INTO team_study (team_id, study_id) VALUES ($1,$2)",
        [t.rows[0].id, s.rows[0].id])).rejects.toThrow(/team_study_one_owner/);
    }));

  it("首例入组不可能早于启动会", () =>
    tx(async () => {
      await expect(o.query(
        `UPDATE study_site SET fpi_on = siv_on - 1 WHERE code='SS-01'`))
        .rejects.toThrow(/site_fpi_after_siv/);
    }));

  it("启动会不可能早于伦理批件", () =>
    tx(async () => {
      await expect(o.query(
        `UPDATE study_site SET siv_on = irb_approved_on - 1 WHERE code='SS-01'`))
        .rejects.toThrow(/site_siv_after_irb/);
    }));

  it("中心状态必须是状态机上的合法节点", () =>
    tx(async () => {
      await expect(o.query("UPDATE study_site SET state='随便写' WHERE code='SS-01'"))
        .rejects.toThrow(/study_site_state_fkey/);
    }));

  it("金额是 numeric，不是浮点 —— 万元 × float 是对账对不平的经典成因", async () => {
    const { rows } = await o.query(`
      SELECT data_type, numeric_precision, numeric_scale FROM information_schema.columns
       WHERE table_name='study_site' AND column_name='unit_price'`);
    expect(rows[0]).toMatchObject({ data_type: "numeric", numeric_precision: 14, numeric_scale: 2 });
  });

  it("访视日期类字段用 date 而非 timestamp —— 带时区会在跨时区时错一天", async () => {
    const { rows } = await o.query(`
      SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name='study_site' AND column_name IN ('irb_approved_on','siv_on','fpi_on')
       ORDER BY 1`);
    expect(rows.every(r => r.data_type === "date")).toBe(true);
  });

  it("每张业务表都有 tenant_id —— 事后补要动全部外键与全部策略", async () => {
    const { rows } = await o.query(`
      SELECT t.tablename FROM pg_tables t
       WHERE t.schemaname='public'
         AND t.tablename NOT IN ('schema_migration','tenant','row_rule','field_key',
                                 'action_key','site_state','role_field','role_action',
                                 'role_module','team_study')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns c
                          WHERE c.table_name=t.tablename AND c.column_name='tenant_id')`);
    expect(rows.map(r => r.tablename)).toEqual([]);
  });
});
