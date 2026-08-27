import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import zlib from "node:zlib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../server.mjs";

/* ════════════════════════════════════════════════════════════════════
   前端的生产托管。

   在这之前，`vite build` 出来的 dist/ 只有 `vite preview` 在服务它 ——
   而 preview 是开发工具，Vite 自己的文档写着不要用于生产。
   于是"前端怎么上线"这件事一直是空的。

   这一组盯的是四件**不会有任何报错提醒你**的事：

     · SPA 回退：刷新 /sites/abc 会不会 404
       （开发环境永远正常，上线之后"一刷新就白屏"）
     · 缓存方向：带哈希的产物可以永久缓存，index.html 绝对不能。
       反过来做一次，用户手里的旧 index.html 会去要一个已经删掉的
       哈希文件 —— 白屏，而且清不掉，因为那份 index.html 自己在缓存里
     · 缺文件时**不许**回退：少一个 js 却回一份 HTML，
       浏览器报的是 "Unexpected token '<'"，指向完全错误的方向
     · 路径穿越：静态服务器最经典的那个洞

   验过它不是空的：把 immutable 的判断改回按请求字符串判，
   "/assets/../index.html 不许拿到 immutable" 立刻红。
   ════════════════════════════════════════════════════════════════════ */

/** 造一个假的 dist/，**并在它外面放一个绝不该被读到的文件**。
 *
 *  外面那个文件是关键。第一版把 root 直接建在 os.tmpdir() 下，
 *  于是穿越测试去找的是仓库里的 package.json —— 而 root 的上一级是
 *  /tmp，那里什么都没有。把两道防线全拆掉，那组测试**照样全绿**：
 *  它结构上就没有能力发现泄漏。
 *  能读到什么，测试就得在那里放一个什么。 */
function fixture() {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), "sitedesk-web-"));
  fs.writeFileSync(path.join(box, "外面的秘密.txt"), "TRAVERSAL-CANARY-绝不该出现在响应里");
  const root = path.join(box, "dist");
  fs.mkdirSync(path.join(root, "assets"), { recursive: true });
  fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><title>台</title>");
  fs.writeFileSync(path.join(root, "assets", "index-abc123.js"), "export const x = 1;\n");
  /* 一份**够大、值得压**的产物，外加构建期会生成的那两份。
     内容是重复的 —— 真实的 js bundle 也是（同样的关键字、同样的缩进），
     压缩率才有可比性。 */
  fs.writeFileSync(path.join(root, "assets", "big-abc123.js"), BIG);
  fs.writeFileSync(path.join(root, "assets", "big-abc123.js.br"), zlib.brotliCompressSync(BIG));
  fs.writeFileSync(path.join(root, "assets", "big-abc123.js.gz"), zlib.gzipSync(BIG, { level: 9 }));
  return { box, root };
}

/** 只有 br、没有 gz 的那一份也要有：预压缩会丢掉"压了反而更大"的结果，
 *  所以"两份都在"不能当成前提。 */
const BIG = Buffer.from("export const 台账 = () => ({ 中心: 1, 工时: 2 });\n".repeat(200));

/** 假上游 API：把收到的东西原样报回来，好断言转发是不是完整的。 */
function upstream() {
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      res.writeHead(201, {
        "Content-Type": "application/json; charset=utf-8",
        "X-From-Upstream": "1"
      });
      res.end(JSON.stringify({
        method: req.method, url: req.url, body,
        auth: req.headers.authorization ?? null,
        xff: req.headers["x-forwarded-for"] ?? null,
        rid: req.headers["x-request-id"] ?? null
      }));
    });
  });
  return srv;
}

let box: string, root: string;
let api: http.Server, web: ReturnType<typeof createServer>, base: string;
let webPort: number;

/** 原样发一个请求 —— **不经过 URL 规范化**。
 *
 *  这个 helper 不是为了省事，是因为 fetch 会先把路径规范化再发：
 *  `fetch("/assets/../index.html")` 上线路时已经变成 `/index.html`，
 *  服务端根本见不到那个 `..`。用 fetch 写的"穿越测试"因此什么都没测 ——
 *  第一版就是这么写的，把 immutable 的判断改回按字符串判，21 条全绿。
 *  攻击方当然不会用 fetch。 */
