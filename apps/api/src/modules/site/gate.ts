import type { PoolClient } from "pg";

/* ════════════════════════════════════════════════════════════════════
   中心状态机闸门。

   推进不是给字段赋值，而是断言一组前置条件已经成立。

   本阶段只有 study_site 一张业务表，因此七项关闭条件里的绝大多数
   依赖尚未交付的模块。**这种情况下必须 fail-closed**：
   把「查不了」当成「通过」，就等于允许在质疑挂着、药品差三盒的时候关闭中心 ——
   而这正是原型里那个只有一句 `ss.st = next` 的按钮所犯的错。

   因此未就绪的检查项以 `unavailable` 出现在 unmet 里，闸门不放行。
   每个模块交付时把自己的检查项接进这张表。
   ════════════════════════════════════════════════════════════════════ */

export type GateStatus = "ok" | "unmet" | "unavailable";
export interface GateItem { code: string; message: string; module?: string; status: GateStatus }

type Checker = (client: PoolClient, siteId: string) => Promise<GateItem>;

/** 尚未交付的模块占位。交付时把这一行换成真实查询即可。 */
const pending = (code: string, what: string, mod: string): Checker =>
  async () => ({ code, module: mod, status: "unavailable",
    message: `${what}（该检查由「${mod}」模块提供，尚未交付 —— 闸门保持关闭）` });

/** 推进到「SIV启动」：启动清单的阻塞项必须清零。
 *  这一项曾是 pending 占位，Site & Staffing 交付后换成了真实查询 ——
 *  每个模块交付时都该这样把自己的检查项接进来。 */
const sivBlockers: Checker = async (client, siteId) => {
  const { rows } = await client.query<{ item: string }>(
    `SELECT item FROM startup_item
      WHERE study_site_id = $1 AND is_blocking AND done_at IS NULL
      ORDER BY sort_order LIMIT 5`, [siteId]);
  const { rows: cnt } = await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM startup_item
      WHERE study_site_id = $1 AND is_blocking AND done_at IS NULL`, [siteId]);
  const n = Number(cnt[0]?.n ?? 0);
  if (n === 0) return { code: "startup-blockers", status: "ok", message: "启动阻塞项已清零" };
  return {
    code: "startup-blockers", module: "startup", status: "unmet",
    message: `启动清单仍有 ${n} 项阻塞未完成：` +
      rows.map(r => r.item).join("；") + (n > rows.length ? " 等" : "")
  };
};

const SIV_CHECKS: Checker[] = [sivBlockers];

/** 计数型检查的公共形状：为 0 才放行，不为 0 时把数目说清楚。 */
const counted = (
  code: string, mod: string, ok: string,
  sql: string, unmet: (n: number) => string
): Checker => async (client, siteId) => {
  const { rows } = await client.query<{ n: string }>(sql, [siteId]);
  const n = Number(rows[0]?.n ?? 0);
  return n === 0
    ? { code, status: "ok", message: ok }
    : { code, module: mod, status: "unmet", message: unmet(n) };
};

/** 推进到「中心关闭」：八项前置条件。ClinicalOps 交付后四项变成真查询。 */
const CLOSE_CHECKS: Checker[] = [
  counted("subjects-in-trial", "clinical", "全部受试者已出组",
    `SELECT count(*) AS n FROM subject
      WHERE study_site_id = $1 AND state IN ('screening','enrolled')`,
    n => `仍有 ${n} 例受试者在组或在筛未出组 —— 中心一关，他们的随访就无人接续`),

  counted("open-queries", "clinical", "数据质疑已全部关闭",
    `SELECT count(*) AS n FROM quality_event
      WHERE study_site_id = $1 AND kind = 'query' AND state <> 'closed'`,
    n => `仍有 ${n} 条数据质疑未关闭 —— 带着质疑锁库，锁的是一份自己都不认的数据`),

  counted("open-quality", "quality", "质量事件已全部关闭",
    `SELECT count(*) AS n FROM quality_event
      WHERE study_site_id = $1 AND kind <> 'query' AND state <> 'closed'`,
    n => `仍有 ${n} 件质量事件（含方案偏离）未关闭`),

  counted("compensation-open", "clinical", "受试者补偿已全部发放并留有签收凭证",
    `SELECT count(*) AS n FROM subject_payment
      WHERE study_site_id = $1 AND paid_on IS NULL`,
    n => `仍有 ${n} 笔受试者补偿未发放或缺签收凭证`),

  /* 以下四项依赖尚未交付的模块，保持 fail-closed */
  pending("ip-imbalance",      "药品数量不平衡",             "clinical"),
  pending("ip-not-destroyed",  "回收药品未完成销毁登记",     "clinical"),
  pending("specimen-open",     "生物样本链未闭环",           "clinical"),
  pending("closeout-report",   "未向伦理递交结题报告或尚未获批", "regulatory")
];

const REGISTRY: Record<string, Checker[]> = { siv: SIV_CHECKS, closed: CLOSE_CHECKS };

export async function evaluateGate(
  client: PoolClient, siteId: string, to: string
): Promise<{ satisfied: boolean; items: GateItem[] }> {
  const checks = REGISTRY[to] ?? [];
  /* 顺序执行，不用 Promise.all：这些检查共用请求事务的那一条连接，
     并发发出去 pg 也只会排队，换不来速度，却会让语句在同一个事务里交错。 */
  const items: GateItem[] = [];
  for (const c of checks) items.push(await c(client, siteId));
  return { satisfied: items.every(i => i.status === "ok"), items };
}

/** 状态机的下一节点 */
export async function nextState(client: PoolClient, current: string): Promise<string | null> {
  const { rows } = await client.query<{ code: string }>(
    `SELECT code FROM site_state WHERE seq = (SELECT seq + 1 FROM site_state WHERE code = $1)`,
    [current]);
  return rows[0]?.code ?? null;
}
