/* 过期数据的清理 —— 那个「由清理任务删除」里的清理任务。
 *
 *  ── 它一直不存在 ────────────────────────────────────────────────────
 *  `idempotency_key` 的表注释从 Phase 3 起就写着「24 小时保留，之后由
 *  清理任务删除」。**那个任务从来没有被写出来。** 表只增不减，
 *  为它建的 `idempotency_key_gc_idx` 也一直没人用过。
 *  login_token 与 auth_session 同样：用过的、过期的、撤销的全都留着。
 *
 *  ── 为什么是进程里的定时器，不是 cron ──────────────────────────────
 *  cron 是第三样要部署、要监控、会被忘记开的东西，而这件事只值一行
 *  DELETE。放进进程里，它跟着服务一起部署、一起被日志看见、
 *  一起被停机流程关掉 —— 没有「忘了开」这个失败模式。
 *
 *  代价是多副本时每个实例都会到点触发，所以真正的删除动作收在
 *  `app.gc_expired()` 里，由一把咨询锁保证同一轮只有一个实例真扫
 *  （见迁移 0016）。抢不到的那些拿到 -1，安静跳过。
 */
import type { Pool } from "pg";
import { emit } from "./log.js";

export interface GcHandle { stop(): void }

/** 多久扫一次。0 = 关掉（本地开发用得上）。 */
const intervalOf = (env: NodeJS.ProcessEnv) => {
  const raw = env["SITEDESK_GC_INTERVAL_MS"]?.trim();
  if (!raw) return 60 * 60_000;
  if (!/^\d+$/.test(raw)) {
    emit("warn", "gc", `SITEDESK_GC_INTERVAL_MS=${JSON.stringify(raw)} 不是毫秒数，用默认值 1 小时`);
    return 60 * 60_000;
  }
  return Number(raw);
};

export function startGc(pool: Pool, env: NodeJS.ProcessEnv = process.env): GcHandle {
  const every = intervalOf(env);
  if (every === 0) {
    emit("info", "gc", "SITEDESK_GC_INTERVAL_MS=0：过期数据清理已关闭");
    return { stop() { /* 没开就没得关 */ } };
  }

  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const sweep = async () => {
    if (stopped) return;
    try {
      const { rows } = await pool.query<{
        idem_deleted: string; token_deleted: string; session_deleted: string;
      }>("SELECT * FROM app.gc_expired()");
      const r = rows[0]!;
      const idem = Number(r.idem_deleted), tok = Number(r.token_deleted), ses = Number(r.session_deleted);
      /* -1 = 这一轮没抢到锁（别的副本在扫）。那不是异常，也不该按 info 打 ——
         多副本下它会是绝大多数轮次的结果。 */
      if (idem < 0) return emit("debug", "gc", "这一轮由别的实例在扫，跳过");
      if (idem || tok || ses)
        emit("info", "gc", "清掉了过期数据",
          { idempotencyKeys: idem, loginTokens: tok, sessions: ses });
      else emit("debug", "gc", "没有过期数据可清");
    } catch (err) {
      /* 清理失败不该影响任何请求，但必须留声音：一个安静失败的清理任务
         和一个不存在的清理任务，在磁盘上是同一回事。 */
      emit("error", "gc", "清理过期数据失败",
        { err: err instanceof Error ? err.message : String(err) });
    }
  };

  /* 起来就先扫一次，但错开几十秒 —— 多副本同时启动时全都在第 0 秒
     去抢同一把锁，除了浪费一轮什么也得不到。 */
  const firstDelay = 20_000 + Math.floor(Math.random() * 40_000);
  const arm = (delay: number) => {
    timer = setTimeout(() => { void sweep().finally(() => { if (!stopped) arm(every); }); }, delay);
    /* unref：这个定时器不该让进程活着不肯退。 */
    timer.unref?.();
  };
  arm(firstDelay);
  emit("info", "gc", "过期数据清理已启动", { everyMs: every });

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    }
  };
}
