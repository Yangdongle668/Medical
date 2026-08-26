/* 启动前的自检 —— 有些配置组合不该"跑起来再说"。
 *
 *  这个文件只做一件事：**在这些组合下拒绝启动**。
 *  拒绝启动是最刺耳、也最安全的失败方式 ——
 *  它发生在部署那一刻，而不是三个月后有人翻日志的时候。
 */

export interface Preflight { fatal: string[]; warn: string[] }

const isProd = (env: NodeJS.ProcessEnv) =>
  (env["NODE_ENV"] ?? "").toLowerCase() === "production";

/** 纯函数，便于直接测。返回致命项与告警项。 */
export function preflight(env: NodeJS.ProcessEnv = process.env): Preflight {
  const fatal: string[] = [], warn: string[] = [];

  /* ── 开发登录：一个开关，两个后门 ──────────────────────────────
     SITEDESK_DEV_LOGIN=1 同时打开两件事：
       ① POST /v1/auth/dev-session 直接换取任意账号的会话，不需要任何凭据；
       ② POST /v1/auth/magic-link 把一次性登录令牌**回显在响应体里**。
     开发时都是必要的，生产上任何一个都足以让整套权限体系失去意义。
     所以生产环境下它不是"不推荐"，是**不许启动**。 */
  if (isProd(env) && env["SITEDESK_DEV_LOGIN"] === "1")
    fatal.push(
      "SITEDESK_DEV_LOGIN=1 与 NODE_ENV=production 同时出现。\n" +
      "    这个开关会让 /v1/auth/dev-session 无凭据换取任意账号的会话，\n" +
      "    并把一次性登录令牌回显在 magic-link 的响应体里。\n" +
      "    生产环境请移除该变量。");

  /* ── 应用必须以非 owner 角色连库 ────────────────────────────────
     owner 绕过 RLS。用 owner 跑应用的话，行级安全形同虚设，
     而且**一切测试都会照常通过** —— 这是最难发现的那一类失守。 */
  const app = env["APP_DATABASE_URL"] ?? "";
  if (app && /:\/\/sitedesk:/.test(app))
    fatal.push(
      "APP_DATABASE_URL 用的是 owner 角色 sitedesk。\n" +
      "    owner 绕过 RLS —— 行范围会全面失效，而所有测试仍然是绿的。\n" +
      "    请改用 sitedesk_app。");

  if (isProd(env) && !env["APP_DATABASE_URL"])
    fatal.push("生产环境缺少 APP_DATABASE_URL。");

  return { fatal, warn };
}

/** 有致命项就打印并退出。启动路径上调用。 */
export function assertPreflight(env: NodeJS.ProcessEnv = process.env): void {
  const { fatal, warn } = preflight(env);
  for (const w of warn) console.warn(`⚠ 启动自检：${w}`);
  if (!fatal.length) return;
  console.error("✗ 启动自检不通过，拒绝启动：");
  for (const f of fatal) console.error(`  · ${f}`);
  process.exit(1);
}
