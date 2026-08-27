import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { emit, JsonLogger } from "../src/infra/log.js";
import { runInCtx, type RequestCtx } from "../src/infra/ctx.js";
import type { PoolClient } from "pg";
import { EMPTY_SCOPE } from "@sitedesk/policy";

/* ════════════════════════════════════════════════════════════════════
   结构化日志。

   这一组不测"日志好不好看"，测的是**它还能不能被机器读回去**：
     · 一条记录一行 —— 换行、多行的启动自检信息都不许把记录切碎
     · 每条都能 JSON.parse —— 否则采集管道整条断掉
     · **带得上 requestId** —— 这是全部意义所在：
       线上排查靠它把散在各处的行拼回一条时间线。
       没有这个字段，结构化就只是把好看的格式换成了难看的格式。
     · 绝不抛异常 —— 它经常在异常处理路径上被调用，
       在那里抛，等于把一个能看见的错误换成一个看不见的崩溃。

   验过它不是空的：把 emit 里那段"从上下文取 requestId"删掉，
   立刻红成 `expected undefined to be 'req-1'`。
   ════════════════════════════════════════════════════════════════════ */

/** 抓真正写进 stdout / stderr 的字节 —— 不是抓某个可替换的 sink。
 *  换成 sink 的话，测的就是那个 sink，而不是这条真的会跑的路径。 */
function capture() {
  const out: string[] = [], err: string[] = [];
  const so = vi.spyOn(process.stdout, "write").mockImplementation(((c: string) => {
    out.push(String(c)); return true;
  }) as typeof process.stdout.write);
  const se = vi.spyOn(process.stderr, "write").mockImplementation(((c: string) => {
    err.push(String(c)); return true;
  }) as typeof process.stderr.write);
  return {
    out, err,
    /** 所有流的所有输出，按行切开（末尾空行去掉） */
    lines: () => [...out, ...err].join("").split("\n").filter(l => l !== ""),
    restore: () => { so.mockRestore(); se.mockRestore(); }
  };
}

let cap: ReturnType<typeof capture>;
const env = { ...process.env };

beforeEach(() => {
  process.env["SITEDESK_LOG_FORMAT"] = "json";
  delete process.env["SITEDESK_LOG_LEVEL"];
  cap = capture();
});
afterEach(() => {
  cap.restore();
  process.env = { ...env };
});

const fakeCtx = (over: Partial<RequestCtx> = {}): RequestCtx => ({
  requestId: "req-1", client: {} as PoolClient, principal: null,
  scope: EMPTY_SCOPE,
  operationId: null, finalized: false, inFlight: false,
  queryCount: 0, dbless: false, afterCommit: [], ...over
});

describe("一条记录一行，且能 parse 回来", () => {
  it("普通一条：ts / level / scope / msg 齐全", () => {
    emit("info", "bootstrap", "起来了", { port: 3000 });
    const lines = cap.lines();
    expect(lines).toHaveLength(1);
    const r = JSON.parse(lines[0]!);
    expect(r.level).toBe("info");
    expect(r.scope).toBe("bootstrap");
    expect(r.msg).toBe("起来了");
    expect(r.port).toBe(3000);
    /* ts 必须是能被时序库直接吃下的形状 */
    expect(Number.isFinite(Date.parse(r.ts))).toBe(true);
  });

  it("msg 里带换行，仍然只占一行", () => {
    /* 启动自检的致命信息就是多行的。按行采集的管道遇到裸换行
       会把一条记录切成几条不知所云的碎片。 */
    emit("error", "preflight", "拒绝启动：\n  · 第一条\n  · 第二条");
    const lines = cap.lines();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).msg).toContain("\n  · 第二条");
  });

  it("error 走 stderr，其余走 stdout", () => {
    emit("info", "a", "一");
    emit("warn", "b", "二");
    emit("error", "c", "三");
    expect(cap.out.join("")).toContain("一");
    expect(cap.out.join("")).toContain("二");
    expect(cap.err.join("")).toContain("三");
    expect(cap.out.join("")).not.toContain("三");
  });
});

