/* 前端的生产托管 —— 静态文件 + SPA 回退 + 同源反代 API。
 *
 *  ── 为什么需要这个文件 ──────────────────────────────────────────────
 *  在此之前，`vite build` 出来的 dist/ 只有一个东西在服务它：`vite preview`。
 *  而 preview 是**开发工具**，Vite 自己的文档写着不要用于生产。
 *  于是"前端怎么上线"这件事一直是空的 —— 和 Phase 9a 之前
 *  `node build/server.mjs` 那条没人走过的路径是同一类问题。
 *
 *  上线真正需要的四件事，preview 一件都不保证：
 *
 *  ① **SPA 回退**：react-router 用的是 history 路由。用户把
 *     `/sites/abc` 存成书签、或者刷新一下，服务器上并没有这个文件。
 *     不回退到 index.html 就是 404 —— 应用在开发环境完全正常，
 *     上线之后"刷新就白屏"。
 *
 *  ② **缓存策略**：assets/ 下的文件名带内容哈希，可以永久缓存；
 *     index.html **绝对不能**。反过来做一次，用户手里的旧 index.html
 *     会去要一个已经被删掉的哈希文件，页面白屏，而且**清不掉** ——
 *     因为那份 index.html 自己就在缓存里。
 *
 *  ③ **同源**：前端与 API 同源之后就没有 CORS 这件事，
 *     也不用把 API 地址编译进产物（换个环境就得重新构建）。
 *     所以这里自己把 /v1 反代过去：一个前端容器 + 一个 API 容器就能跑，
 *     中间不需要再摆一台 nginx。
 *
 *  ④ **安全响应头**：nosniff / CSP / frame-ancestors。
 *     这些是"没有就没有"的东西，不会有任何报错提醒你。
 *
 *  ── 不做的事 ────────────────────────────────────────────────────────
 *  TLS、HSTS、限流、Range 请求：交给前面的 ingress。
 *  这个进程假设自己跑在一个反向代理后面，只负责它自己那一层。
 */
import { randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* 日志格式与 API 一致（见 apps/api/src/infra/log.ts）。
   这十几行是**有意重复**的：为了两个 100 行的部署单元共用一个日志模块，
   得让前端去依赖后端的构建产物 —— 那个耦合比这点重复贵得多。 */
const jsonLogs = (process.env["SITEDESK_LOG_FORMAT"] ?? "").toLowerCase() === "json" ||
  ((process.env["SITEDESK_LOG_FORMAT"] ?? "") === "" &&
   (process.env["NODE_ENV"] ?? "").toLowerCase() === "production");
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[(process.env["SITEDESK_LOG_LEVEL"] ?? "info").toLowerCase()] ?? LEVELS.info;
function emit(level, scope, msg, fields = {}) {
  if ((LEVELS[level] ?? 20) < MIN) return;
  const rec = { ts: new Date().toISOString(), level, scope, msg, ...fields };
  const text = jsonLogs ? JSON.stringify(rec)
    : `${rec.ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}` +
      Object.entries(fields).map(([k, v]) => ` ${k}=${v}`).join("");
  (level === "error" ? process.stderr : process.stdout).write(text + "\n");
}

/* ── MIME ─────────────────────────────────────────────────────────────
   浏览器对 `type="module"` 的脚本**强制**校验 MIME：类型不对就直接拒绝执行，
   报的是一句和真正原因毫无关系的话。所以这张表宁可写全。 */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json"
};

/* ── 安全响应头 ───────────────────────────────────────────────────────
   CSP 是照着**真实产物**写的，不是抄一份通用模板：
     · script-src 'self'   —— 构建出来的 index.html 里没有内联脚本
                              （单入口、无动态 import，Vite 不注入 preload 垫片）
     · style-src / font-src 放行 Google Fonts —— index.html 里就有这两个域，
                              写死成 'self' 的话字体会静默失效：
                              页面照常显示，只是全部回退到系统字体，
                              而且不会有任何报错。
     · connect-src 'self'  —— API 是同源反代过来的，不需要额外来源。
   加了新的外部资源就要同步改这里，否则它会被静默拦掉。 */
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "connect-src 'self'",
  "form-action 'self'"
].join("; ");

const SECURITY = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin"
};

/** 把 URL 路径解析成 root 内的真实文件路径；越界或非法一律 null。 */
function resolveInRoot(root, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); }
  catch { return null; }                       // %ZZ 这类坏编码
  if (decoded.includes("\0")) return null;
  /* 两道防线，各自都够用，谁也不依赖谁：
       ① normalize 把绝对路径里的 `..` 折掉（`/../x` → `/x`），出不去；
       ② 折完之后再核对一次落点确实在 root 里面。
     测过：单独拆掉任何一道，穿越测试仍然是绿的；两道一起拆，
     /etc/passwd 当场被读出来。留着第二道是为了让"有人改了第一道"
     不至于直接变成一个洞。
     核对不能只写 startsWith(root)：/app/dist-secrets 也以 /app/dist 开头。 */
  const full = path.resolve(root, "." + path.posix.normalize(decoded));
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

