import pg from "pg";

/** owner 连接：绕过 RLS。用于准备数据、以及验证"策略之外的真相"。 */
export function owner() {
  return new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
}
/** 应用连接：非 owner，RLS 真实生效。测 RLS 只能用它 —— 用 owner 测会全绿，但什么也没证明。 */
export function appConn() {
  return new pg.Client({ connectionString: process.env.APP_TEST_DATABASE_URL });
}

/** 登录名 → account id。
 *  真实系统里这个 id 来自 OIDC 令牌，不是由请求自己查库得到的
 *  （account 表本身带 RLS，未设身份时查不到自己）。测试照此模拟：用 owner 预解析。 */
export async function accountIds(o) {
  const { rows } = await o.query("SELECT login, id FROM account");
  return Object.fromEntries(rows.map(r => [r.login, r.id]));
}

/** 以某个身份执行一段查询 —— 模拟应用在每个请求开始时的 SET LOCAL app.account_id。
 *  事务结束即回滚，测试之间互不污染。 */
export async function asAccount(client, accountId, fn) {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.account_id', $1, true)", [accountId ?? ""]);
    return await fn();
  } finally {
    await client.query("ROLLBACK");
  }
}

export const TENANT = "00000000-0000-0000-0000-000000000001";
