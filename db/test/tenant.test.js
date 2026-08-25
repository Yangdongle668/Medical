import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { owner } from "./helpers.js";

let o;
beforeAll(async () => { o = owner(); await o.connect(); });
afterAll(async () => { await o.end(); });

/* ════════════════════════════════════════════════════════════════════
   开户物料 —— 第二个租户开得出来吗。

   在 0012 之前答案是**开不出来**，而且不是"要多做点工作"：
   角色主键是 `uuid5('role:' + code)`，不含租户，
   两个租户的 `crc` 会算出同一个 UUID，第二个直接撞 role_pkey。
   这件事没有任何测试盖住，因为**从来没有人试过开第二个**。

   下面这三条就是那次尝试。
   ════════════════════════════════════════════════════════════════════ */

/** 一个角色被授予了什么 —— 三维各取一条可比较的字符串。 */
const GRANTS = `
  SELECT r.code AS role,
         (SELECT string_agg(field_key||'='||visible, ',' ORDER BY field_key)
            FROM role_field WHERE role_id = r.id) AS fields,
         (SELECT string_agg(action_key||'='||allowed, ',' ORDER BY action_key)
            FROM role_action WHERE role_id = r.id) AS actions,
         (SELECT string_agg(module_key||':'||sort_order, ',' ORDER BY sort_order)
            FROM role_module WHERE role_id = r.id) AS modules
    FROM role r JOIN tenant t ON t.id = r.tenant_id
   WHERE t.code = $1 ORDER BY r.code`;

const grants = async code => (await o.query(GRANTS, [code])).rows;

describe("app.provision_tenant：开一个新租户", () => {
  const CODE = "t_" + Math.random().toString(36).slice(2, 8);

  it("开得出来，且拿到八个标准角色", async () => {
    const { rows } = await o.query("SELECT app.provision_tenant($1, $2) AS id", [CODE, "测试租户"]);
    expect(rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
    const g = await grants(CODE);
    expect(g.map(r => r.role)).toEqual(["boss", "cra", "crc", "dm", "inst", "pi", "pm", "qa"]);
  });

  it("新租户的行/列/动作/模块授予与演示租户逐条一致", async () => {
    /* 这一条是"物料"的定义：两个租户拿到的**必须**是同一套权限模型，
       否则每开一户就是一次手抄，而手抄的差异只有出事时才看得见。 */
    expect(await grants(CODE)).toEqual(await grants("hengji"));
  });

  it("角色 id 按租户各生成一份 —— 这正是原来插不进去的地方", async () => {
    const { rows } = await o.query(
      `SELECT code, count(DISTINCT id)::int AS ids, count(*)::int AS n
         FROM role GROUP BY code HAVING count(*) > 1`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.ids).toBe(r.n);   // 每个租户一个独立 id
  });

  it("重复开户是幂等的 —— 不新增角色，也不换 id", async () => {
    const before = (await o.query(
      `SELECT r.id FROM role r JOIN tenant t ON t.id=r.tenant_id
        WHERE t.code=$1 ORDER BY r.code`, [CODE])).rows.map(x => x.id);
    await o.query("SELECT app.provision_tenant($1, $2)", [CODE, "测试租户"]);
    const after = (await o.query(
      `SELECT r.id FROM role r JOIN tenant t ON t.id=r.tenant_id
        WHERE t.code=$1 ORDER BY r.code`, [CODE])).rows.map(x => x.id);
    /* id 换掉的话，所有引用它的账号就跟着断了 —— 幂等必须包括"id 不动" */
    expect(after).toEqual(before);
  });
});