/** 这个**已解析出来的**文件是不是带哈希的产物（assets/ 下）。
 *  判据必须落在解析之后的真实路径上，不能看请求里那个字符串：
 *  `/assets/../index.html` 的请求路径以 /assets/ 开头，
 *  真实文件却是 index.html —— 按字符串判会给 index.html
 *  发一年的 immutable，正是本文件开头 ② 说的那场事故。 */
const isHashedAsset = (root, file) => {
  const rel = path.relative(root, file);
  return rel === "assets" || rel.startsWith("assets" + path.sep);
};
/** 请求路径本身指向 assets/ —— 用来决定"找不到时要不要回退"。 */
const wantsAsset = (p) => p.startsWith("/assets/");
/** 看着像在要一个具体文件（带扩展名）。这类请求**不许**回退到 index.html：
 *  少了一个 js，回退会让浏览器拿到一份 HTML，然后报
 *  "Unexpected token '<'" —— 一句完全指错方向的错误。 */
const looksLikeFile = (p) => path.posix.extname(p) !== "";

async function sendFile(req, res, file, { immutable }) {
  let st;
  try { st = await fsp.stat(file); }
  catch { return false; }
  if (!st.isFile()) return false;

  const etag = `W/"${st.size.toString(16)}-${st.mtimeMs.toString(16)}"`;
  const headers = {
    ...SECURITY,
    "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": String(st.size),
    "Last-Modified": st.mtime.toUTCString(),
    ETag: etag,
    /* 带哈希的产物可以永久缓存；其余（index.html、service worker）
       必须每次回源校验 —— no-cache 是"可以存，但用之前先问"，
       配合 ETag 之后代价只是一次 304。 */
    "Cache-Control": immutable
      ? "public, max-age=31536000, immutable"
      : "no-cache, must-revalidate"
  };

  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, { ETag: etag, "Cache-Control": headers["Cache-Control"] });
    res.end();
    return true;
  }
  res.writeHead(200, headers);
  if (req.method === "HEAD") { res.end(); return true; }
  await new Promise((done) => {
    const s = fs.createReadStream(file);
    s.on("error", () => { res.destroy(); done(); });
    s.on("end", done);
    s.pipe(res);
  });
  return true;
}

function sendText(res, status, text, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { ...SECURITY, "Content-Type": type, "Cache-Control": "no-store" });
  res.end(text);
}

/** /v1/* 原样转给 API。同源的全部意义就在这一段。 */
function proxy(api, requestId, req, res) {
  const mod = api.protocol === "https:" ? https : http;
  const headers = { ...req.headers, host: api.host };
  /* 把号带过去 —— API 认这个头（形状校验过才用）。
     不带的话，同一个请求在两份日志里是两个不相干的号，拼不成一条线。 */
  headers["x-request-id"] = requestId;
  /* 让 API 知道真实客户端 —— 限流、审计都可能要用。
     已经有这个头就往后追加，不要覆盖：前面可能还有一层 ingress。 */
  const prior = req.headers["x-forwarded-for"];
  const ip = req.socket.remoteAddress ?? "";
  headers["x-forwarded-for"] = prior ? `${prior}, ${ip}` : ip;
  headers["x-forwarded-proto"] = req.headers["x-forwarded-proto"] ?? "http";

  const up = mod.request(
    { protocol: api.protocol, hostname: api.hostname, port: api.port, path: req.url,
      method: req.method, headers },
    (r) => {
      /* 上游的头原样透出（Content-Type、幂等键回执、Problem 的 traceId…），
         只补一个 nosniff。CSP 之类是给文档用的，加在 JSON 上没有意义。 */
      res.writeHead(r.statusCode ?? 502, { ...r.headers, "X-Content-Type-Options": "nosniff" });
      r.pipe(res);
    });
  up.on("error", (err) => {
    /* API 没起来 / 正在滚动发布。**这条必须打日志**：
       从浏览器那头看只是一个 502，分不清是 API 挂了还是前端配错了地址。 */
    emit("error", "proxy", "转发到 API 失败", { target: api.origin, path: req.url, err: err.message });
    if (!res.headersSent)
      sendText(res, 502, JSON.stringify({
        title: "上游不可用", status: 502, detail: "API 暂时无法访问，请稍后重试。"
      }), "application/problem+json");
    else res.destroy();
  });
  req.pipe(up);
}

