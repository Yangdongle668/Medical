import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { owner } from "./helpers.js";

/* ════════════════════════════════════════════════════════════════════
   在筛的人必须有筛选期访视 —— 没有的那一例，除了作废没有出路。

   ── 现场报来的原话 ────────────────────────────────────────────────
     「但是页面没有可以操作的按钮，只有一个脱落」

   那一行是 `筛选中`、`0/0`、下一次访视空白。入组要求筛选期访视已完成
   并登记 PI 确认，而它连访视都没有；访视只能由「签署知情同意」那一下
   排出来，而知情已经签过，不会再签第二次。

   种子里这样的人有 14 位 —— 漏斗计数展开成受试者行时只插了受试者，
   没插访视。而真实流程里 `signIcf` 一定会连它一起排出来。
   于是**演示数据与代码路径给出的不是同一个世界**，而只有走到入组那一步
   才看得见。迁移 0053 把存量补上了，生成器那边也补上了。

   这一组钉的是"补上了"这件事本身 —— 服务层的 fail-closed 由
   apps/api/test/clinical.test.ts 那两条盯着，这里盯的是**库里的事实**：
   种子灌完、迁移跑完之后，一个死角都不许剩。
   ════════════════════════════════════════════════════════════════════ */

let o;
beforeAll(async () => { o = owner(); await o.connect(); });
afterAll(async () => { await o.end(); });

const tx = async fn => {
  await o.query("BEGIN");
  try { return await fn(); } finally { await o.query("ROLLBACK"); }
};

/** 死角的判据 —— **一条 SQL，两处使用**：
 *  一处断言真实数据里是 0 条，一处证明这条判据不是恒为 0 的。 */
const DEAD_END_SQL = `
  SELECT s.screening_no FROM subject s
   WHERE s.state = 'screening'
     AND NOT EXISTS (SELECT 1 FROM subject_visit v
                      WHERE v.subject_id = s.id AND v.seq = 0)
   ORDER BY 1`;

describe("在筛却没有筛选期访视 —— 这种行一条都不该有", () => {
  it("**种子与迁移跑完，死角是 0 条**", async () => {
    const { rows } = await o.query(DEAD_END_SQL);
    expect(rows.map(r => r.screening_no)).toEqual([]);
    /* 上面那句在 subject 表为空时也是绿的 —— 所以顺手证明它确实在看数据。 */
    const { rows: n } = await o.query(
      `SELECT count(*)::int AS n FROM subject WHERE state = 'screening'`);
    expect(n[0].n).toBeGreaterThan(0);
  });

  it("判据不是恒为 0 的 —— 造一例出来，它数得出来", () =>
    tx(async () => {
      const { rows } = await o.query(`
        INSERT INTO subject (study_site_id, screening_no, state, icf_signed_on, crc_account_id)
        SELECT s.study_site_id, 'DEAD-END-1', 'screening', CURRENT_DATE, s.crc_account_id
          FROM subject s WHERE s.state = 'screening' LIMIT 1
        RETURNING screening_no`);
      expect(rows[0].screening_no).toBe("DEAD-END-1");
      const dead = await o.query(DEAD_END_SQL);
      expect(dead.rows.map(r => r.screening_no)).toEqual(["DEAD-END-1"]);
    }));

  it("**筛选期访视的目标日就是知情签署日** —— SOA 的 seq 0 offset 是 0", async () => {
    /* 原来这一行是 `anchor='icf', offset_days=-14`：目标日落在签知情之前
       两周，于是 `signIcf` 排出来的筛选期访视一生下来就超窗十天，
       而超窗完成必须生成方案偏离（I4）—— 每登记一个新受试者，
       系统都会给他凭空记一条偏离。

       这个 -14 不是原型定的：原型的 SOA 只给了 cycle / win / last /
       label / tasks，一个 offset 都没有。而 seq 0 的任务清单第一项就是
       「知情同意签署」—— 这次访视本来就发生在签知情那一天前后。 */
    const { rows } = await o.query(
      `SELECT anchor, offset_days, count(*)::int AS n FROM visit_template
        WHERE seq = 0 GROUP BY 1, 2 ORDER BY 1, 2`);
    expect(rows).toEqual([{ anchor: "icf", offset_days: 0, n: rows[0].n }]);
    expect(rows[0].n).toBeGreaterThan(0);      // 每个项目都得有筛选期那一行
  });

  it("每个项目都配了 seq 0 —— 缺的那个项目一签知情就造出死角", async () => {
    const { rows } = await o.query(`
      SELECT st.code FROM study st
       WHERE NOT EXISTS (SELECT 1 FROM visit_template t
                          WHERE t.study_id = st.id AND t.seq = 0)
       ORDER BY 1`);
    expect(rows.map(r => r.code)).toEqual([]);
  });
});
