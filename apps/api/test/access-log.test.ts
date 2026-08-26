import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool, PoolClient } from "pg";
import { RequestMiddleware } from "../src/infra/request.middleware.js";

/* ════════════════════════════════════════════════════════════════════
   每个请求一行访问日志 —— 尤其是**没走完**的那些请求。

   ── 这一组存在的理由 ────────────────────────────────────────────────
   访问日志把 requestId 塞进记录，靠的是把回调包在 runInCtx 里。
   那层包装看着像是可有可无 —— 产物冒烟检查在**去掉它之后照样全绿**。
   于是量了一下 Node 的真实行为（真 server + 真 fetch）：

     正常收尾：  close 回调里 store 还在 —— 因为 close 是在 res.end()
                 的续体里发出来的，那时还在 als.run 的作用域内
     客户端断开：store 没了 —— 事件来自 socket 拆除，跟处理器不在
                 一条异步链上

   也就是说：**只有断开的那些请求会丢 requestId**，而那恰恰是最需要
   把它捞出来的一类 —— "用户说点了没反应" 查的就是这些行。
   冒烟检查从不中途断开，所以它看不见这件事。

   验过它不是空的：把 accessLog 里的 runInCtx 去掉，
   "断开的请求也带 requestId" 立刻红成 `expected undefined to be defined`，
   而"正常请求"那条仍然是绿的 —— 正好复现上面那张表。
   ════════════════════════════════════════════════════════════════════ */

function capture() {
  const out: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(((c: string) => {
    out.push(String(c)); return true;
  }) as typeof process.stdout.write);
  return {
    restore: () => spy.mockRestore(),
    /** 解析出来的 access 记录 */
    access: () => out.join("").split("\n").filter(l => l.trim() !== "")
      .flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } })
      .filter(r => r.scope === "access")
  };
}

/** 假连接池：中间件只会发 BEGIN / SET LOCAL / ROLLBACK，都不需要真库。 */
const fakePool = () => {
  const client = {
    query: async () => ({ rows: [] }),
    release: () => {}
  } as unknown as PoolClient;
  return { connect: async () => client } as unknown as Pool;
};

/** 起一个真 http server，把中间件挂上去。handler 决定要不要回应。 */
async function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const mw = new RequestMiddleware(fakePool());
  const srv = http.createServer((req, res) => {
    /* express 才有 originalUrl，这里手动补上 —— 中间件靠它判断路由 */
    (req as http.IncomingMessage & { originalUrl?: string }).originalUrl = req.url ?? "/";
    void mw.use(
      req as never, res as never,
      (() => handler(req, res)) as never
    );
  });
  await new Promise<void>(r => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => {
      /* 断开的那条连接还挂在 keep-alive 上，srv.close 会一直等它 ——
         等到 fetch 的 agent 超时为止，白白拖四秒。 */
      srv.closeAllConnections();
      return new Promise(r => srv.close(r));
    }
  };
}

const settle = () => new Promise(r => setTimeout(r, 150));

let cap: ReturnType<typeof capture>;
const env = { ...process.env };

beforeEach(() => {
  process.env["SITEDESK_LOG_FORMAT"] = "json";
  process.env["SITEDESK_LOG_LEVEL"] = "info";
  cap = capture();
});
afterEach(() => { cap.restore(); process.env = { ...env }; });

describe("访问日志", () => {
  it("正常请求：一行，带 requestId、状态、耗时、SQL 条数", async () => {
    const s = await serve((_req, res) => { res.statusCode = 204; res.end(); });
    await fetch(`${s.url}/v1/study-sites?q=张三`);
    await settle();
    await s.close();

    const rows = cap.access();
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.requestId).toEqual(expect.any(String));
    expect(r.method).toBe("GET");
    expect(r.status).toBe(204);
    expect(typeof r.ms).toBe("number");
    expect(r.queries).toBe(0);
    expect(r.aborted).toBeUndefined();
    /* 查询串不进日志：搜索词里可能是姓名，而日志的留存期比业务数据长 */
    expect(r.path).toBe("/v1/study-sites");
    expect(JSON.stringify(r)).not.toContain("张三");
  });

  it("客户端中途断开：照样有一行，**照样带 requestId**，并标出 aborted", async () => {
    /* 这一条是整组的重点。断开时 close 事件来自 socket 拆除，
       跟处理器不在一条异步链上 —— 不显式带上下文的话，
       最该被查的那些行恰好没有可查的键。 */
    const s = await serve(() => { /* 故意不回应，让客户端等到自己放弃 */ });
    const ac = new AbortController();
    void fetch(`${s.url}/v1/study-sites`, { signal: ac.signal }).catch(() => {});
    await new Promise(r => setTimeout(r, 60));
    ac.abort();
    await settle();
    await s.close();

    const rows = cap.access();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.aborted).toBe(true);
    expect(rows[0]!.requestId).toBeDefined();
  });

  it("健康探针降到 debug —— 默认级别下不刷屏", async () => {
    /* 编排器每几秒探一次，按 info 打的话日志里全是它。 */
    const s = await serve((_req, res) => { res.end("ok"); });
    await fetch(`${s.url}/v1/health`);
    await settle();
    await s.close();
    expect(cap.access()).toHaveLength(0);
  });
});