/**
 * 建一个服务器实例。
 * @param root 静态目录（vite build 的产物）
 * @param api  API 源站，/v1 反代到它
 */
export function createServer({ root, api }) {
  const ROOT = path.resolve(root);
  const API = api instanceof URL ? api : new URL(api);
  let draining = false;

  const server = http.createServer((req, res) => {
    const t0 = process.hrtime.bigint();
    const url = req.url ?? "/";
    const pathname = url.split("?")[0];
    /* 前面可能还有一层 ingress，它给的号优先 —— 形状不对就自己发一个。 */
    const inbound = req.headers["x-request-id"];
    const requestId = typeof inbound === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(inbound)
      ? inbound : randomUUID();
    res.setHeader("X-Request-Id", requestId);
    res.on("close", () => {
      /* 探针、以及**取到了**的静态产物，降到 debug。
         一次页面加载要拉十几个文件，按 info 打的话日志里全是它们，
         真正要看的东西（/v1 的转发、404、502）反而被埋掉。
         注意条件里带着状态码：assets 下的 404 仍然是 info ——
         那正是"发布漏了一个文件"的样子。 */
      const chatter = pathname === "/healthz" ||
        (wantsAsset(pathname) && res.statusCode < 400);
      emit(chatter ? "debug" : "info", "access", `${req.method} ${pathname}`, {
        requestId, method: req.method, path: pathname, status: res.statusCode,
        ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e5) / 10,
        ...(res.writableEnded ? {} : { aborted: true })
      });
    });

    void (async () => {
      if (pathname === "/healthz") {
        /* 排空中报 503，让 LB 把自己摘掉 —— 与 API 那边同一套顺序。 */
        return sendText(res, draining ? 503 : 200,
          JSON.stringify({ status: draining ? "draining" : "ok" }),
          "application/json; charset=utf-8");
      }
      if (pathname === "/v1" || pathname.startsWith("/v1/"))
        return proxy(API, requestId, req, res);

      if (req.method !== "GET" && req.method !== "HEAD")
        return sendText(res, 405, "只支持 GET / HEAD");

      const file = resolveInRoot(ROOT, pathname);
      if (!file) return sendText(res, 400, "路径不合法");

      /* 目录请求补 index.html（只有根目录会走到这里） */
      const target = pathname.endsWith("/") ? path.join(file, "index.html") : file;
      if (await sendFile(req, res, target, { immutable: isHashedAsset(ROOT, target) })) return;

      /* 找不到：像文件就 404，像页面就回退。 */
      if (looksLikeFile(pathname) || wantsAsset(pathname))
        return sendText(res, 404, "没有这个文件");
      if (await sendFile(req, res, path.join(ROOT, "index.html"), { immutable: false })) return;
      sendText(res, 404, `没有找到 index.html —— ${ROOT} 里是空的？先跑一次 vite build。`);
    })().catch((err) => {
      emit("error", "web", "处理请求时异常", { path: pathname, err: String(err) });
      if (!res.headersSent) sendText(res, 500, "内部错误");
      else res.destroy();
    });
  });

  server.startDraining = () => { draining = true; };
  server.root = ROOT;
  return server;
}

/* ── 直接跑这个文件时才真的监听 ──────────────────────────────────────
   被 import 时不监听：测试要自己挑端口、自己挑 root，
   而一个"import 就占端口"的模块没法在测试里用两份不同配置。 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ROOT = path.resolve(process.env["SITEDESK_WEB_ROOT"] ?? path.join(HERE, "dist"));
  const API = process.env["SITEDESK_API_ORIGIN"] ?? "http://127.0.0.1:3000";
  const PORT = Number(process.env["PORT"] ?? 8080);
  const HOST = process.env["HOST"] ?? "0.0.0.0";
  const DRAIN_MS = Number(process.env["SITEDESK_DRAIN_MS"] ?? 5000);

  if (!fs.existsSync(ROOT))
    emit("warn", "web", "静态目录不存在 —— 先跑一次 vite build", { root: ROOT });

  const server = createServer({ root: ROOT, api: API });

  /* 与 API 同一套三步停机：先让 /healthz 转 503，等 LB 摘掉，再关。 */
  let closing = false;
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
      if (closing) return;
      closing = true;
      server.startDraining();
      emit("info", "shutdown", `收到 ${sig}：/healthz 开始返回 503，${DRAIN_MS}ms 后关闭。`);
      setTimeout(() => {
        server.close(() => { emit("info", "shutdown", "已关闭。"); process.exit(0); });
        server.closeIdleConnections();
      }, DRAIN_MS);
    });
  }

  server.listen(PORT, HOST, () => {
    emit("info", "web", "前端已启动",
      { port: PORT, host: HOST, root: ROOT, api: new URL(API).origin });
  });
}
