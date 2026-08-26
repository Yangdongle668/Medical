/* 生产产物的冒烟检查 —— 真的把它起起来，真的打一个请求。
 *
 *  为什么必须有这一步：`node build/server.mjs` 这条路径**从来没有被走过**
 *  （测试走 vitest，开发走 @swc-node/register，两者都有转译），
 *  于是它断了整整五个阶段都没人发现。
 *  一条没人走的路径不会自己报警，所以让 CI 每次都走一遍。
 *
 *  验四件事：
 *    ① 生产配置下的自检真的会拒绝启动（Phase 8c 那道闸，在**真产物**上验）
 *    ② 起得来（DI 装配成功 —— 装饰器元数据没在打包时丢掉）
 *    ③ 打得通（认证 + 行范围 + 契约，一个真实请求走到底）
 *    ④ 未认证被挡（守卫也在产物里）
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(API, "build", "server.mjs");
const PORT = Number(process.env["SMOKE_PORT"] ?? 3996);
const BASE = `http://127.0.0.1:${PORT}/v1`;

const APP_URL = process.env["APP_TEST_DATABASE_URL"] ?? process.env["APP_DATABASE_URL"];
if (!APP_URL) { console.error("缺少 APP_TEST_DATABASE_URL / APP_DATABASE_URL"); process.exit(1); }

const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

function start(env) {
  return spawn(process.execPath, [SERVER], {
    env: { ...process.env, APP_DATABASE_URL: APP_URL, PORT: String(PORT), ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

/* ── ① 先验"拒绝启动"这一侧 ────────────────────────────────────────
   放在前面是有意的：如果自检根本没被打包进来，下面那个正常启动
   也会绿 —— 而那种绿什么都不说明。 */
{
  const p = start({ NODE_ENV: "production", SITEDESK_DEV_LOGIN: "1" });
  let out = "";
  p.stdout.on("data", d => { out += d; });
  p.stderr.on("data", d => { out += d; });
  const code = await new Promise(r => p.on("exit", r));
  /* 注意：**"被自检拒绝"和"根本起不来"退出码都是 1**。
     只看退出码的话，产物彻底坏掉时这一条反而会绿 ——
     所以先把"崩了"这种情形单独认出来，否则失败会指向错的地方。
     （第一版就是这么误报的：产物 ERR_MODULE_NOT_FOUND，
     而这里报的是"拒绝启动了，但没说清原因"。） */
  if (/ERR_MODULE_NOT_FOUND|Cannot find module|SyntaxError|ReferenceError/.test(out))
    fail(`产物根本起不来（不是被自检拒绝的）：\n${out.split("\n").slice(0, 6).join("\n")}`);
  if (code !== 1) fail(`生产环境 + 开发登录时应当拒绝启动（退出码 1），实际 ${code}`);
  if (!out.includes("SITEDESK_DEV_LOGIN")) fail(`拒绝启动了，但没说清原因：\n${out}`);
  console.log("✓ 生产配置 + 开发登录 → 拒绝启动，并写明原因");
}

/* ── ②③④ 正常起一遍，打真实请求 ───────────────────────────────── */
const srv = start({ NODE_ENV: "test", SITEDESK_DEV_LOGIN: "1" });
let log = "";
srv.stdout.on("data", d => { log += d; });
srv.stderr.on("data", d => { log += d; });

const stop = () => { try { srv.kill("SIGTERM"); } catch { /* 已经没了 */ } };
process.on("exit", stop);

let up = false;
for (let i = 0; i < 40; i++) {
  if (srv.exitCode !== null) fail(`进程提前退出（${srv.exitCode}）：\n${log}`);
  try { await fetch(`${BASE}/me`); up = true; break; } catch { /* 还没起来 */ }
  await new Promise(r => setTimeout(r, 500));
}
if (!up) fail(`20 秒内没起来：\n${log}`);
console.log("✓ 生产产物起得来（DI 装配成功 —— 装饰器元数据没在打包时丢掉）");

const j = async (r) => { const t = await r.text(); return t ? JSON.parse(t) : null; };

const s = await j(await fetch(`${BASE}/auth/dev-session`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ login: "lingyuan" }) }));
const token = s?.token;
if (!token) fail(`开发登录没拿到令牌：${JSON.stringify(s)}`);

const sites = await j(await fetch(`${BASE}/study-sites?limit=3`, {
  headers: { Authorization: `Bearer ${token}` } }));
if (!sites?.items?.length) fail(`认证请求没取到中心：${JSON.stringify(sites).slice(0, 300)}`);
console.log(`✓ 一个真实请求走到底：认证 → 行范围 → 契约（取到 ${sites.items.length} 个中心）`);

const anon = await fetch(`${BASE}/study-sites`);
if (anon.status !== 401) fail(`未认证请求应当 401，实际 ${anon.status}`);
console.log("✓ 未认证请求 401（守卫也在产物里）");

stop();
console.log("\n✓ 生产产物冒烟检查通过。");
