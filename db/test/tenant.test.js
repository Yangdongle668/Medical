import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { owner, appConn, asAccount } from "./helpers.js";

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

/** 开完的测试租户必须收掉。
 *
 *  **不收会变成一个按文件顺序发作的假故障。** 同一个测试库串行跑十一个文件，
 *  而 `internal-audit` / `monitor` 里那几条"这个动作授给了哪几个角色"
 *  是按 `role.code` 全库数的、不带租户条件 —— 库里多一个租户，
 *  它们数出来就是每个角色两份。vitest 按上一轮耗时给文件重新排序，
 *  于是这个文件排在它们前面的那些轮才红，看着像"偶发"，
 *  而失败信息说的是"权限授错了"，指向的地方跟起因毫无关系。
 *
 *  逐个点名 `provision_tenant` 建了哪些表的行是一份会过期的清单
 *  （它今天还建 rate_card，明天可能更多）—— 所以按 `tenant_id` 这一列
 *  反查，删一遍再删一遍直到删不动：外键顺序自己会收敛。
 *  真收敛不了的话，最后那句 `DELETE FROM tenant` 会抛，不会闷掉。 */
async function dropTenant(code) {
  const { rows: owned } = await o.query(
    `SELECT c.relname FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE a.attname = 'tenant_id' AND c.relkind = 'r' AND n.nspname = 'public'`);
  let left = owned.map(r => r.relname);
  for (let pass = 0; pass < 5 && left.length; pass++) {
    const stuck = [];
    for (const t of left) {
      try {
        await o.query(
          `DELETE FROM ${t} WHERE tenant_id IN (SELECT id FROM tenant WHERE code = $1)`,
          [code]);
      } catch { stuck.push(t); }        // 外键还挡着，下一轮再来
    }
    left = stuck;
  }
  await o.query("DELETE FROM tenant WHERE code = $1", [code]);
}

