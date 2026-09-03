import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { owner, appConn, accountIds, asAccount } from "./helpers.js";

/* ════════════════════════════════════════════════════════════════════
   CAPA 与内部稽查（迁移 0035 / 0036）。

   **文件名是 internal-audit，不是 audit** —— `audit.test.js` 已经被
   `audit_entry`（操作留痕：谁在什么时候改了什么）占着。
   中文都叫"审计/稽查"，但两者毫无关系，而这个重名坑我踩过一次：
   新写的这一批差点把那 8 条只追加断言整个覆盖掉，
   而 db 套件的总数照样是绿的 —— 它只会变多，不会报"少了什么"。

   这一组钉的是**约束本身**：
     · 有措施而没有责任人 —— 「谁去做」没有答案；
     · 关了一条发现却说不出怎么验证的；
     · 空范围的稽查；
     · **外部方看得见我方的自查报告** —— 下一次自查就查不出东西了。
   ════════════════════════════════════════════════════════════════════ */

let o;
beforeAll(async () => { o = owner(); await o.connect(); });
afterAll(async () => { await o.end(); });

const tx = async fn => {
  await o.query("BEGIN");
  try { return await fn(); } finally { await o.query("ROLLBACK"); }
};

describe("CAPA 的形状约束", () => {
  const anEvent = async () =>
    (await o.query(
      `SELECT id, code FROM quality_event WHERE kind <> 'query' LIMIT 1`)).rows[0];

  it("**有措施就要有人** —— 否则「谁去做」没有答案", async () => {
    const e = await anEvent();
    await expect(tx(() => o.query(
      `UPDATE quality_event SET capa_plan = '补签并留痕',
              capa_owner_account_id = NULL, capa_due_on = NULL WHERE id = $1`, [e.id])))
      .rejects.toThrow(/quality_capa_shape/);
  });

  it("责任人与期限同生共死", async () => {
    const e = await anEvent();
    await expect(tx(() => o.query(
      `UPDATE quality_event SET capa_plan = NULL,
              capa_owner_account_id = (SELECT id FROM account WHERE login = 'wutong'),
              capa_due_on = NULL WHERE id = $1`, [e.id])))
      .rejects.toThrow(/quality_capa_shape/);
  });

  it("**「已指派、还没写措施」是允许的** —— 它是一个真实状态", async () => {
    const e = await anEvent();
    await tx(async () => {
      await o.query(
        `UPDATE quality_event SET capa_plan = NULL,
                capa_owner_account_id = (SELECT id FROM account WHERE login = 'wutong'),
                capa_due_on = CURRENT_DATE + 30 WHERE id = $1`, [e.id]);
    });
    /* 种子里就有三条这样的 —— 机构质控刚提出来，措施要受托方写。 */
    const { rows } = await o.query(
      `SELECT count(*)::int AS n FROM quality_event
        WHERE capa_owner_account_id IS NOT NULL AND capa_plan IS NULL`);
    expect(rows[0].n).toBeGreaterThan(0);
  });

  it("质疑不挂 CAPA —— 它走自己的闭环", async () => {
    const q = (await o.query(
      `SELECT id FROM quality_event WHERE kind = 'query' LIMIT 1`)).rows[0];
    await expect(tx(() => o.query(
      `UPDATE quality_event SET capa_plan = '给质疑挂措施是错的',
              capa_owner_account_id = (SELECT id FROM account WHERE login = 'wutong'),
              capa_due_on = CURRENT_DATE + 30 WHERE id = $1`, [q.id])))
      .rejects.toThrow(/quality_capa_not_on_query/);
  });
});

