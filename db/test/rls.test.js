import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { owner, appConn, accountIds, asAccount, TENANT } from "./helpers.js";

let o, c, ID;

beforeAll(async () => {
  o = owner(); await o.connect();
  c = appConn(); await c.connect();
  ID = await accountIds(o);
});
afterAll(async () => { await o.end(); await c.end(); });

const sitesVisibleTo = id =>
  asAccount(c, id, async () => {
    const { rows } = await c.query("SELECT code FROM study_site ORDER BY code");
    return rows.map(r => r.code);
  });

describe("行维度：五条范围规则", () => {
  /* 期望值来自原型的同一套演示数据。
     packages/policy 的 rowScope() 将来必须对同一批账号给出同一批中心 —— 两处不一致就是泄漏。 */
  const CASES = [
    ["lingyuan", "all",      15, "经营层"],
    ["miaoqing", "all",      15, "数据管理"],
    ["weilan",   "all",      15, "质量保证"],
    ["hanxue",   "team",      8, "PM · 华东华南组承接 017 与 003"],
    ["cendi",    "team",      7, "PM · 华北西南组承接 011 与 004"],
    ["linmin",   "assigned",  4, "CRA · 被指派 4 个中心"],
    ["wutong",   "assigned",  2, "CRC · 驻场 2 个中心"],
    ["liaomeng", "assigned",  3, "CRC · 驻场 3 个中心"],
    ["zhanghm",  "hospital",  2, "机构办 · 北京协和承接 2 个项目"],
    ["chenguod", "pi",        1, "研究者 · 本人担任 PI 的中心"]
  ];
  for (const [login, rule, n, why] of CASES) {
    it(`${login}（${rule}）看得到 ${n} 个中心 —— ${why}`, async () => {
      expect((await sitesVisibleTo(ID[login])).length).toBe(n);
    });
  }

  it("两个 PM 的可见集合不重叠 —— 分组即行边界", async () => {
    const a = new Set(await sitesVisibleTo(ID.hanxue));
    const b = await sitesVisibleTo(ID.cendi);
    expect(b.filter(x => a.has(x))).toEqual([]);
    expect(a.size + b.length).toBe(15);
  });

  it("机构办只看得到本院，且确实是本院", async () => {
    const codes = await sitesVisibleTo(ID.zhanghm);
    const { rows } = await o.query(
      "SELECT DISTINCT hospital FROM study_site WHERE code = ANY($1)", [codes]);
    expect(rows.map(r => r.hospital)).toEqual(["北京协和医院"]);
  });

  it("CRA 的可见集合等于他的有效派工", async () => {
    const codes = await sitesVisibleTo(ID.linmin);
    const { rows } = await o.query(`
      SELECT s.code FROM site_assignment a JOIN study_site s ON s.id = a.study_site_id
       WHERE a.account_id = $1 AND a.effective @> CURRENT_DATE ORDER BY s.code`, [ID.linmin]);
    expect(codes).toEqual(rows.map(r => r.code));
  });
});

describe("fail-closed：拿不准就一行都不给", () => {
  it("未设置 app.account_id → 0 行", async () => {
    expect((await sitesVisibleTo(null)).length).toBe(0);
  });

  it("已停用账号 → 0 行（停用不删除，但立刻失去范围）", async () => {
    expect((await sitesVisibleTo(ID.zhouqi)).length).toBe(0);
  });

  it("不存在的账号 id → 0 行", async () => {
    expect((await sitesVisibleTo("11111111-2222-3333-4444-555555555555")).length).toBe(0);
  });
});

describe("写路径同样受行范围约束", () => {
  it("CRA 改不动范围外的中心（0 行受影响，且不报错 —— 那一行对他不存在）", async () => {
    const outside = await o.query(
      `SELECT code FROM study_site WHERE code NOT IN (
         SELECT s.code FROM site_assignment a JOIN study_site s ON s.id=a.study_site_id
          WHERE a.account_id=$1) LIMIT 1`, [ID.linmin]);
    const code = outside.rows[0].code;
    const n = await asAccount(c, ID.linmin, async () => {
      const r = await c.query("UPDATE study_site SET dept = 'X' WHERE code = $1", [code]);
      return r.rowCount;
    });
    expect(n).toBe(0);
  });

  it("CRA 改得动范围内的中心", async () => {
    const n = await asAccount(c, ID.linmin, async () => {
      const r = await c.query("UPDATE study_site SET dept = dept WHERE code = 'SS-01'");
      return r.rowCount;
    });
    expect(n).toBe(1);
  });

  it("WITH CHECK 阻止把行写到别的租户去", async () => {
    await expect(asAccount(c, ID.lingyuan, () =>
      c.query(`UPDATE study_site SET tenant_id = '00000000-0000-0000-0000-0000000000ff'
                WHERE code = 'SS-01'`)
    )).rejects.toThrow();
  });
});