describe("app.provision_tenant：开一个新租户", () => {
  const CODE = "t_" + Math.random().toString(36).slice(2, 8);
  afterAll(() => dropTenant(CODE));

  it("开得出来，且拿到九个标准角色", async () => {
    const { rows } = await o.query("SELECT app.provision_tenant($1, $2) AS id", [CODE, "测试租户"]);
    expect(rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
    const g = await grants(CODE);
    expect(g.map(r => r.role))
      .toEqual(["admin", "boss", "cra", "crc", "dm", "inst", "pi", "pm", "qa"]);
  });

  it("开完就有一个能登进去的管理员 —— 这才是「开户」这个词的意思", async () => {
    /* 在此之前开户只到角色为止：租户有了、权限矩阵有了、**零个账号**。
       而建账号要求调用方先登录 —— 一次干净开户的结果是没人进得去。
       这条测试钉的就是那个洞。 */
    const { rows } = await o.query(
      `SELECT a.login, a.display_name, r.code AS role, p.is_initial
         FROM account a
         JOIN role r ON r.id = a.role_id
         JOIN tenant t ON t.id = a.tenant_id
         LEFT JOIN auth_password p ON p.account_id = a.id
        WHERE t.code = $1`, [CODE]);
    expect(rows).toEqual([{
      login: "admin", display_name: "系统管理员", role: "admin", is_initial: true
    }]);
  });

  it("重复开户不重置管理员口令 —— 否则每次重新开户都是一把万能钥匙", async () => {
    const hash = async () => (await o.query(
      `SELECT p.hash FROM auth_password p JOIN account a ON a.id = p.account_id
         JOIN tenant t ON t.id = a.tenant_id WHERE t.code = $1`, [CODE])).rows[0].hash;
    /* 先把口令改掉，模拟"客户装完第一件事就改了密" */
    await o.query(
      `SELECT app.set_password(a.id, $2, false) FROM account a
         JOIN tenant t ON t.id = a.tenant_id WHERE t.code = $1`,
      [CODE, "scrypt$16384$8$1$dGVzdC1zYWx0$dGVzdC1oYXNo"]);
    const changed = await hash();
    await o.query("SELECT app.provision_tenant($1, $2)", [CODE, "测试租户"]);
    expect(await hash()).toBe(changed);
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

/* ════════════════════════════════════════════════════════════════════
   `app.set_login_address` 按登录名找账号 —— 找的是**哪个租户的**。

   登录名的唯一约束是 `UNIQUE (tenant_id, login)`：**只在租户内唯一**。
   而这个函数是 SECURITY DEFINER，不受 RLS 管；0015 那一版的

     SELECT a.id INTO v_account FROM account a
      WHERE a.login = p_login AND a.status = 'active';

   没有租户条件，两个租户各有一个 `zhanghm` 时 `SELECT INTO`
   **取第一行，不报错**。于是 A 租户的管理员可以把自己的邮箱登记到
   B 租户同名账号上，再去登录页申请一次性链接 —— 跨租户接管，全程无声。

   在此之前它只有运维脚本一个调用方，而能进服务器的人本来就能连库改任意行，
   所以那时不成其为洞。0040 把它开给了 HTTP（`setLoginAddress`），
   于是那个前提没了，函数也就在同一次迁移里补上了租户条件。

   下面两条钉的是这件事的两半：**同名不串租户**，
   以及**运维脚本那条路没被这一刀误伤**（它不设会话主体）。
   ════════════════════════════════════════════════════════════════════ */
describe("app.set_login_address 的租户边界", () => {
  const CODE = "t_" + Math.random().toString(36).slice(2, 8);
  const LOGIN = "tenantedge";
  const ADDR = `${CODE}@example.cn`;
  let app, other = {}, home = {};

  beforeAll(async () => {
    app = appConn(); await app.connect();
    await o.query("SELECT app.provision_tenant($1, $2)", [CODE, "边界测试租户"]);

    /* 两个租户各建一个**同名**账号。演示租户这一个停用，
       另一个在用 —— 这正是最坏的排列：不加租户条件时，
       "找活的那一个"只会命中另一个租户。 */
    /* 停用必须同时给时间和原因（account_disabled_needs_reason）——
       "账号没了"不是审计上的答案。 */
    const mk = async (tenantCode, status) => (await o.query(
      `INSERT INTO account (tenant_id, login, display_name, role_id, status,
                            disabled_at, disabled_reason)
       SELECT t.id, $2, '同名测试', r.id, $3,
              CASE WHEN $3 = 'active' THEN NULL ELSE now() END,
              CASE WHEN $3 = 'active' THEN NULL ELSE '租户边界测试用' END
         FROM tenant t JOIN role r ON r.tenant_id = t.id AND r.code = 'crc'
        WHERE t.code = $1
       RETURNING id`, [tenantCode, LOGIN, status])).rows[0].id;
    home.id = await mk("hengji", "disabled");
    other.id = await mk(CODE, "active");

    /* 调用方：演示租户的管理员。 */
    home.admin = (await o.query(
      `SELECT a.id FROM account a JOIN tenant t ON t.id = a.tenant_id
        WHERE t.code = 'hengji' AND a.login = 'admin'`)).rows[0].id;
  });

  afterAll(async () => {
    await o.query("DELETE FROM auth_identity WHERE subject = $1", [ADDR]);
    await o.query("DELETE FROM account WHERE id = ANY($1)", [[home.id, other.id]]);
    await dropTenant(CODE);
    await app.end();
  });

  it("HTTP 那条路只在调用者自己的租户里找 —— 同名的另一家碰不到", async () => {
    const ok = await asAccount(app, home.admin, async () =>
      (await app.query("SELECT app.set_login_address($1,$2) AS ok", [LOGIN, ADDR])).rows[0].ok);

    /* 本租户那个同名账号是停用的，所以这次**就该失败**。
       失败本身不是重点 —— 重点是它没有转而命中另一个租户那个活的。 */
    expect(ok, "本租户的同名账号已停用，不该有别的账号被当成它").toBe(false);

    const { rows } = await o.query(
      "SELECT account_id FROM auth_identity WHERE subject = $1", [ADDR]);
    expect(rows, `${ADDR} 落到了别的租户的账号上 —— 那是一次跨租户接管`).toEqual([]);
  });

  it("运维脚本那条路不设会话主体，行为不变 —— 这一刀不能误伤它", async () => {
    /* `deploy/login-address.sh` 以应用角色直连，不 SET app.account_id。
       那时 `app.current_tenant_id()` 是 NULL，coalesce 让租户条件恒真。 */
    const t = await app.query("SELECT app.current_tenant_id() AS t");
    expect(t.rows[0].t, "这条测试的前提是没有会话主体").toBeNull();

    await app.query("BEGIN");
    try {
      const { rows } = await app.query(
        "SELECT app.set_login_address($1,$2) AS ok", [LOGIN, ADDR]);
      expect(rows[0].ok, "运维脚本仍应找得到那个活账号").toBe(true);
    } finally {
      await app.query("ROLLBACK");
    }
  });
});

/* ════════════════════════════════════════════════════════════════════
   访视列表的排序索引 —— 这条不能被悄悄删掉。

   它看起来只是"一条索引"，代价却不是线性的：
   没有它，默认访视列表全表扫，而 **RLS 的行谓词是每行一次函数调用**。
   18 万行实测 48 秒；有了它 15 毫秒。

   这类退化在功能测试里完全看不见（小库上两种计划一样快），
   所以至少要保证"它还在"。
   ════════════════════════════════════════════════════════════════════ */
describe("性能相关的索引", () => {
  it("subject_visit 上有按排序键建的表达式索引", async () => {
    const { rows } = await o.query(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'subject_visit' AND indexname = 'visit_feed_idx'`);
    expect(rows.length, "visit_feed_idx 不见了 —— 见迁移 0013").toBe(1);
    /* 排序键是 upper(visit_window)，不是 target_date：
       换成后者的话索引还在、计划却会退回全表扫。 */
    expect(rows[0].indexdef).toContain("upper(visit_window)");
  });
});
