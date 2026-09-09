/* 启动前的自检 —— 有些配置组合不该"跑起来再说"。
 *
 *  这个文件只做一件事：**在这些组合下拒绝启动**。
 *  拒绝启动是最刺耳、也最安全的失败方式 ——
 *  它发生在部署那一刻，而不是三个月后有人翻日志的时候。
 */

import { emit } from "./log.js";
import { drainConfig, DRAIN_DEFAULT_WARNING } from "./drain.js";
import { deliveryPlan, NO_CHANNEL_WARNING } from "./login-delivery.js";

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

  /* ── 排空时长 ──────────────────────────────────────────────────
     两件事在这里拦：

     ① **畸形的值**。`Number("3o")` 是 NaN，而 `NaN > 0` 是 false ——
        一个手滑的环境变量会把三步停机静默降级成「立刻关」，
        发布照常成功，只是每次漏掉一小撮请求。这类"配错了反而没声音"
        的东西，正是自检该拦的。

     ② **默认值**。5000 是拍的：它必须比 LB 摘掉本实例所需的时间长，
        而 k8s 默认 30 秒、ALB 默认 60 秒。生产上没显式配过就告警 ——
        不拒绝启动（它不是安全问题，且本地与演示部署照样要能跑），
        但也不能一声不吭。 */
  const drain = drainConfig(env);
  if (drain.error) fatal.push(drain.error);
  else if (isProd(env)) {
    if (drain.source === "default") warn.push(DRAIN_DEFAULT_WARNING);
    else if (drain.ms === 0)
      warn.push(
        "SITEDESK_DRAIN_MS=0：收到 SIGTERM 后立刻关闭，不给负载均衡摘掉本实例的时间。\n" +
        "    本地开发这样是对的；生产环境等于每次发布都主动丢一小撮请求。");
  }

  /* ── 登录链接的投递通道 ────────────────────────────────────────
     致命项只有一类：**把可用的登录链接打进日志**。
     console 通道在开发环境是必要的（否则本地根本拿不到链接），
     在生产环境则等于把登录权限授予所有能读日志的人 ——
     而审计轨迹里看到的会是那个被冒用的人自己。

     两条通道都没配不是致命的：运维用 deploy/login-link.sh 代发仍然
     是一条可用的路径。但它必须被说出来 —— 那正是这条已知问题的内容。 */
  const delivery = deliveryPlan(env);
  fatal.push(...delivery.fatal);
  if (isProd(env) && delivery.email === "none" && delivery.sms === "none")
    warn.push(NO_CHANNEL_WARNING);

  /* ── 进程时区必须是 UTC ────────────────────────────────────────
     全仓 25 处这样把 date 列切成日期串：

         const day = (v: Date | null) => v ? v.toISOString().slice(0, 10) : null;

     pg 把无时区的 `date` 列解析成**本地零点**的 JS Date
     （只有 INT8 覆盖了 type parser，1082 用的是默认那份）。
     实测：库里存 2026-09-09，TZ 未设时 day() 给 2026-09-09，
     **TZ=Asia/Shanghai 时给 2026-09-08** —— 入组日、知情签署日、
     访视窗口、里程碑达成日、发票到期日全线偏移一天。

     更糟的是仓库里同时有两套约定：`atMidnight`（finance / staffing）
     和编号年份用的是**本地**，上面那 25 处用的是 **UTC**。
     UTC 下两者碰巧一致；换个时区，一半跟着变对、一半跟着变错。

     容器默认是 UTC，所以今天不触发。但没有任何地方钉死它，
     而"给中国部署设 TZ=Asia/Shanghai 让日志时间正常"是运维会做的第一件事。
     **这类改动的失败方式是安静的**：没有报错，只是每个日期少一天。

     所以在这里拦住：要么不设 TZ，要么设成 UTC，否则拒绝启动。
     真要按本地时区渲染，那是前端的事（见 apps/web/src/shell/dates.ts）——
     服务端存的是日历日，不该带时区。 */
  const tz = env["TZ"];
  if (tz !== undefined && !/^(UTC|Etc\/UTC|GMT|Etc\/GMT)$/i.test(tz.trim()))
    fatal.push(
      `TZ=${tz} —— 服务端只能在 UTC 下运行。\n` +
      "    pg 把无时区的 date 列解析成本地零点，而全仓用 toISOString() 把它切成\n" +
      "    日期串：非 UTC 时区下每一个日期字段都会少一天，且不会报任何错。\n" +
      "    请移除 TZ，或设为 UTC。日志要本地时间的话在采集侧转换。");

  return { fatal, warn };
}

/** 有致命项就打印并退出。启动路径上调用。 */
export function assertPreflight(env: NodeJS.ProcessEnv = process.env): void {
  const { fatal, warn } = preflight(env);
  for (const w of warn) emit("warn", "preflight", w);
  if (!fatal.length) return;
  /* 多行的说明整段进 msg —— JSON.stringify 会把换行转义成 \n，
     一条记录仍然只占一行，采集器不会把它切成几条不知所云的碎片。 */
  for (const f of fatal) emit("error", "preflight", `启动自检不通过，拒绝启动：\n  · ${f}`);
  process.exit(1);
}
