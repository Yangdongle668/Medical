import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { owner, appConn, accountIds, asAccount } from "./helpers.js";

let o, c, ID;
beforeAll(async () => {
  o = owner(); await o.connect();
  c = appConn(); await c.connect();
  ID = await accountIds(o);
});
afterAll(async () => { await o.end(); await c.end(); });

const insert = (client, over = {}) => {
  const r = { actor_login: "wutong", actor_role_code: "crc", action: "修改访视目标日",
              target_type: "subject_visit", target_id: "SV-0001",
              before_value: JSON.stringify({ target_at: "2026-08-18" }),
              after_value:  JSON.stringify({ target_at: "2026-08-25" }),
              reason: "受试者出差改期", is_sensitive: true, ...over };
  return client.query(
    `INSERT INTO audit_entry (actor_login, actor_role_code, action, target_type, target_id,
       before_value, after_value, reason, is_sensitive, study_site_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [r.actor_login, r.actor_role_code, r.action, r.target_type, r.target_id,
     r.before_value, r.after_value, r.reason, r.is_sensitive, r.study_site_id ?? null]);
};

describe("只追加：改不了、删不掉", () => {
  it("可以写入", async () => {
    await o.query("BEGIN");
    const { rows } = await insert(o);
    expect(rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
    await o.query("ROLLBACK");
  });

  it("owner 也 UPDATE 不了 —— 仅靠 REVOKE 挡不住 owner，所以还有语句级触发器", async () => {
    await o.query("BEGIN");
    await insert(o);
    await expect(o.query("UPDATE audit_entry SET reason = '改一下'"))
      .rejects.toThrow(/只追加表，不允许 UPDATE/);
    await o.query("ROLLBACK");
  });

  it("owner 也 DELETE 不了", async () => {
    await o.query("BEGIN");
    await insert(o);
    await expect(o.query("DELETE FROM audit_entry"))
      .rejects.toThrow(/只追加表，不允许 DELETE/);
    await o.query("ROLLBACK");
  });

  it("owner 也 TRUNCATE 不了", async () => {
    await expect(o.query("TRUNCATE audit_entry"))
      .rejects.toThrow(/只追加表，不允许 TRUNCATE/);
  });

  it("应用角色连 UPDATE 权限都没有（REVOKE 先于触发器生效）", async () => {
    await asAccount(c, ID.lingyuan, async () => {
      await expect(c.query("UPDATE audit_entry SET reason='x'")).rejects.toThrow();
    });
  });
});

describe("四个 W：为什么最容易被省，所以由约束强制", () => {
  it("声明为敏感的动作，没写原因就写不进去", async () => {
    await o.query("BEGIN");
    await expect(insert(o, { reason: null }))
      .rejects.toThrow(/audit_sensitive_needs_reason/);
    await o.query("ROLLBACK");
  });

  it("原因不能是敷衍的一两个字", async () => {
    await o.query("BEGIN");
    await expect(insert(o, { reason: "改" }))
      .rejects.toThrow(/audit_sensitive_needs_reason/);
    await o.query("ROLLBACK");
  });

  it("非敏感动作可以没有原因", async () => {
    await o.query("BEGIN");
    const { rows } = await insert(o, { is_sensitive: false, reason: null, action: "登录" });
    expect(rows[0].id).toBeTruthy();
    await o.query("ROLLBACK");
  });

  it("角色是快照 —— 事后改角色，历史里仍是当时的身份", async () => {
    await o.query("BEGIN");
    await insert(o, { actor_role_code: "crc" });
    await o.query("UPDATE account SET role_id = (SELECT id FROM role WHERE code='pm') WHERE login='wutong'");
    const { rows } = await o.query(
      "SELECT actor_role_code FROM audit_entry WHERE target_id='SV-0001' ORDER BY at DESC LIMIT 1");
    expect(rows[0].actor_role_code).toBe("crc");
    await o.query("ROLLBACK");
  });
});

describe("审计的行范围：外部方看不到别人中心的轨迹", () => {
  it("机构办只看得到本院中心的条目，看不到无中心归属的内部动作", async () => {
    const sites = await o.query("SELECT id, code, hospital FROM study_site ORDER BY code");
    const xh = sites.rows.find(r => r.hospital === "北京协和医院");
    const other = sites.rows.find(r => r.hospital !== "北京协和医院");

    await o.query("BEGIN");
    await insert(o, { study_site_id: xh.id,    target_id: "IN-SCOPE" });
    await insert(o, { study_site_id: other.id, target_id: "OUT-SCOPE" });
    await insert(o, { study_site_id: null,     target_id: "INTERNAL-ONLY",
                      action: "调整角色权限", is_sensitive: true, reason: "商务口径调整" });
    await o.query("COMMIT");

    try {
      const seen = await asAccount(c, ID.zhanghm, async () => {
        const { rows } = await c.query(
          "SELECT target_id FROM audit_entry WHERE target_id LIKE '%SCOPE%' OR target_id LIKE 'INTERNAL%'");
        return rows.map(r => r.target_id);
      });
      expect(seen).toContain("IN-SCOPE");
      expect(seen).not.toContain("OUT-SCOPE");
      expect(seen).not.toContain("INTERNAL-ONLY");
    } finally {
      /* 只追加表删不掉，所以这些行留在测试库里；下次 global-setup 重建时清空。
         这本身就是"只追加"的证据。 */
    }
  });
});