function raw(rawPath: string, method = "GET"): Promise<{
  status: number; headers: http.IncomingHttpHeaders; body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: webPort, path: rawPath, method },
      (res) => {
        let body = "";
        res.on("data", (d) => { body += d; });
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      });
    req.on("error", reject);
    req.end();
  });
}

/** 和 raw 一样不经规范化，但**自己指定请求头、拿回原始字节**。
 *  压缩协商必须这么测：fetch 会自动带 Accept-Encoding 并**自动解压**，
 *  于是"发出去的到底是哪一份"在断言里根本看不见。 */
function rawBytes(rawPath: string, headers: Record<string, string> = {}, method = "GET"):
  Promise<{ status: number; headers: http.IncomingHttpHeaders; buf: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: webPort, path: rawPath, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (d) => chunks.push(d as Buffer));
        res.on("end", () => resolve({
          status: res.statusCode!, headers: res.headers, buf: Buffer.concat(chunks) }));
      });
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  ({ box, root } = fixture());
  api = upstream();
  await new Promise<void>((r) => { api.listen(0, "127.0.0.1", r); });
  const apiPort = (api.address() as AddressInfo).port;
  web = createServer({ root, api: `http://127.0.0.1:${apiPort}` });
  await new Promise<void>((r) => { web.listen(0, "127.0.0.1", r); });
  webPort = (web.address() as AddressInfo).port;
  base = `http://127.0.0.1:${webPort}`;
});

afterAll(async () => {
  await new Promise((r) => web.close(r));
  await new Promise((r) => api.close(r));
  fs.rmSync(box, { recursive: true, force: true });
});

