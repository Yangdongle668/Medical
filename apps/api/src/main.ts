import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { assertPreflight } from "./infra/preflight.js";
import { installGracefulShutdown } from "./infra/shutdown.js";
import { JsonLogger, emit } from "./infra/log.js";
import { drainConfig } from "./infra/drain.js";
import { deliveryPlan } from "./infra/login-delivery.js";

async function bootstrap() {
  /* 先自检，再建应用 —— 不该跑的配置组合不该走到监听端口那一步 */
  assertPreflight();
  /* 日志在建应用之前就接管：Nest 装配阶段自己那些行（路由映射、
     依赖初始化）也该是同一个格式，否则采集器在启动那一段就断了。 */
  const app = await NestFactory.create(AppModule, {
    bodyParser: true, logger: new JsonLogger()
  });
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
}
void bootstrap();