describe("租户维度（当前单租户，但列与策略已就位）", () => {
  it("另一个租户的中心对本租户不可见", async () => {
    const T2 = "00000000-0000-0000-0000-0000000000ff";
    await o.query("BEGIN");
    try {
      await o.query("INSERT INTO tenant (id, code, name) VALUES ($1,'other','另一家 CRO')", [T2]);
      const st = await o.query(`INSERT INTO study (tenant_id, code, short_name, sponsor_name,
        phase, indication, planned_subjects, contract_amount_cents)
        VALUES ($1,'XX-9999','他家项目','他家申办方','I期','X',10,100000000) RETURNING id`, [T2]);
      await o.query(`INSERT INTO study_site (tenant_id, study_id, code, hospital, dept, city,
        pi_name, contracted, unit_price_cents)
        VALUES ($1,$2,'ZZ-99','他家医院','科','城','某某',10,1000000)`, [T2, st.rows[0].id]);
      /* 经营层是 row_rule='all'，但 all 只在本租户内为真 */
      const codes = await sitesVisibleTo(ID.lingyuan);
      expect(codes).not.toContain("ZZ-99");
      expect(codes.length).toBe(15);
      const all = await o.query("SELECT count(*)::int n FROM study_site");
      expect(all.rows[0].n).toBe(16);   // owner 看得到 16 —— 说明数据确实写进去了
    } finally { await o.query("ROLLBACK"); }
  });
});

describe("INSERT ... RETURNING 必须能穿过自己的 RLS 策略", () => {
  /* FOR ALL 策略的 USING 会作用于 INSERT ... RETURNING 的返回行。
     若策略里的辅助函数是 STABLE 且按 id 回查本表，它看不到刚插入的那一行，
     插入就会失败并报「new row violates row-level security policy」——
     而排查时会发现每个条件单独求值都是 true，极难定位。

     防线：策略辅助函数必须**接收行的列值**作为参数，不能按 id 回查本表。
     这一组测试就是盯住这条约定。 */
  const returningWorks = async (label, sql, params, login) =>
    asAccount(c, ID[login], async () => {
      const r = await c.query(sql, params);
      expect(r.rows[0]?.id, `${label}：INSERT ... RETURNING 被自己的策略挡住了`).toBeTruthy();
      return r.rows[0].id;
    });

  it("study_site", async () => {
    const st = await o.query("SELECT id FROM study LIMIT 1");
    await returningWorks("study_site", `
      INSERT INTO study_site (study_id, code, hospital, dept, city, pi_name,
        contracted, unit_price_cents)
      VALUES ($1,'SS-RET','回执测试医院','科','北京','某研究者',5,1000000)
      RETURNING id`, [st.rows[0].id], "lingyuan");
  });

  it("handover", async () => {
    const to = await o.query("SELECT id FROM account WHERE login='shenyilin'");
    await returningWorks("handover", `
      INSERT INTO handover (from_account_id, to_account_id, reason, planned_on)
      VALUES (app.current_account_id(), $1, '回执测试交接', CURRENT_DATE)
      RETURNING id`, [to.rows[0].id], "wutong");
  });

  it("audit_entry", async () => {
    await returningWorks("audit_entry", `
      INSERT INTO audit_entry (actor_login, actor_role_code, action, target_type, target_id)
      VALUES ('lingyuan','boss','回执测试','test','T-1') RETURNING id`, [], "lingyuan");
  });
});

describe("account 表：外部方只看得到自己", () => {
  const visibleAccounts = id => asAccount(c, id, async () => {
    const { rows } = await c.query("SELECT login FROM account ORDER BY login");
    return rows.map(r => r.login);
  });
  it("内部员工看得到全部账号", async () => {
    expect((await visibleAccounts(ID.linmin)).length).toBe(20);
  });
  it("机构办只看得到自己", async () => {
    expect(await visibleAccounts(ID.zhanghm)).toEqual(["zhanghm"]);
  });
  it("研究者只看得到自己", async () => {
    expect(await visibleAccounts(ID.chenguod)).toEqual(["chenguod"]);
  });
});
