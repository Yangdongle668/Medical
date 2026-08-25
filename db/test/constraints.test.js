import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { owner } from "./helpers.js";

let o;
beforeAll(async () => { o = owner(); await o.connect(); });
afterAll(async () => { await o.end(); });

const tx = async fn => {
  await o.query("BEGIN");
  try { return await fn(); } finally { await o.query("ROLLBACK"); }
};

/** 「这张表的租户归属能不能算出来」—— 一条规则，两处使用：
 *  一处断言真实 schema 全部合规，一处证明这条规则不是恒真的。 */
const GROUNDING_SQL = `
  WITH RECURSIVE t AS (
    SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND c.relname NOT IN ('schema_migration', 'tenant')
  ),
  no_tenant AS (
    SELECT t.oid, t.relname FROM t
     WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns col
                        WHERE col.table_name = t.relname AND col.column_name = 'tenant_id')
  ),
  grounded(oid) AS (
    -- 基点一：自己带 tenant_id
    SELECT t.oid FROM t WHERE t.oid NOT IN (SELECT oid FROM no_tenant)
    UNION
    -- 基点二：全局枚举表 —— 单列 text 主键，且不引用任何表
    SELECT nt.oid FROM no_tenant nt
      JOIN pg_constraint pk ON pk.conrelid = nt.oid AND pk.contype = 'p'
      JOIN pg_attribute a ON a.attrelid = nt.oid AND a.attnum = pk.conkey[1]
     WHERE cardinality(pk.conkey) = 1 AND a.atttypid = 'text'::regtype
       AND NOT EXISTS (SELECT 1 FROM pg_constraint fk
                        WHERE fk.conrelid = nt.oid AND fk.contype = 'f')
    UNION
    -- 递推：主键里的外键指向一张归属已可推导的父表
    SELECT nt.oid FROM no_tenant nt
      JOIN pg_constraint pk ON pk.conrelid = nt.oid AND pk.contype = 'p'
      JOIN pg_constraint fk ON fk.conrelid = nt.oid AND fk.contype = 'f'
                           AND fk.conkey && pk.conkey
      JOIN grounded g ON g.oid = fk.confrelid
  )
  SELECT relname FROM no_tenant
   WHERE oid NOT IN (SELECT oid FROM grounded) ORDER BY 1`;

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

  it("金额是整数分（bigint），不是浮点、也不是元 —— 与契约层口径一致", async () => {
    const { rows } = await o.query(`
      SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name IN ('study','study_site')
         AND column_name IN ('contract_amount_cents','unit_price_cents','startup_fee_cents')
       ORDER BY 1`);
    expect(rows.map(r => r.column_name))
      .toEqual(["contract_amount_cents", "startup_fee_cents", "unit_price_cents"]);
    expect(rows.every(r => r.data_type === "bigint")).toBe(true);
  });

  it("旧的元口径列已彻底移除 —— 两套口径并存就是对账对不平的开始", async () => {
    const { rows } = await o.query(`
      SELECT column_name FROM information_schema.columns
       WHERE table_name IN ('study','study_site')
         AND column_name IN ('contract_amount','unit_price','startup_fee')`);
    expect(rows).toEqual([]);
  });

  it("访视日期类字段用 date 而非 timestamp —— 带时区会在跨时区时错一天", async () => {
    const { rows } = await o.query(`
      SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name='study_site' AND column_name IN ('irb_approved_on','siv_on','fpi_on')
       ORDER BY 1`);
    expect(rows.every(r => r.data_type === "date")).toBe(true);
  });

  it("每张业务表的租户归属都能被推导出来 —— 事后补 tenant_id 要动全部外键与全部策略", async () => {
    /* 不是"每张表都要有 tenant_id"，而是"每张表的归属都要能算出来"。
       允许缺 tenant_id 的只有两类，且判定是算出来的，不是维护白名单
       —— 白名单会被顺手加东西，加完就再也没人回头看。

       ① 全局枚举表：单列 text 主键，且不引用任何表。取值写死，全租户共用。
       ② 明细表：主键里包含指向父表的外键，而父表自己的归属已经能算出来。
          外键必须落在**主键**里 —— 落在普通列上不算：普通列可以 UPDATE 到
          另一个租户的父行上，归属就成了可篡改的。递归判定，链条必须终止在
          带 tenant_id 的表或全局枚举表上。 */
    const { rows } = await o.query(GROUNDING_SQL);
    expect(rows.map(r => r.relname), "这些表既不带 tenant_id，也无法从主键推导出归属")
      .toEqual([]);
  });

  it("契约里声明的每个动作权限都在 action_key 表里存在", async () => {
    /* 契约是权限的唯一声明处（守卫按 operationId 去查它），
       但取值本身住在数据库。两边对不上时，症状是**所有角色一律 403**，
       而错误信息里的动作名在权限表里根本查不到 —— 排查时很容易
       误以为是授权没配。这条断言把它变成一次编译期之后的立即失败。

       测试跑在 db 包里而不是 api 包里，是因为它断言的是「两个数据源一致」，
       与 HTTP 无关。 */
    const { allEndpoints } = await import("@sitedesk/contracts");
    const declared = [...new Set(allEndpoints().map(e => e.action).filter(Boolean))].sort();
    expect(declared.length, "契约里应当有声明动作权限的端点").toBeGreaterThan(0);
    const { rows } = await o.query("SELECT code FROM action_key ORDER BY 1");
    const known = new Set(rows.map(r => r.code));
    expect(declared.filter(a => !known.has(a)), "契约声明了这些动作，但 action_key 表里没有")
      .toEqual([]);
  });

  it("工时不能删除，只能作废 —— 能悄悄删掉的成本记录等于没有记录", () =>
    tx(async () => {
      await expect(o.query("DELETE FROM timesheet_entry"))
        .rejects.toThrow(/只能作废/);
    }));

  it("改工时数会被拒 —— 改数字要作废后重报", () =>
    tx(async () => {
      await expect(o.query("UPDATE timesheet_entry SET hours = 99"))
        .rejects.toThrow(/不可修改/);
    }));

  it("改成本会被拒", () =>
    tx(async () => {
      await expect(o.query("UPDATE timesheet_entry SET cost_cents = 1"))
        .rejects.toThrow(/不可修改/);
    }));

  it("改归属的中心会被拒 —— 成本挪一个中心，两边的毛利同时错", () =>
    tx(async () => {
      await expect(o.query(`
        UPDATE timesheet_entry SET study_site_id =
          (SELECT id FROM study_site WHERE code = 'SS-09')`))
        .rejects.toThrow(/不可修改/);
    }));

  it("但打作废标记是允许的 —— 那正是唯一的更正途径", () =>
    tx(async () => {
      const { rowCount } = await o.query(`
        UPDATE timesheet_entry SET voided_at = now(),
               voided_by = (SELECT id FROM account WHERE login = 'lingyuan'),
               void_reason = '测试作废'
         WHERE voided_at IS NULL`);
      expect(rowCount).toBeGreaterThan(0);
    }));

  it("已作废的工时不可再改 —— 否则冲销之后还能被改回来", () =>
    tx(async () => {
      await o.query(`
        UPDATE timesheet_entry SET voided_at = now(),
               voided_by = (SELECT id FROM account WHERE login = 'lingyuan'),
               void_reason = '第一次作废'
         WHERE id = (SELECT id FROM timesheet_entry WHERE voided_at IS NULL LIMIT 1)`);
      await expect(o.query(`
        UPDATE timesheet_entry SET void_reason = '改一下理由'
         WHERE voided_at IS NOT NULL`)).rejects.toThrow(/已作废/);
    }));

  it("作废三件套要么都有要么都没有 —— 只记「作废了」而不记谁作废的，说不清", () =>
    tx(async () => {
      await expect(o.query(
        "UPDATE timesheet_entry SET voided_at = now() WHERE voided_at IS NULL"))
        .rejects.toThrow(/timesheet_void_complete/);
    }));

  it("费率卡的生效区间不允许重叠 —— 重叠时「当天用哪个费率」没有答案（I2）", () =>
    tx(async () => {
      await expect(o.query(`
        INSERT INTO rate_card (role_kind, day_cost_cents, valid_from)
        VALUES ('CRC', 150000, '2026-06-01')`))
        .rejects.toThrow(/rate_card_no_overlap/);
    }));

  it("app.rate_on 按日期挑卡：2025 年的工时用旧价，2026 年的用新价", async () => {
    const { rows } = await o.query(`
      SELECT (app.rate_on('CRC', NULL, '2025-06-01')).day_cost_cents AS old,
             (app.rate_on('CRC', NULL, '2026-06-01')).day_cost_cents AS new`);
    expect(Number(rows[0].old)).toBeLessThan(Number(rows[0].new));
    /* 关键不在于新价更高，而在于**同一个函数对不同日期给出不同答案** ——
       只存一个常量的话，调价当天所有历史项目的毛利会集体变化。 */
  });

  it("一次访视只自动生成一条工时 —— 重复触发不该重复计成本", () =>
    tx(async () => {
      const src = await o.query(`
        SELECT study_site_id, account_id, work_date, work_type, billable, hours,
               rate_card_id, day_cost_cents, cost_cents
          FROM timesheet_entry LIMIT 1`);
      const v = await o.query("SELECT id, subject_id FROM subject_visit LIMIT 1");
      const cols = `study_site_id, account_id, work_date, work_type, billable, hours,
        rate_card_id, day_cost_cents, cost_cents, visit_id, auto_generated`;
      const vals = Object.values(src.rows[0]);
      const ins = `INSERT INTO timesheet_entry (${cols})
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)`;
      await o.query(ins, [...vals, v.rows[0].id]);
      await expect(o.query(ins, [...vals, v.rows[0].id]))
        .rejects.toThrow(/timesheet_one_auto_per_visit/);
    }));

  it("每个动作权限至少被一个角色持有 —— 没人有的权限等于关掉了那个端点", async () => {
    /* 这一条是被真事故逼出来的：迁移里写了
         INSERT INTO role_action ... SELECT FROM role WHERE ...
       而迁移跑在种子之前，此刻 role 表是空的 —— 插入 0 行，一个错误都不报。
       结果是契约上声明了权限、守卫也在强制，但**所有人都没有**，
       于是那几个端点对每一个角色都返回 403，而且看不出是哪里断的。 */
    const { rows } = await o.query(`
      SELECT k.code FROM action_key k
       WHERE NOT EXISTS (SELECT 1 FROM role_action ra
                          WHERE ra.action_key = k.code AND ra.allowed)
       ORDER BY 1`);
    expect(rows.map(r => r.code), "这些动作没有任何角色持有").toEqual([]);
  });

  it("上一条规则不是恒真的 —— 三种典型错法都必须被抓到", () =>
    tx(async () => {
      /* 断言容易写成永远为真而无人察觉。这里故意造三张错表，
         规则抓不到任何一张，就说明上一条断言已经失效了。 */
      await o.query(`
        CREATE TABLE probe_orphan (id uuid PRIMARY KEY, note text);
        CREATE TABLE probe_side   (id uuid PRIMARY KEY,
                                   handover_id uuid REFERENCES handover(id));
        CREATE TABLE probe_chain  (id uuid PRIMARY KEY,
                                   x uuid REFERENCES probe_orphan(id))`);
      const { rows } = await o.query(GROUNDING_SQL);
      expect(rows.map(r => r.relname).filter(n => n.startsWith("probe_")))
        .toEqual(["probe_chain", "probe_orphan", "probe_side"]);
    }));
});