describe("内部稽查的形状约束", () => {
  const anAudit = async () =>
    (await o.query(`SELECT id, code FROM internal_audit LIMIT 1`)).rows[0];

  it("**空范围的稽查等于没查**", async () => {
    const a = await anAudit();
    await expect(tx(() => o.query(
      `UPDATE internal_audit SET scope = '  ' WHERE id = $1`, [a.id])))
      .rejects.toThrow(/internal_audit_scope_check|violates check constraint/);
  });

  it("关闭三件套同生共死", async () => {
    const a = (await o.query(
      `SELECT id FROM internal_audit WHERE state = 'closed' LIMIT 1`)).rows[0];
    await expect(tx(() => o.query(
      `UPDATE internal_audit SET closed_by = NULL WHERE id = $1`, [a.id])))
      .rejects.toThrow(/audit_closed_shape/);
  });

  it("**关了一条发现就要说得出怎么验证的**", async () => {
    const f = (await o.query(
      `SELECT audit_id, seq FROM audit_finding WHERE state = 'closed' LIMIT 1`)).rows[0];
    expect(f, "种子里应该有已关闭的发现项").toBeTruthy();
    await expect(tx(() => o.query(
      `UPDATE audit_finding SET verification = NULL
        WHERE audit_id = $1 AND seq = $2`, [f.audit_id, f.seq])))
      .rejects.toThrow(/finding_closed_shape/);
  });

  it("**复发用外键，指不到一条不存在的事件**", async () => {
    const f = (await o.query(
      `SELECT audit_id, seq FROM audit_finding LIMIT 1`)).rows[0];
    await expect(tx(() => o.query(
      `UPDATE audit_finding SET repeat_of = gen_random_uuid()
        WHERE audit_id = $1 AND seq = $2`, [f.audit_id, f.seq])))
      .rejects.toThrow(/foreign key|audit_finding_repeat_of_fkey/);
  });

  it("种子里的复发确实指得到源事件", async () => {
    const { rows } = await o.query(
      `SELECT f.finding, q.code FROM audit_finding f
         JOIN quality_event q ON q.id = f.repeat_of
        WHERE f.repeat_of IS NOT NULL`);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].code).toMatch(/^QI-/);
  });
});

describe("自查报告不能给被查方看", () => {
  let app, ids;
  beforeAll(async () => { app = appConn(); await app.connect(); ids = await accountIds(o); });
  afterAll(async () => { await app.end(); });

  it("**机构办一条内部稽查都看不到**", async () => {
    await asAccount(app, ids["zhanghm"], async () => {
      const a = await app.query(`SELECT count(*)::int AS n FROM internal_audit`);
      expect(a.rows[0].n, "给被查方看，下一次自查就查不出东西了").toBe(0);
      const f = await app.query(`SELECT count(*)::int AS n FROM audit_finding`);
      expect(f.rows[0].n).toBe(0);
    });
  });

  it("QA 照旧看得到", async () => {
    await asAccount(app, ids["weilan"], async () => {
      const { rows } = await app.query(`SELECT count(*)::int AS n FROM internal_audit`);
      expect(rows[0].n).toBeGreaterThanOrEqual(4);
    });
  });
});

describe("audit 与 capaWrite 两个动作权限", () => {
  it("三处清单一致：action_key 表里有它们", async () => {
    const { rows } = await o.query(
      `SELECT code, label FROM action_key WHERE code IN ('audit','capaWrite')
        ORDER BY code`);
    expect(rows.map(r => r.code)).toEqual(["audit", "capaWrite"]);
  });

  it("**audit 只给 QA 与管理员** —— 机构办有 closeQA，但不能查我方", async () => {
    const { rows } = await o.query(
      `SELECT r.code FROM role r
         JOIN role_action ra ON ra.role_id = r.id
        WHERE ra.action_key = 'audit' AND ra.allowed ORDER BY r.code`);
    expect(rows.map(r => r.code)).toEqual(["admin", "qa"]);
  });

  it("**capaWrite 给整改责任人，不给经营层与外部方**", async () => {
    const { rows } = await o.query(
      `SELECT r.code FROM role r
         JOIN role_action ra ON ra.role_id = r.id
        WHERE ra.action_key = 'capaWrite' AND ra.allowed ORDER BY r.code`);
    expect(rows.map(r => r.code)).toEqual(["admin", "cra", "crc", "pm", "qa"]);
  });

  it("**写措施与验证关闭不是同一个动作** —— 两端不能是同一个人", async () => {
    const { rows } = await o.query(
      `SELECT r.code,
              bool_or(ra.action_key = 'capaWrite' AND ra.allowed) AS can_write,
              bool_or(ra.action_key = 'closeQA'   AND ra.allowed) AS can_close
         FROM role r JOIN role_action ra ON ra.role_id = r.id
        WHERE r.code IN ('crc','cra','pm','inst') GROUP BY r.code ORDER BY r.code`);
    /* 三个整改责任角色都写得了措施，一个都关不掉 */
    for (const r of rows.filter(x => x.code !== "inst")) {
      expect(r.can_write, `${r.code} 应该写得了措施`).toBe(true);
      expect(r.can_close, `${r.code} 不该能自己验证关闭`).toBe(false);
    }
    /* 反过来：机构办关得掉自己提的，但写不了我方的措施 */
    const inst = rows.find(r => r.code === "inst");
    expect(inst.can_close).toBe(true);
    expect(inst.can_write).toBe(false);
  });
});
