import { Pool, types } from "pg";

/* bigint (oid 20) 默认被 pg 返回为字符串 —— int8 可能溢出 JS 安全整数。
   本系统的金额上限是 5 亿元 = 5e10 分，远在 9e15 之内，因此可以安全地解析为数字。
   不解析的话，金额一路以字符串流到前端，某处一个 Number() 就回到浮点。
   见迁移 0006 的说明。 */
types.setTypeParser(types.builtins.INT8, (v: string) => Number(v));
/* numeric (1700) 保持字符串：系统里已不存在 numeric 金额列，
   若将来出现，宁可让它以字符串暴露出来被发现，也不要静默变成浮点。 */

export const makePool = (url = process.env.APP_DATABASE_URL) => {
  if (!url) throw new Error("缺少 APP_DATABASE_URL —— 应用必须以非 owner 角色连接，否则 RLS 形同虚设");
  return new Pool({ connectionString: url, max: 10, idleTimeoutMillis: 30_000 });
};

export const POOL = Symbol("PG_POOL");
export type { PoolClient } from "pg";
