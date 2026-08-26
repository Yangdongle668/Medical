import { Pool, types } from "pg";
import { emit } from "./log.js";

/* bigint (oid 20) 默认被 pg 返回为字符串 —— int8 可能溢出 JS 安全整数。
   本系统的金额上限是 5 亿元 = 5e10 分，远在 9e15 之内，因此可以安全地解析为数字。
   不解析的话，金额一路以字符串流到前端，某处一个 Number() 就回到浮点。
   见迁移 0006 的说明。 */
types.setTypeParser(types.builtins.INT8, (v: string) => Number(v));
/* numeric (1700) 保持字符串：系统里已不存在 numeric 金额列，
   若将来出现，宁可让它以字符串暴露出来被发现，也不要静默变成浮点。 */

export const makePool = (url = process.env.APP_DATABASE_URL) => {
  if (!url) throw new Error("缺少 APP_DATABASE_URL —— 应用必须以非 owner 角色连接，否则 RLS 形同虚设");
  const pool = new Pool({ connectionString: url, max: 10, idleTimeoutMillis: 30_000 });

  /* **这一行的缺席会让数据库每重启一次就杀掉一次 API 进程。**
     `pg.Pool` 在**空闲连接**出错时发 `error` 事件（数据库重启、主备切换、
     管理员 pg_terminate_backend，都会让空闲连接被服务端掐断）。
     EventEmitter 的规矩是：没有人监听 `error`，就当作未捕获异常抛出 ——
     于是 Node 直接退进程。

     实测：`pg_ctlcluster stop` 之后进程立刻死掉，
       error: terminating connection due to administrator command
       Emitted 'error' event on BoundPool instance
     一次计划内的数据库维护，就此变成一轮崩溃循环。

     接住它就够了：池子自己会丢弃坏掉的连接、按需重建。
     进程要做的只是**活着**，等数据库回来 —— 那正是存活探针的意思。 */
  pool.on("error", (err) => {
    emit("error", "pool", "空闲连接出错（已丢弃该连接，进程继续）", { err: err.message });
  });

  return pool;
};

export const POOL = Symbol("PG_POOL");
export type { PoolClient } from "pg";