describe("请求上下文自动带上 —— 这是结构化的全部意义", () => {
  it("在请求里打的日志带 requestId", () => {
    runInCtx(fakeCtx(), () => emit("warn", "QueryCount", "太多了"));
    expect(JSON.parse(cap.lines()[0]!).requestId).toBe("req-1");
  });

  it("带上 operationId 与主体（谁、什么角色）", () => {
    runInCtx(fakeCtx({
      operationId: "listStudySites",
      principal: { accountId: "acc-9", roleCode: "crc" } as RequestCtx["principal"]
    }), () => emit("info", "access", "GET /v1/study-sites"));
    const r = JSON.parse(cap.lines()[0]!);
    expect(r.operationId).toBe("listStudySites");
    expect(r.accountId).toBe("acc-9");
    expect(r.role).toBe("crc");
  });

  it("请求之外照样能打 —— 不抛「绕过了请求中间件」", () => {
    /* 连接池的 error 事件、启动、停机都在请求之外。
       在那里抛异常，等于让一次数据库抖动直接带走进程。 */
    expect(() => emit("error", "pool", "空闲连接出错")).not.toThrow();
    const r = JSON.parse(cap.lines()[0]!);
    expect(r.requestId).toBeUndefined();
  });
});

describe("日志绝不抛异常", () => {
  it("循环引用不炸", () => {
    const a: Record<string, unknown> = { name: "环" };
    a["self"] = a;
    expect(() => emit("info", "t", "带环", { a })).not.toThrow();
    const r = JSON.parse(cap.lines()[0]!);
    expect(r.a.self).toBe("[circular]");
  });

  it("bigint 不炸（JSON.stringify 对它直接 TypeError）", () => {
    expect(() => emit("info", "t", "大数", { n: 10n })).not.toThrow();
    expect(JSON.parse(cap.lines()[0]!).n).toBe("10");
  });

  it("toJSON 自己抛，也还是出一行能 parse 的记录", () => {
    const bomb = { toJSON() { throw new Error("我就是不给序列化"); } };
    expect(() => emit("error", "t", "原始消息", { bomb })).not.toThrow();
    const lines = cap.lines();
    expect(lines).toHaveLength(1);
    const r = JSON.parse(lines[0]!);
    expect(r.msg).toContain("日志序列化失败");
    expect(r.original).toBe("原始消息");
  });
});

describe("级别与格式", () => {
  it("默认丢掉 debug", () => {
    emit("debug", "t", "看不见");
    expect(cap.lines()).toHaveLength(0);
  });

  it("SITEDESK_LOG_LEVEL=debug 打开它", () => {
    /* 按次读环境变量，不是模块级常量 —— 常量在 import 那一刻就定死了，
       这条测试会永远绿（因为它压根没生效）。 */
    process.env["SITEDESK_LOG_LEVEL"] = "debug";
    emit("debug", "t", "看得见");
    expect(cap.lines()).toHaveLength(1);
  });

  it("pretty 模式是给人看的，不是 JSON", () => {
    process.env["SITEDESK_LOG_FORMAT"] = "pretty";
    emit("warn", "QueryCount", "发了 47 条", { queries: 47 });
    const l = cap.lines()[0]!;
    expect(() => JSON.parse(l)).toThrow();
    expect(l).toContain("[QueryCount]");
    expect(l).toContain("queries=47");
  });

  it("生产环境默认 json（没显式设 FORMAT 时）", () => {
    delete process.env["SITEDESK_LOG_FORMAT"];
    process.env["NODE_ENV"] = "production";
    emit("info", "t", "线上");
    expect(JSON.parse(cap.lines()[0]!).msg).toBe("线上");
  });
});

describe("Nest 的日志也走同一条路", () => {
  const log = new JsonLogger();

  it("Nest 把 context 放在最后一个参数 —— 它就是 scope", () => {
    /* Nest 的 Logger 包装类转发时会追加 this.context，
       不认这条规矩的话，所有框架日志的 scope 都会是 "app"。 */
    log.log("Mapped {/v1/me, GET} route", "RouterExplorer");
    expect(JSON.parse(cap.lines()[0]!).scope).toBe("RouterExplorer");
  });

  it("error(message, stack, context)：堆栈进 details，不丢", () => {
    log.error("崩了", "Error: 崩了\n    at foo", "Problem");
    const r = JSON.parse(cap.lines()[0]!);
    expect(r.scope).toBe("Problem");
    expect(r.msg).toBe("崩了");
    expect(r.details[0]).toContain("at foo");
  });

  it("直接丢一个 Error 进来，取它的堆栈", () => {
    log.error(new Error("炸了"), "SomeScope");
    const r = JSON.parse(cap.lines()[0]!);
    expect(r.msg).toContain("炸了");
    expect(r.level).toBe("error");
  });

  it("verbose 归到 debug —— 默认就不吵了", () => {
    log.verbose("很啰嗦", "Nest");
    expect(cap.lines()).toHaveLength(0);
  });

  it("没有 context 时 scope 兜底为 app，不会把消息本身吃掉", () => {
    log.log("光秃秃一句");
    const r = JSON.parse(cap.lines()[0]!);
    expect(r.scope).toBe("app");
    expect(r.msg).toBe("光秃秃一句");
  });
});
