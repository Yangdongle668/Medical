import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { AppModule } from "./app.module.js";
import { assertPreflight } from "./infra/preflight.js";

async function bootstrap() {
  /* 先自检，再建应用 —— 不该跑的配置组合不该走到监听端口那一步 */
  assertPreflight();
  const app = await NestFactory.create(AppModule, { bodyParser: true });
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  new Logger("bootstrap").log(`中心台 API 已启动：http://localhost:${port}/v1`);
}
void bootstrap();
