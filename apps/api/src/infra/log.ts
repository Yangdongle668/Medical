import type { LoggerService } from "@nestjs/common";
import { ctxOrNull } from "./ctx.js";

/* ════════════════════════════════════════════════════════════════════
   结构化日志 —— 一行一条 JSON。

   ── 为什么不能继续用 Nest 默认那套 ──────────────────────────────────
   默认格式长这样：

     [Nest] 42  - 2026/08/26 10:11:12   WARN [QueryCount] 发了 47 条 SQL

   人读着舒服，机器读着要正则。而线上真正要做的事是**按请求把散落在
   各处的行拼回一条时间线**：这个 500 是哪个请求？它之前那条 N+1 告警
   是不是同一个请求发的？是谁在什么范围下打的？

   默认格式里没有请求 ID —— 一个字段都没有，于是这件事根本做不了。
   拼不回时间线，日志就只剩"事后翻着看"的价值。

   所以这里做两件事：
     ① 每条日志是一行 JSON，字段固定：ts / level / scope / msg
     ② **自动带上请求上下文**：requestId / operationId / accountId / role
        —— 从 AsyncLocalStorage 里取，调用方什么都不用传。
        靠传参的话，迟早有一条路径漏传，而漏传的那条正是要查的那条。

   ── 三条约束 ────────────────────────────────────────────────────────
   · **一条记录一行。** msg 里的换行由 JSON.stringify 转义成 \n，
     多行的启动自检信息也仍然是一行 —— 采集器按行切分不会把它切碎。
   · **日志绝不抛异常。** 它经常在异常处理路径上被调用（ProblemFilter、
     pool 的 error 事件）；在那里抛，等于把一个能看见的错误换成一个
     看不见的崩溃。所以序列化全程兜底。
   · **格式与级别按次读环境变量。** 做成模块级常量的话，import 那一刻
     就定死了，测试在 beforeAll 里设的变量根本不生效 ——
     那样的测试只有在命令行预先设了变量时才绿，是靠外部条件通过的。
   ════════════════════════════════════════════════════════════════════ */

export type Level = "debug" | "info" | "warn" | "error";

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** json（机器）/ pretty（人）。默认：生产 json，其余 pretty。 */
function format(): "json" | "pretty" {
  const v = (process.env["SITEDESK_LOG_FORMAT"] ?? "").toLowerCase();
  if (v === "json" || v === "pretty") return v;
  return (process.env["NODE_ENV"] ?? "").toLowerCase() === "production" ? "json" : "pretty";
}

/** 低于这个级别的丢掉。默认 info —— debug 是给排查时临时打开的。 */
function threshold(): number {
  const v = (process.env["SITEDESK_LOG_LEVEL"] ?? "").toLowerCase();
  return v in RANK ? RANK[v as Level] : RANK.info;
}

/** 序列化，且**保证不抛**。
 *
 *  两个真会遇到的坑：
 *    · bigint —— JSON.stringify 直接 TypeError；
 *    · 循环引用 —— 往日志里塞一个 Error 或 request 对象就会撞上。
 *  用 WeakSet 挡循环会把「同一个对象出现两次」也标成 circular，
 *  略保守，但日志宁可少一点也不能因为一条记录把进程带走。 */
function toLine(rec: Record<string, unknown>): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(rec, (_k, v: unknown) => {
      if (typeof v === "bigint") return v.toString();
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[circular]";
        seen.add(v);
      }
      return v;
    });
  } catch (e) {
    /* 兜底行本身必须能序列化：只放字符串。 */
    return JSON.stringify({
      ts: String(rec["ts"]), level: "error", scope: "log",
      msg: `日志序列化失败：${e instanceof Error ? e.message : String(e)}`,
      original: String(rec["msg"])
    });
  }
}

/** 单个值 → 一段 JSON，同样保证不抛。 */
const jsonOf = (v: unknown): string => {
  const line = toLine({ v });
  /* toLine 出来的是 {"v":…}，去掉外壳；兜底行不长这样，那就原样返回。 */
  return line.startsWith('{"v":') && line.endsWith("}") ? line.slice(5, -1) : line;
};

const PAD: Record<Level, string> = { debug: "DEBUG", info: "INFO ", warn: "WARN ", error: "ERROR" };

/** 人读的那一版。字段跟在后面，顺序与 JSON 一致，便于对照。 */
function toPretty(rec: Record<string, unknown>): string {
  const { ts, level, scope, msg, ...rest } = rec as
    { ts: string; level: Level; scope: string; msg: string } & Record<string, unknown>;
  const tail = Object.entries(rest)
    /* undefined 在 JSON 那边会被直接丢掉，pretty 也跟着丢 ——
       否则同一条记录两种格式下字段不一样，对照的时候会以为漏了东西。 */
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : jsonOf(v)}`)
    .join(" ");
  return `${ts} ${PAD[level]} [${scope}] ${msg}${tail ? "  " + tail : ""}`;
}

/** 写出去。error 走 stderr，其余走 stdout —— 容器里两条流都会被采集，
 *  但分开之后 `2>/dev/null` 这类习惯用法仍然管用。 */
function write(level: Level, text: string): void {
  const s = level === "error" ? process.stderr : process.stdout;
  try { s.write(text + "\n"); } catch { /* 管道断了不该反过来杀掉进程 */ }
}

/** 唯一的写入口。所有日志 —— Nest 自己的、我们自己的 —— 都从这里出去。 */
export function emit(
  level: Level, scope: string, msg: string, fields: Record<string, unknown> = {}
): void {
  if (RANK[level] < threshold()) return;
  const c = ctxOrNull();
  const rec: Record<string, unknown> = {
    ts: new Date().toISOString(), level, scope, msg,
    ...(c ? {
      requestId: c.requestId,
      ...(c.operationId ? { operationId: c.operationId } : {}),
      ...(c.principal ? { accountId: c.principal.accountId, role: c.principal.roleCode } : {})
    } : {}),
    ...fields
  };
  write(level, format() === "json" ? toLine(rec) : toPretty(rec));
}

/** 任意值 → 一句话。Error 用堆栈（堆栈里已含 message）。 */
function asMessage(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.stack ?? `${v.name}: ${v.message}`;
  if (v === undefined) return "undefined";
  try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
}

/**
 * Nest 的日志接口适配到 emit。
 *
 * Nest 的 `Logger` 包装类在转发给底层 LoggerService 时会**把 context 追加在
 * 最后一个参数**（`localInstance.warn(message, ...params, this.context)`），
 * 所以这里的规矩是：最后一个字符串参数是 scope，剩下的进 details。
 * `error(message, stack, context)` 的 stack 就是这样落进 details 的。
 */
export class JsonLogger implements LoggerService {
  log(message: unknown, ...rest: unknown[]): void { this.at("info", message, rest); }
  warn(message: unknown, ...rest: unknown[]): void { this.at("warn", message, rest); }
  error(message: unknown, ...rest: unknown[]): void { this.at("error", message, rest); }
  debug(message: unknown, ...rest: unknown[]): void { this.at("debug", message, rest); }
  verbose(message: unknown, ...rest: unknown[]): void { this.at("debug", message, rest); }
  fatal(message: unknown, ...rest: unknown[]): void { this.at("error", message, rest); }

  private at(level: Level, message: unknown, rest: unknown[]): void {
    const args = [...rest];
    const last = args[args.length - 1];
    const scope = typeof last === "string" ? (args.pop() as string) : "app";
    const fields = args.length ? { details: args.map(asMessage) } : {};
    emit(level, scope, asMessage(message), fields);
  }
}