describe("静态文件与 SPA 回退", () => {
  it("根路径给 index.html", async () => {
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(await r.text()).toContain("<title>台</title>");
  });

  it("深链接回退到 index.html —— 刷新 /sites/abc 不该 404", async () => {
    const r = await fetch(`${base}/sites/abc-123`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("<title>台</title>");
  });

  it("**缺失的 js 必须 404，不许回退成 HTML**", async () => {
    /* 回退的话浏览器拿到一份 HTML，报 "Unexpected token '<'" ——
       一句完全指错方向的错误，能查一整个下午。 */
    const r = await fetch(`${base}/assets/index-deadbeef.js`);
    expect(r.status).toBe(404);
    expect(r.headers.get("content-type")).not.toContain("html");
  });

  it("带扩展名的路径找不到也是 404（不只是 assets/）", async () => {
    expect((await fetch(`${base}/favicon.ico`)).status).toBe(404);
  });

  it("HEAD 只给头，不给身子", async () => {
    const r = await fetch(`${base}/`, { method: "HEAD" });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-length")).toBeTruthy();
    expect(await r.text()).toBe("");
  });

  it("非 GET/HEAD 的静态请求 405", async () => {
    expect((await fetch(`${base}/`, { method: "POST" })).status).toBe(405);
  });
});

describe("缓存方向 —— 反了就是一场清不掉的白屏", () => {
  it("带哈希的产物：一年 + immutable", async () => {
    const r = await fetch(`${base}/assets/index-abc123.js`);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(r.headers.get("content-type")).toContain("text/javascript");
  });

  it("index.html：每次都要回源校验", async () => {
    const r = await fetch(`${base}/`);
    expect(r.headers.get("cache-control")).toContain("no-cache");
  });

  it("`/assets/../index.html` 拿到的是 index.html 的策略，不是 assets 的", async () => {
    /* 判据必须落在**解析之后**的真实路径上。按请求字符串判的话，
       这个 URL 会给 index.html 发一年的 immutable —— 正是上面那场事故。
       必须用 raw()：fetch 会先把 `..` 规范化掉，服务端见不到它。 */
    const r = await raw("/assets/../index.html");
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toContain("no-cache");
    expect(r.headers["cache-control"]).not.toContain("immutable");
  });

  it("ETag 命中给 304 —— no-cache 的代价只是一次往返", async () => {
    const first = await fetch(`${base}/`);
    const etag = first.headers.get("etag")!;
    expect(etag).toBeTruthy();
    const second = await fetch(`${base}/`, { headers: { "If-None-Match": etag } });
    expect(second.status).toBe(304);
  });
});

describe("路径穿越", () => {
  /* 一律走 raw()：fetch 会先规范化路径，用它写穿越测试等于什么都没测。
     目标是 root 外面那个哨兵文件 —— 测试必须去要一个**真的存在**的东西，
     否则 404 是因为它本来就不在，而不是因为防线拦住了。 */
  const canary = encodeURIComponent("外面的秘密.txt");
  const outside = [
    `/../${canary}`,
    `/%2e%2e/${canary}`,
    `/assets/../../${canary}`,
    `/..%2f${canary}`,
    "/../../../../etc/passwd"
  ];
  for (const p of outside)
    it(`${p} 出不去`, async () => {
      const r = await raw(p);
      /* 404 或回退到 index.html 都可以 —— 唯一不可接受的是
         真的把 root 外面的东西读出来。 */
      expect(r.body).not.toContain("TRAVERSAL-CANARY");
      expect(r.body).not.toContain("root:x:");
    });

  it("绕一圈再回来也不行（../../<临时目录名>/…）", async () => {
    /* box 的名字要等 beforeAll 建完才知道，所以这条单独写。 */
    const r = await raw(`/assets/../../../${path.basename(box)}/${canary}`);
    expect(r.body).not.toContain("TRAVERSAL-CANARY");
  });

  it("坏的百分号编码给 400，不是 500", async () => {
    expect((await raw("/%ZZ")).status).toBe(400);
  });
});

describe("安全响应头", () => {
  it("CSP / nosniff / frame-ancestors 都在", async () => {
    const r = await fetch(`${base}/`);
    const csp = r.headers.get("content-security-policy")!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    /* 字体是外链的 —— 写死成 'self' 会让它静默失效：
       页面照常显示，只是全部回退到系统字体，不会有任何报错。 */
    expect(csp).toContain("https://fonts.googleapis.com");
    expect(csp).toContain("https://fonts.gstatic.com");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
  });
});

describe("同源反代 —— CORS 这件事就此不存在", () => {
  it("方法、路径、查询串、请求体、Authorization 都原样带过去", async () => {
    const r = await fetch(`${base}/v1/study-sites?limit=3`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer t0ken" },
      body: JSON.stringify({ hi: 1 })
    });
    expect(r.status).toBe(201);
    expect(r.headers.get("x-from-upstream")).toBe("1");
    const j = await r.json();
    expect(j.method).toBe("POST");
    expect(j.url).toBe("/v1/study-sites?limit=3");
    expect(j.body).toBe('{"hi":1}');
    expect(j.auth).toBe("Bearer t0ken");
    expect(j.xff).toContain("127.0.0.1");
  });

  it("同一个号带给上游，也回给浏览器 —— 两跳落在一条时间线上", async () => {
    /* 不带的话，同一个请求在边缘和 API 两份日志里是两个不相干的号。 */
    const r = await fetch(`${base}/v1/me`);
    const echoed = r.headers.get("x-request-id");
    expect(echoed).toBeTruthy();
    expect((await r.json()).rid).toBe(echoed);
  });

  it("前面那层 ingress 给的号优先（形状对的话）", async () => {
    const r = await fetch(`${base}/v1/me`, { headers: { "X-Request-Id": "ingress-abc123" } });
    expect((await r.json()).rid).toBe("ingress-abc123");
  });

  it("形状不对的号不沿用 —— 自己发一个", async () => {
    const r = await fetch(`${base}/v1/me`, { headers: { "X-Request-Id": "no good" } });
    expect((await r.json()).rid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("/v1 下的路径不会被 SPA 回退吃掉", async () => {
    /* 回退吃掉的话，前端拿到的是一份 200 的 HTML，
       JSON.parse 报 "Unexpected token '<'" —— 又是那句指错方向的错误。 */
    const r = await fetch(`${base}/v1/anything/deep`);
    expect(r.headers.get("content-type")).toContain("json");
  });

  it("API 没起来时给 502 problem+json，不是白屏", async () => {
    const lonely = createServer({ root, api: "http://127.0.0.1:1" });
    await new Promise<void>((r) => { lonely.listen(0, "127.0.0.1", r); });
    const p = (lonely.address() as AddressInfo).port;
    const r = await fetch(`http://127.0.0.1:${p}/v1/me`);
    expect(r.status).toBe(502);
    expect(r.headers.get("content-type")).toContain("problem+json");
    await new Promise((done) => lonely.close(done));
  });
});

describe("healthz 与排空", () => {
  it("平时 200", async () => {
    const r = await fetch(`${base}/healthz`);
    expect(r.status).toBe(200);
    expect((await r.json()).status).toBe("ok");
  });

  it("排空中 503 —— 与 API 那边同一套顺序", async () => {
    const s = createServer({ root, api: "http://127.0.0.1:1" });
    await new Promise<void>((r) => { s.listen(0, "127.0.0.1", r); });
    const p = (s.address() as AddressInfo).port;
    s.startDraining();
    const r = await fetch(`http://127.0.0.1:${p}/healthz`);
    expect(r.status).toBe(503);
    expect((await r.json()).status).toBe("draining");
    await new Promise((done) => s.close(done));
  });
});

/* ════════════════════════════════════════════════════════════════════
   预压缩产物的协商。

   这一组盯的是"不会报错、只会更慢或更怪"的那几件事：

     · 发一份客户端没声明接受的编码 → 浏览器里是二进制乱码，
       而且只在某些客户端上发生（`br;q=0` 那种）
     · 压缩响应与原文共用一个 ETag → 中间代理拿 br 那份去回答
       只接受 gzip 的客户端，一次缓存投毒
     · Content-Type 按 `.br` 定 → type="module" 的脚本被 MIME 校验拒掉，
       页面白屏，报的话和真正原因毫无关系

   验过它不是空的：把 Vary 那行删掉，"原文也要带 Vary"当场红；
   把 ETag 改回按原文算，"三份不能共用一个 ETag"当场红。
   ════════════════════════════════════════════════════════════════════ */
describe("预压缩产物 —— 450 kB 的 js 不该走明文", () => {
  it("接受 br 就发 br，而且解出来和原文一模一样", async () => {
    const r = await rawBytes("/assets/big-abc123.js", { "accept-encoding": "br" });
    expect(r.status).toBe(200);
    expect(r.headers["content-encoding"]).toBe("br");
    expect(zlib.brotliDecompressSync(r.buf).toString()).toBe(BIG.toString());
    /* 体积真的小了 —— 否则这一整套只是多发了一个响应头 */
    expect(r.buf.length).toBeLessThan(BIG.length / 2);
  });

  it("Content-Length 是压缩后的长度，不是原文的", async () => {
    /* 写成原文长度的话，客户端会一直等那些永远不会到的字节。 */
    const r = await rawBytes("/assets/big-abc123.js", { "accept-encoding": "br" });
    expect(Number(r.headers["content-length"])).toBe(r.buf.length);
  });

  it("Content-Type 仍然按原文的扩展名定", async () => {
    const r = await rawBytes("/assets/big-abc123.js", { "accept-encoding": "br" });
    expect(r.headers["content-type"]).toContain("text/javascript");
  });

  it("只接受 gzip 就发 gzip", async () => {
    const r = await rawBytes("/assets/big-abc123.js", { "accept-encoding": "gzip, deflate" });
    expect(r.headers["content-encoding"]).toBe("gzip");
    expect(zlib.gunzipSync(r.buf).toString()).toBe(BIG.toString());
  });

  it("`br;q=0` 是拒绝，不是接受", async () => {
    /* includes("br") 那种写法在这里会发出一份对方明确不要的编码。 */
    const r = await rawBytes("/assets/big-abc123.js", { "accept-encoding": "br;q=0, gzip" });
    expect(r.headers["content-encoding"]).toBe("gzip");
  });

  it("什么都不接受就发原文", async () => {
    const r = await rawBytes("/assets/big-abc123.js", { "accept-encoding": "identity" });
    expect(r.headers["content-encoding"]).toBeUndefined();
    expect(r.buf.toString()).toBe(BIG.toString());
  });

  it("`*` 也算接受", async () => {
    const r = await rawBytes("/assets/big-abc123.js", { "accept-encoding": "*" });
    expect(r.headers["content-encoding"]).toBe("br");
  });

  it("没有预压缩产物的文件照常发原文，不是 404", async () => {
    /* 小文件不值得压，构建期就不会生成 .br —— 这是正常情况，不是缺失。 */
    const r = await rawBytes("/assets/index-abc123.js", { "accept-encoding": "br" });
    expect(r.status).toBe(200);
    expect(r.headers["content-encoding"]).toBeUndefined();
  });

  it("**原文那一份也要带 Vary** —— 否则不支持 br 的客户端会拿到别人的 br", async () => {
    const plain = await rawBytes("/assets/big-abc123.js", { "accept-encoding": "identity" });
    const br = await rawBytes("/assets/big-abc123.js", { "accept-encoding": "br" });
    expect(plain.headers["vary"]).toBe("Accept-Encoding");
    expect(br.headers["vary"]).toBe("Accept-Encoding");
  });

  it("三份不能共用一个 ETag", async () => {
    const [a, b, c] = await Promise.all([
      rawBytes("/assets/big-abc123.js", { "accept-encoding": "identity" }),
      rawBytes("/assets/big-abc123.js", { "accept-encoding": "br" }),
      rawBytes("/assets/big-abc123.js", { "accept-encoding": "gzip" })
    ]);
    expect(new Set([a.headers.etag, b.headers.etag, c.headers.etag]).size).toBe(3);
  });

  it("ETag 命中仍然给 304，而且带上 Vary", async () => {
    const first = await rawBytes("/assets/big-abc123.js", { "accept-encoding": "br" });
    const again = await rawBytes("/assets/big-abc123.js",
      { "accept-encoding": "br", "if-none-match": String(first.headers.etag) });
    expect(again.status).toBe(304);
    expect(again.headers["vary"]).toBe("Accept-Encoding");
    expect(again.buf.length).toBe(0);
  });

  it("HEAD 给压缩后的长度，不给身子", async () => {
    const r = await rawBytes("/assets/big-abc123.js", { "accept-encoding": "br" }, "HEAD");
    expect(r.status).toBe(200);
    expect(Number(r.headers["content-length"])).toBeGreaterThan(0);
    expect(r.buf.length).toBe(0);
  });

  it("直接来要 .br / .gz 一律 404 —— 那是实现细节，不是资源", async () => {
    /* 发出去的话是一份没有 Content-Encoding 的二进制，
       浏览器当 js 解析然后报一句莫名其妙的语法错。 */
    expect((await rawBytes("/assets/big-abc123.js.br")).status).toBe(404);
    expect((await rawBytes("/assets/big-abc123.js.gz")).status).toBe(404);
  });
});

/* ════════════════════════════════════════════════════════════════════
   HSTS 与强制 https。

   TLS 握手归 ingress，这没变。但 HSTS 只是一个响应头 ——
   只有真正发响应的这一层知道该不该发它，而"该不该"取决于
   这一跳是不是真的在 TLS 后面。

   两个开关的默认值**不一样**，而那个区别是这一组的正题：

   · HSTS 默认**开**。它只在 `X-Forwarded-Proto` 的最左段是 https 时
     才发得出去 —— 纯 http 的部署永远走不到那一行，默认打开伤不到它。
     而默认关的代价是真实的：绝大多数部署不会去读一遍 .env.example，
     于是一个已经在 TLS 后面的系统白白少了一层保护。
     `includeSubDomains` 例外，仍然是 opt-in：它锁的是这套部署
     **并不拥有**的那些子域名，是这里唯一会误伤别人且无法回滚的部分。

   · 强制 https 默认**关**。它把明文请求 308 走，而纯 http 的部署
     （README 的快速开始就是）会当场变得打不开。
     失败方式是"整个站点无法访问"，那不能靠默认值去赌。
   ════════════════════════════════════════════════════════════════════ */
describe("HSTS / 强制 https —— 归 ingress 的那一半和不归它的那一半", () => {
  let srv: ReturnType<typeof createServer>, port: number, at: string;

  beforeAll(async () => {
    srv = createServer({ root, api: "http://127.0.0.1:1", hstsMaxAge: 63072000, forceHttps: true });
    await new Promise<void>((r) => { srv.listen(0, "127.0.0.1", r); });
    port = (srv.address() as AddressInfo).port;
    at = `http://127.0.0.1:${port}`;
  });
  afterAll(async () => { await new Promise((r) => srv.close(r)); });

  const get = (p: string, headers: Record<string, string> = {}, method = "GET") =>
    fetch(`${at}${p}`, { headers, method, redirect: "manual" });

  it("**默认就发** —— 只要这次请求确实是经 TLS 到达的", async () => {
    /* 它曾经默认关，理由是"打开的前提是前面真有一层在做 TLS"。
       那个理由对强制 https 成立，对 HSTS 不成立：这个头只在
       forwardedProto === "https" 时才发得出去，纯 http 的部署
       永远走不到那一行。而默认关的代价是真实的 ——
       绝大多数部署不会去读一遍 .env.example。 */
    const r = await fetch(`${base}/`, { headers: { "x-forwarded-proto": "https" } });
    expect(r.headers.get("strict-transport-security")).toBe("max-age=63072000");
  });

  it("默认**不带** includeSubDomains —— 那是唯一会误伤别人的部分", async () => {
    /* 它锁的是这套部署并不拥有的那些子域名，而且无法回滚。 */
    const r = await fetch(`${base}/`, { headers: { "x-forwarded-proto": "https" } });
    expect(r.headers.get("strict-transport-security")).not.toContain("includeSubDomains");
  });

  it("显式配 0 就是关掉 —— 决定要能被表达出来", async () => {
    const off = createServer({ root, api: "http://127.0.0.1:1", hstsMaxAge: 0 });
    await new Promise<void>(r => off.listen(0, "127.0.0.1", () => r()));
    const port = (off.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`,
        { headers: { "x-forwarded-proto": "https" } });
      expect(r.headers.get("strict-transport-security")).toBeNull();
    } finally { await new Promise(r => off.close(r)); }
  });

  it("这一跳确实在 TLS 后面 → 发 HSTS", async () => {
    const r = await get("/", { "x-forwarded-proto": "https" });
    expect(r.headers.get("strict-transport-security")).toBe("max-age=63072000");
  });

  it("显式打开才带 includeSubDomains", async () => {
    process.env["SITEDESK_HSTS_INCLUDE_SUBDOMAINS"] = "1";
    const sub = createServer({ root, api: "http://127.0.0.1:1" });
    await new Promise<void>(r => sub.listen(0, "127.0.0.1", () => r()));
    const p = (sub.address() as AddressInfo).port;
    try {
      const r = await fetch(`http://127.0.0.1:${p}/`,
        { headers: { "x-forwarded-proto": "https" } });
      expect(r.headers.get("strict-transport-security"))
        .toBe("max-age=63072000; includeSubDomains");
    } finally {
      delete process.env["SITEDESK_HSTS_INCLUDE_SUBDOMAINS"];
      await new Promise(r => sub.close(r));
    }
  });

  it("多层代理时看最左那一段", async () => {
    /* "https, http" 的意思是浏览器走的 https、内网这一跳是 http。
       比整串或取最右的话，HSTS 永远发不出去，而配置看起来是对的。 */
    const r = await get("/healthz", { "x-forwarded-proto": "https, http" });
    expect(r.headers.get("strict-transport-security")).toBeTruthy();
  });

  it("明文连接上不发 HSTS —— 浏览器本来就会忽略它", async () => {
    const r = await get("/healthz");
    expect(r.headers.get("strict-transport-security")).toBeNull();
  });

  it("明文请求 308 到 https，路径与查询串原样带上", async () => {
    const r = await get("/sites/abc?tab=cost");
    expect(r.status).toBe(308);
    expect(r.headers.get("location")).toBe(`https://127.0.0.1:${port}/sites/abc?tab=cost`);
  });

  it("308 而不是 301/302 —— 后两个允许把 POST 改写成 GET", async () => {
    /* 改写之后请求体被静默丢掉，表现为"提交了但没生效"。 */
    const r = await get("/v1/timesheets", {}, "POST");
    expect(r.status).toBe(308);
  });

  it("**探针不跟着跳**", async () => {
    /* LB 的健康检查通常直接打容器端口、不带 X-Forwarded-Proto。
       跟着 308 的话这个实例会被判成不健康摘掉 —— 一个安全开关变成一次停机。 */
    const r = await get("/healthz");
    expect(r.status).toBe(200);
  });

  it("已经是 https 就正常处理，不跳", async () => {
    const r = await get("/", { "x-forwarded-proto": "https" });
    expect(r.status).toBe(200);
  });

  it("Host 头不合法就 400 —— 它会被拼进 Location", async () => {
    /* 客户端可控的值直接进 Location，就是一次开放重定向。
       用裸 http.request 发：fetch 会先替我们把不合规的头拦下来，
       而攻击方不用 fetch。 */
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: "/", method: "GET", headers: { host: "bad host" } },
        (res) => { res.resume(); resolve(res.statusCode!); });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(400);
  });
});
