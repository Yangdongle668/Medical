import type { PoolClient } from "pg";

/* ════════════════════════════════════════════════════════════════════
   中心状态机闸门。

   推进不是给字段赋值，而是断言一组前置条件已经成立。

   ── 关于 fail-closed，以及它的代价 ────────────────────────────────
   闸门早期有一半检查项背后的表还没建，那时它们以 `unavailable` 出现，
   闸门不放行。**那是对的**：把「查不了」当成「通过」，就等于允许在
   质疑挂着、药品差三盒的时候关闭中心 —— 正是原型里那个只有一句
   `ss.st = next` 的按钮所犯的错。

   但 fail-closed 只在**有人真的会去把它变成 ok** 的前提下才是把关。
   四个占位挂了五个阶段之后，它的现实后果是「没有任何一个中心关得掉」：
   闸门看起来在把关，实际是一堵墙 —— 而一堵墙教会用户的是绕过它。

   迁移 0017 建起了药品流水、生物样本、伦理递交三张表，
   最后四个占位换成了四条真查询。**现在这里没有占位了**：
   八项关闭条件全部有数据出处，每一项都答得出「凭什么」。
   再加检查项时，要么带着它的数据一起来，要么别加。
   ════════════════════════════════════════════════════════════════════ */

export type GateStatus = "ok" | "unmet" | "unavailable";
export interface GateItem { code: string; message: string; module?: string; status: GateStatus }

type Checker = (client: PoolClient, siteId: string) => Promise<GateItem>;

/** 推进到「SIV启动」：启动清单的阻塞项必须清零。 */
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

/** 推进到「中心关闭」：八项前置条件，全部是真查询。 */
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

  /* ── 以下四项由迁移 0017 的三张表支撑（原为占位，见文件头） ────── */

  /* 账不平：发出去的比收到的多。这不是"少了几盒"，是**记账错了** ——
     先查清楚再谈关闭，因为关了之后就再也查不清了。 */
  async (client, siteId) => {
    const { rows } = await client.query<{ n: string }>(
      "SELECT app.ip_balance($1) AS n", [siteId]);
    const n = Number(rows[0]?.n ?? 0);
    return n >= 0
      ? { code: "ip-imbalance", status: "ok", message: "药品台账平" }
      : { code: "ip-imbalance", module: "clinical", status: "unmet",
          message: `药品台账不平：算出来是 ${n}，发出去的比收到的多 ${-n} —— ` +
            "先把流水补齐或找出差在哪，关了中心就查不清了" };
  },

  /* 还有药在中心手里。关闭前必须有个去处：退回申办方，或就地销毁并登记。 */
  async (client, siteId) => {
    const { rows } = await client.query<{ n: string }>(
      "SELECT app.ip_balance($1) AS n", [siteId]);
    const n = Number(rows[0]?.n ?? 0);
    return n <= 0
      ? { code: "ip-not-destroyed", status: "ok", message: "药品已清零（退回或销毁登记完毕）" }
      : { code: "ip-not-destroyed", module: "clinical", status: "unmet",
          message: `中心还有 ${n} 份药品在手 —— 退回申办方或登记销毁之后才能关闭` };
  },

  counted("specimen-open", "clinical", "生物样本链已闭环",
    `SELECT count(*) AS n FROM specimen
      WHERE study_site_id = $1 AND received_on IS NULL AND discarded_on IS NULL`,
    n => `仍有 ${n} 管样本既没被实验室确认收到、也没有销毁登记 —— ` +
         "中心一关，它们在哪就再也查不清了"),

  /* 递交了但没批下来 ≠ 可以关。这一项看的是**批复**。 */
  async (client, siteId) => {
    const { rows } = await client.query<{ decision: string | null }>(
      `SELECT decision FROM regulatory_submission
        WHERE study_site_id = $1 AND kind = 'closeout'
        ORDER BY submitted_on DESC LIMIT 1`, [siteId]);
    const d = rows[0]?.decision ?? null;
    if (d === "approved")
      return { code: "closeout-report", status: "ok", message: "结题报告已获伦理批准" };
    return {
      code: "closeout-report", module: "regulatory", status: "unmet",
      message: d === null ? "尚未向伦理递交结题报告"
        : d === "pending" ? "结题报告已递交，伦理尚未批复 —— 批下来才能关"
        : "结题报告被伦理退回，需要重新递交"
    };
  }
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
