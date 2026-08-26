/* 构建后预压缩 —— 把 450 kB 的 js 变成 130 kB。
 *
 *  ── 为什么是构建期，不是请求期 ──────────────────────────────────────
 *  请求期压缩（每来一个请求 gzip 一次）在这个进程里是最糟的选择：
 *  产物是**不变的**，于是同一份 js 会被压上千次，每次都占着事件循环 ——
 *  Node 只有一条主线程，压缩期间连探针都答不上。
 *
 *  构建期压一次，运行期只是把文件读出去。代价是磁盘上多两份，
 *  收益是 brotli 敢开到 quality 11（请求期这个档位慢到不能用）。
 *
 *  ── 为什么不干脆交给 ingress ────────────────────────────────────────
 *  通常确实是 ingress 压。但"通常"不是"一定"：这两个容器可以直接对外跑
 *  （演示部署就是），那时没有任何一层会压，450 kB 的 js 走明文 ——
 *  而它不会报错，只是每个人首屏多等两秒。
 *
 *  前面有 ingress 时也不冲突：它看到 `Content-Encoding: br` 就直接透传，
 *  省掉的正是它自己那次压缩。
 *
 *  ── 哪些不压 ────────────────────────────────────────────────────────
 *  png / woff2 / webp 这些本身就是压过的容器格式，再压一遍通常更大，
 *  即使小一点也换不回多存两份文件的代价。小文件同理：一个 400 字节的
 *  json 压完省 100 字节，而 Content-Encoding 的协商开销比这还多。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env["SITEDESK_WEB_ROOT"] ?? process.argv[2] ??
  path.join(HERE, "..", "dist"));

/** 值得压的类型。判据是"文本"，不是"能压"—— 二进制容器格式压了也白压。 */
const COMPRESSIBLE = new Set([
  ".html", ".js", ".mjs", ".css", ".json", ".map", ".svg", ".txt", ".webmanifest"
]);
/** 低于这个大小不压：省下的字节还不够协商一次编码。 */
const MIN_BYTES = 1024;
/** 压完没小多少就不留 —— 多两份文件是有代价的（部署体积、缓存条目）。 */
const KEEP_IF_UNDER = 0.9;

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p) : [p];
});

/* 十进制 kB，和它上面那行 vite 的输出保持一致 ——
   一个用 1000、一个用 1024 的话，同一个文件在相邻两行里是两个数字，
   而看到的人会以为中间发生了什么。 */
const kb = (n) => (n / 1000).toFixed(1).padStart(7) + " kB";

if (!fs.existsSync(ROOT)) {
  console.error(`没有 ${ROOT} —— 先跑一次 vite build。`);
  process.exit(1);
}

let raw = 0, br = 0, gz = 0, done = 0;
const rows = [];

for (const file of walk(ROOT)) {
  const ext = path.extname(file).toLowerCase();
  /* 自己压出来的东西不再压一遍 —— 这个脚本必须能重复跑 */
  if (ext === ".br" || ext === ".gz") continue;
  if (!COMPRESSIBLE.has(ext)) continue;
  const src = fs.readFileSync(file);
  if (src.length < MIN_BYTES) continue;

  /* brotli 的 SIZE_HINT 不是可有可无：给了它，编码器能一次挑对窗口大小，
     同样的 quality 下再小几个百分点。 */
  const brBuf = zlib.brotliCompressSync(src, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: src.length
    }
  });
  /* gzip 留着不是为了好看：br 在 HTTP 上要求 TLS 之外没什么限制，
     但仍有代理与老客户端只认 gzip。两份加起来的磁盘代价不到 200 kB。 */
  const gzBuf = zlib.gzipSync(src, { level: 9 });

  const keep = (buf, suffix) => {
    if (buf.length >= src.length * KEEP_IF_UNDER) { fs.rmSync(file + suffix, { force: true }); return 0; }
    fs.writeFileSync(file + suffix, buf);
    return buf.length;
  };
  const b = keep(brBuf, ".br"), g = keep(gzBuf, ".gz");
  if (!b && !g) continue;

  raw += src.length; br += b || src.length; gz += g || src.length; done++;
  rows.push(`  ${path.relative(ROOT, file).padEnd(34)} ${kb(src.length)} → br ${kb(b || src.length)}  gz ${kb(g || src.length)}`);
}

if (!done) {
  console.log(`预压缩：${ROOT} 里没有值得压的文件（小于 ${MIN_BYTES} 字节的不压）。`);
} else {
  console.log(`预压缩 ${done} 个文件（${path.relative(process.cwd(), ROOT) || ROOT}）：`);
  for (const r of rows) console.log(r);
  console.log(`  ${"合计".padEnd(34)} ${kb(raw)} → br ${kb(br)}  gz ${kb(gz)}` +
    `   （br 省 ${Math.round((1 - br / raw) * 100)}%）`);
}
