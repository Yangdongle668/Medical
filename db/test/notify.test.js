import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { owner, appConn, accountIds, asAccount } from "./helpers.js";

/* 0055：提醒偏好与发送记录只归本人。后台任务也是以收件人本人的身份写的，
   所以这里没有"系统身份"的后门可测 —— 只有本人和别人两种。 */

let o, app, ids;
beforeAll(async () => {
  o = owner(); await o.connect();
  app = appConn(); await app.connect();
  ids = await accountIds(o);
});
afterAll(async () => {
  await o.query("DELETE FROM notify_sent"); await o.query("DELETE FROM notify_pref");
  await o.end(); await app.end();
});

describe("0055 提醒偏好 / 发送记录", () => {
  it("本人写得进、读得到；别人读不到", async () => {
    await asAccount(app, ids.wutong, async () => {
      await app.query("INSERT INTO notify_pref (account_id, digest, urgent) VALUES ($1, false, true)", [ids.wutong]);
      const { rows } = await app.query("SELECT digest FROM notify_pref");
      expect(rows).toEqual([{ digest: false }]);
      /* 事务结束会回滚 —— 这里顺手提交一份给下一条用 */
    });
    await o.query("INSERT INTO notify_pref (account_id, tenant_id, digest) SELECT id, tenant_id, false FROM account WHERE id = $1", [ids.wutong]);
    await asAccount(app, ids.linmin, async () => {
      expect((await app.query("SELECT * FROM notify_pref")).rows).toEqual([]);
    });
  });

  it("别人的名义写不进去", async () => {
    await asAccount(app, ids.linmin, async () => {
      await expect(app.query(
        "INSERT INTO notify_pref (account_id, digest, urgent) VALUES ($1, true, true)", [ids.wutong]))
        .rejects.toThrow(/row-level security/);
    });
  });

  it("同一件事同一个档只落一行（去重靠主键）", async () => {
    await asAccount(app, ids.wutong, async () => {
      const ins = () => app.query(
        `INSERT INTO notify_sent (account_id, item_key, mark) VALUES ($1, 'sae:x', '12h')
         ON CONFLICT DO NOTHING RETURNING item_key`, [ids.wutong]);
      expect((await ins()).rowCount).toBe(1);
      expect((await ins()).rowCount).toBe(0);
    });
  });

  it("收件人名单：只有有邮箱的在用内部账号；关掉两个开关的人不在里面", async () => {
    const { rows } = await o.query("SELECT account_id FROM app.notify_recipients()");
    const got = new Set(rows.map(r => r.account_id));
    expect(got.has(ids.wutong)).toBe(true);                // 摘要关了、紧急还开着
    expect(got.has(ids.zhanghm), "外部角色不该收").toBe(false);
    expect(got.has(ids.zhouqi), "没登记邮箱的不在名单里").toBe(false);
    await o.query("UPDATE notify_pref SET urgent = false WHERE account_id = $1", [ids.wutong]);
    const again = new Set((await o.query("SELECT account_id FROM app.notify_recipients()")).rows.map(r => r.account_id));
    expect(again.has(ids.wutong)).toBe(false);
  });
});
