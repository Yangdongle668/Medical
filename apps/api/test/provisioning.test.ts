import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resetDb } from "./harness.js";
import pg from "pg";

/* ════════════════════════════════════════════════════════════════════
   开户（欠账 D3）。

   `provision_tenant` 原来只给**权限模型**：租户 + 八个角色 + 授予。
   开完之后新租户能登录、能看见界面，但一件事也做不了 ——
   建中心会因为启动清单模板是空的被拒，填工时会因为没有生效的费率卡被拒。

   这一组验的不是"函数跑通了"，而是**开完户之后真的能开始干活**。
   ════════════════════════════════════════════════════════════════════ */

let db: pg.Client;
beforeAll(async () => {
  resetDb();
  db = new pg.Client({ connectionString: process.env["TEST_DATABASE_URL"] });
  await db.connect();
}, 120_000);
afterAll(async () => { await db?.end(); });

/** 在一个回滚掉的事务里开一户 —— 不污染别的用例。 */
async function inRollback<T>(fn: () => Promise<T>): Promise<T> {
  await db.query("BEGIN");
  try { return await fn(); } finally { await db.query("ROLLBACK"); }
}

describe("开户：开完之后要真的能开始干活", () => {
  it("权限模型 + 业务配置一次给齐", async () => {
    await inRollback(async () => {
      const { rows } = await db.query<{ id: string }>(
        "SELECT app.provision_tenant('t-new', '新开的一家') AS id");
      const t = rows[0]!.id;

      const n = async (sql: string) =>
        Number((await db.query<{ c: string }>(sql, [t])).rows[0]!.c);

      expect(await n("SELECT count(*) AS c FROM role WHERE tenant_id = $1")).toBe(9);
      /* 这两项是这条欠账的正题：在此之前它们都是 0 */
      expect(await n("SELECT count(*) AS c FROM startup_template_item WHERE tenant_id = $1"))
        .toBe(16);
      expect(await n("SELECT count(*) AS c FROM rate_card WHERE tenant_id = $1")).toBe(5);
      /* **开完之后要有人能登进去。** 在此之前这里是 0 个账号，
         而建账号的接口要求调用方先登录 —— 开完户没人打得开门。
         这一行是那句"要真的能开始干活"里最基本的一条。 */
      expect(await n("SELECT count(*) AS c FROM account WHERE tenant_id = $1")).toBe(1);
      expect(await n(`SELECT count(*) AS c FROM auth_password p
                        JOIN account a ON a.id = p.account_id
                       WHERE a.tenant_id = $1 AND p.is_initial`)).toBe(1);
    });
  });

  it("启动清单模板里有阻塞项 —— 一份没有阻塞项的模板等于把 SIV 闸门关掉", async () => {
    await inRollback(async () => {
      const { rows } = await db.query<{ id: string }>(
        "SELECT app.provision_tenant('t-gate', '闸门验证') AS id");
      const { rows: b } = await db.query<{ c: string }>(
        `SELECT count(*) AS c FROM startup_template_item
          WHERE tenant_id = $1 AND is_blocking`, [rows[0]!.id]);
      expect(Number(b[0]!.c)).toBeGreaterThan(0);
    });
  });

  it("费率卡是**占位**，而且 note 里说了它必须被改掉", async () => {
    /* 一个不带说明的数字会被当成"系统给的标准"，然后一直用下去 ——
       而成本口径错了，这个系统在钱这一侧输出的每一个数都是错的。 */
    await inRollback(async () => {
      const { rows } = await db.query<{ id: string }>(
        "SELECT app.provision_tenant('t-rate', '费率验证') AS id");
      const { rows: r } = await db.query<{ note: string; level: string | null }>(
        "SELECT note, level FROM rate_card WHERE tenant_id = $1", [rows[0]!.id]);
      expect(r.length).toBe(5);
      for (const x of r) {
        expect(x.note).toContain("必须");
        /* 只开不分级别的通用行 —— 分级别的那几档更需要客户自己定 */
        expect(x.level).toBeNull();
      }
    });
  });

  it("**重新开一次户不覆盖客户改过的东西**", async () => {
    await inRollback(async () => {
      const { rows } = await db.query<{ id: string }>(
        "SELECT app.provision_tenant('t-idem', '幂等验证') AS id");
      const t = rows[0]!.id;

      /* 客户改了费率，并发布了第二版启动清单模板 */
      await db.query(
        "UPDATE rate_card SET day_cost_cents = 987654 WHERE tenant_id = $1", [t]);
      await db.query(
        `INSERT INTO startup_template_item
           (tenant_id, version, sort_order, category, item, is_blocking, due_offset, reason)
         VALUES ($1, 2, 0, 'ethics', '客户自己定的第一项', true, -10, '客户改的')`, [t]);

      await db.query("SELECT app.provision_tenant('t-idem', '幂等验证')");

      const { rows: rc } = await db.query<{ day_cost_cents: string }>(
        "SELECT day_cost_cents FROM rate_card WHERE tenant_id = $1 LIMIT 1", [t]);
      expect(Number(rc[0]!.day_cost_cents),
        "重新开户把客户改过的费率覆盖回占位值了").toBe(987654);

      const { rows: v } = await db.query<{ v: number }>(
        "SELECT app.startup_template_version() AS v");
      expect(v.length).toBe(1);
      const { rows: keep } = await db.query<{ c: string }>(
        `SELECT count(*) AS c FROM startup_template_item
          WHERE tenant_id = $1 AND version = 2`, [t]);
      expect(Number(keep[0]!.c), "客户发布的第二版被抹掉了").toBe(1);
    });
  });

  it("SOA **不在**开户里 —— 新租户还没有项目，没有东西可挂", async () => {
    /* 硬塞一份编出来的访视计划比没有更危险：它看起来是真的。
       SOA 在建项目时由 replaceSoa 录入（迁移 0020）。 */
    await inRollback(async () => {
      const { rows } = await db.query<{ id: string }>(
        "SELECT app.provision_tenant('t-soa', 'SOA 验证') AS id");
      const { rows: c } = await db.query<{ c: string }>(
        `SELECT count(*) AS c FROM visit_template vt
           JOIN study st ON st.id = vt.study_id
          WHERE st.tenant_id = $1`, [rows[0]!.id]);
      expect(Number(c[0]!.c)).toBe(0);
    });
  });
});
