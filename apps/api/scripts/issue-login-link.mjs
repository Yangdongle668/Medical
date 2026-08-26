/* 签发一次性登录链接，并把它打在运维的终端上。
 *
 *  ── 为什么需要这个 ──────────────────────────────────────────────────
 *  生产环境登录只有一条路：一次性链接。而链接**本该由邮件/短信通道**
 *  发给本人 —— 那个通道还没做。`POST /v1/auth/magic-link` 现在会
 *  老老实实地签发令牌、写进库，然后**不告诉任何人**（回显令牌等于
 *  把登录接口变成一个谁都能用的后门，所以它不回显是对的）。
 *
 *  结果就是：一套刚部署好的系统，没有任何人能登进去。
 *
 *  这个脚本是那个通道补上之前的替代品：它要求**能进服务器**，
 *  也就是说签发权限等同于运维权限 —— 这个前提是清楚的，
 *  而不是在某个接口上开一个谁都能敲的口子。
 *
 *  用法（容器内）：
 *    node apps/api/scripts/issue-login-link.mjs <登录名> [--base https://台的地址]
 */
import { createHash, randomBytes } from "node:crypto";
import pg from "pg";

const args = process.argv.slice(2);
const login = args.find(a => !a.startsWith("--"));
const baseArg = args.indexOf("--base");
const base = (baseArg >= 0 ? args[baseArg + 1] : process.env["SITEDESK_PUBLIC_ORIGIN"])
  ?? "http://localhost:8080";
const ttlMin = Number(process.env["SITEDESK_LINK_TTL_MIN"] ?? 15);

if (!login) {
  console.error("用法：node apps/api/scripts/issue-login-link.mjs <登录名> [--base https://台的地址]");
  process.exit(2);
}

const url = process.env["APP_DATABASE_URL"];
if (!url) {
  console.error("缺少 APP_DATABASE_URL。");
  process.exit(2);
}

/* 以**应用角色**连库，不是 owner：
   `app.issue_login_token` 是 SECURITY DEFINER，本来就是给未认证请求用的。
   用 owner 连会绕过 RLS —— 这里没必要，也不该开这个先例。 */
const c = new pg.Client({ connectionString: url });
await c.connect();
try {
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  const { rows } = await c.query("SELECT app.issue_login_token($1,$2,$3,$4) AS issued",
    [login, hash, ttlMin, null]);

  if (!rows[0]?.issued) {
    /* 这里可以直说账号不存在 —— 能跑这个脚本的人已经在服务器上了，
       对他隐瞒毫无意义。接口那一侧不区分，是因为那一侧对公网开放。 */
    console.error(`✗ 账号「${login}」不存在，或已停用。`);
    process.exit(1);
  }

  const link = `${base.replace(/\/+$/, "")}/login?token=${token}`;
  console.log(`\n✓ 已为「${login}」签发登录链接（${ttlMin} 分钟内有效，只能用一次）：\n`);
  console.log(`  ${link}\n`);
  console.log("把它交给本人。令牌只在这里出现这一次 —— 库里存的是哈希，找不回来。\n");
} finally {
  await c.end();
}
