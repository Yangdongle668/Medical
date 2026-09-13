import "reflect-metadata";
import { json } from "express";
import type { Request, Response, NextFunction } from "express";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { assertPreflight } from "./infra/preflight.js";
import { installGracefulShutdown } from "./infra/shutdown.js";
import { JsonLogger, emit } from "./infra/log.js";
import { drainConfig } from "./infra/drain.js";
import { deliveryPlan } from "./infra/login-delivery.js";
import { POOL } from "./infra/db.js";
import type { Pool } from "pg";

async function bootstrap() {
  /* 先自检，再建应用 —— 不该跑的配置组合不该走到监听端口那一步 */
  assertPreflight();
  /* 日志在建应用之前就接管：Nest 装配阶段自己那些行（路由映射、
     依赖初始化）也该是同一个格式，否则采集器在启动那一段就断了。 */
  const app = await NestFactory.create(AppModule, {
    bodyParser: true, logger: new JsonLogger()
  });
  /* ── 只有上传受理意向函那一条路放大请求体 ──────────────────────────
     express 的 JSON 解析默认上限是 **100 KB**。全仓库的请求体都远在
     这条线以下，只有一条不是：`:record-letter` 里那份 PDF 的 base64。
     一份几百 KB 的扫描件编码后一兆出头 —— 不动这个限制的话，
     那条端点对**任何**真实文件都回 413，而 413 长得像"服务拒绝了你"，
     不像"你的文件太大"。

     **不全局放大。** 把上限提到 15 MB 等于给每一条 POST 都开了那么大的口子，
     而那是一条最便宜的拖垮路径。所以只认这一条路径：
     大小的真正判定在服务层（10 MB，按 base64 解出来之后算）与库里的
     CHECK 上，这里放的是"让它进得来"那一道。15 MB 是 10 MB 的 base64
     膨胀（×4/3）再留一点余量。 */
  const bigJson = json({ limit: "15mb" });
  app.use("/v1/site-acceptances", (req: Request, res: Response, next: NextFunction) =>
    req.method === "POST" && req.url.includes(":record-letter")
      ? bigJson(req, res, next)
      : next());
  /* 不用 enableShutdownHooks 自带的信号处理：它收到 SIGTERM 就直接关，
     而我们要在关之前先让就绪探针转 503，给负载均衡一个探测周期把自己摘掉。
     顺序见 infra/shutdown.ts。 */
  installGracefulShutdown(app, { log: (m) => emit("info", "shutdown", m) });
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  /* 三个"配了没有"在启动那一行里一次说清。它们的共同点是：
     **配错和没配，在运行时长得一模一样** —— 排空时长短了只是偶尔掉请求，
     投递通道空着只是没人收得到链接。让每次启动都自报一次，
     比事后去猜便宜得多。 */
  const drain = drainConfig();
  const delivery = deliveryPlan();
  emit("info", "bootstrap", "中心台 API 已启动", {
    port, base: `/v1`,
    drainMs: drain.ms, drainFrom: drain.source,
    loginEmail: delivery.email, loginSms: delivery.sms
  });

  await warnFactoryPasswords(app.get<Pool>(POOL));
}

/** 还在用出厂口令的账号，每次启动报一次。
 *
 *  为什么不在 preflight 里：那个函数是纯的（只看 env），
 *  而这件事只有库知道。也**不拒绝启动** —— 拒绝启动的话，
 *  一次干净部署会在第一次就起不来，而那正是唯一需要它能起来的时候。
 *
 *  为什么放在 listen 之后：库连不上时不该把启动一起拖死。 */
async function warnFactoryPasswords(pool: Pool): Promise<void> {
  try {
    const { rows } = await pool.query<{ login: string; display_name: string }>(
      "SELECT login, display_name FROM app.accounts_on_factory_password()");
    if (!rows.length) return;
    emit("warn", "security",
      `有 ${rows.length} 个账号还在用出厂口令（admin）：${rows.map(r => r.login).join("、")}\n` +
      "    出厂口令是公开的 —— 这台机器只要能从外面打到，任何人都能以管理员身份登进来。\n" +
      "    改密：登录后在「组织与权限」页改，或界面顶部那条红条上直接点。",
      { logins: rows.map(r => r.login) });
  } catch (err) {
    /* 迁移还没跑到 0025 时这个函数不存在。那不是错误，是"还没到时候"。 */
    emit("info", "security", "出厂口令自检跳过", {
      err: err instanceof Error ? err.message : String(err) });
  }
}
void bootstrap();
