/* ════════════════════════════════════════════════════════════════════
   业务日历：「今天」是**业务所在地**的今天，不是服务器的今天。

   ── 两个时区，各管各的 ──────────────────────────────────────────
   · 进程时区必须是 UTC（preflight.ts 拦着）：node-postgres 把 `date` 列
     解析成进程本地零点，`day()` 再按 UTC 切成字符串 —— 进程若在东八区，
     库里的 09-09 会读成 09-08。那一条不动。
   · 「今天」要按业务时区算：一线在北京早上七点问"今天到期的是哪几个"，
     答案是北京的今天。原来各服务写 `new Date().toISOString().slice(0, 10)`、
     SQL 写 `CURRENT_DATE`（数据库会话默认 UTC）—— **每天 0–8 点它是昨天**：
     今天关窗的访视显示"还剩 1 天"，窗口昨天关掉的还不算超窗，
     而首页待办、邮件提醒、超窗判定全都读这一个"今天"。

   所以：JS 里的「今天」只从这里取；SQL 里的 `CURRENT_DATE` 靠每个事务开头的
   `set_config('TimeZone', …, true)`（请求中间件与 runAs 都做）。两边同一个时区。

   时区由 SITEDESK_TZ 给（默认 Asia/Shanghai）。**每次读环境变量**，不缓存 ——
   测试要在同一个进程里换时区验证它真的生效。
   ════════════════════════════════════════════════════════════════════ */

export const DEFAULT_TZ = "Asia/Shanghai";

export const bizTz = (env: NodeJS.ProcessEnv = process.env) =>
  env["SITEDESK_TZ"]?.trim() || DEFAULT_TZ;

/** 这个时区名认不认得。认不得的话每个请求开头那句 set_config 都会失败。 */
export function validTz(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-CA", { timeZone: tz }); return true; }
  catch { return false; }
}

/** 业务时区里某一刻是哪一天，`YYYY-MM-DD`。 */
export function localDate(at: Date, tz = bizTz()): string {
  /* en-CA 的日期格式恰好就是 YYYY-MM-DD */
  return new Intl.DateTimeFormat("en-CA",
    { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** 业务时区的今天。 */
export const todayLocal = (now: Date = new Date()) => localDate(now);

/** 日历日加减（纯日期运算，与时区无关）。 */
export function plusDays(iso: string, n: number): string {
  const t = new Date(iso + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** 业务时区的今天，表示成**那一天的 UTC 零点** —— 与库里读出来的 `date` 列同一个表示法
 *  （进程是 UTC，node-postgres 把 date 解析成 UTC 零点），传给按天相减的函数用。
 *  **不要**拿它当"此刻"：SAE 的 24 小时之类按小时走的，用真的 new Date()。 */
export const todayDate = (now: Date = new Date()) => new Date(todayLocal(now) + "T00:00:00Z");
