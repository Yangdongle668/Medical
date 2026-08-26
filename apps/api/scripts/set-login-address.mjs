/* 登记 / 更换某个账号的登录链接收件地址。
 *
 *  ── 为什么需要它 ────────────────────────────────────────────────────
 *  投递通道做好之后，`POST /v1/auth/magic-link` 会把链接送到**库里登记的**
 *  那个地址 —— 绝不送到请求里带的那个（那样这个公开端点就是一键账号接管）。
 *  于是必须有一条路把地址写进去，而它显然不能是一个公开接口：
 *  能改收件地址的人，等于能拿到那个人的登录链接。
 *
 *  所以和签发链接一样，这件事要求**能进服务器**：
 *  改地址的权限等同于运维权限，这个前提是清楚的。
 *
 *  用法（容器内）：
 *    node apps/api/scripts/set-login-address.mjs <登录名> <邮箱或手机号>
 */
import pg from "pg";

const [login, address] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!login || !address) {
  console.error("用法：node apps/api/scripts/set-login-address.mjs <登录名> <邮箱或手机号>");
  process.exit(2);
}

const url = process.env["APP_DATABASE_URL"];
if (!url) { console.error("缺少 APP_DATABASE_URL。"); process.exit(2); }

/* 以应用角色连库：`app.set_login_address` 是 SECURITY DEFINER，
   它自己会绕过 auth_identity 的 RLS。用 owner 连没必要，也不该开这个先例。 */
const c = new pg.Client({ connectionString: url });
await c.connect();
try {
  const { rows } = await c.query("SELECT app.set_login_address($1,$2) AS ok", [login, address]);
  if (!rows[0]?.ok) {
    /* 这里可以直说账号不存在 —— 能跑这个脚本的人已经在服务器上了。
       接口那一侧不区分，是因为那一侧对公网开放。 */
    console.error(`✗ 账号「${login}」不存在，或已停用。`);
    process.exit(1);
  }
  const 通道 = address.includes("@") ? "邮件" : "短信";
  console.log(`\n✓ 「${login}」的登录链接将投递到：${address}（走${通道}通道）\n`);
  console.log("一个账号只保留一个地址 —— 再跑一次就是更换。\n");
} catch (e) {
  /* 函数里的两条校验（地址形状、地址已属于别人）都是 RAISE EXCEPTION，
     原话比"操作失败"有用得多。 */
  console.error(`✗ ${e.message}`);
  process.exit(1);
} finally {
  await c.end();
}
