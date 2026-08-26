import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { AppModule } from "./app.module.js";
import { assertPreflight } from "./infra/preflight.js";
import { installGracefulShutdown } from "./infra/shutdown.js";

async function bootstrap() {
  /* 先自检，再建应用 —— 不该跑的配置组合不该走到监听端口那一步 */
  assertPreflight();
  const app = await NestFactory.create(AppModule, { bodyParser: true });
  /* 不用 enableShutdownHooks 自带的信号处理：它收到 SIGTERM 就直接关，
     而我们要在关之前先让就绪探针转 503，给负载均衡一个探测周期把自己摘掉。
     顺序见 infra/shutdown.ts。 */
  installGracefulShutdown(app, { log: (m) => new Logger("shutdown").log(m) });
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  new Logger("bootstrap").log(`中心台 API 已启动：http://localhost:${port}/v1`);
}
void bootstrap();
