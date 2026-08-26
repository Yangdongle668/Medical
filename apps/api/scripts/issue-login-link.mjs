/* 签发一次性登录链接，并把它打在运维的终端上。
 *
 *  ── 通道已经有了，这个脚本还留着 ────────────────────────────────────
 *  正常路径是：本人在登录页申请 → `POST /v1/auth/magic-link` 签发 →
 *  邮件/短信通道送到**库里登记的**地址（见 infra/login-delivery.ts）。
 *
 *  这个脚本是那条路走不通时的备用闸，三种情况还会用到它：
 *    · 通道还没配（SITEDESK_SMTP_URL / SITEDESK_SMS_WEBHOOK_URL 都空着）
 *    · 这个账号还没登记收件地址（用 deploy/login-address.sh 登记）
 *    · 邮件服务器本身挂了，而有人现在就要进去
 *
 *  它要求**能进服务器**，也就是说这条备用路径的权限等同于运维权限 ——
 *  这个前提是清楚的，而不是在某个接口上开一个谁都能敲的口子。
 *  注意它绕过投递：签出来的链接由你自己交给本人。
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
