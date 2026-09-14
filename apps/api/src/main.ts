import "reflect-metadata";
import { readdir } from "node:fs/promises";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { assertPreflight } from "./infra/preflight.js";
import { installGracefulShutdown } from "./infra/shutdown.js";
import { uploadBodyLimit } from "./infra/upload-limit.js";
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
  /* 收文件的那几条端点放大请求体上限，**名单从契约里取** ——
     原来这里按"路径里有没有 `:record-letter`"判，而一步填完的
     `POST /v1/site-acceptances` 后来也收 letter 了，路径里没有那个词，
     于是一份 100 KB 的 PDF 递不进去、回 422，报文还写着上限是 10 MB。
     理由与做法都在 infra/upload-limit.ts。 */
  app.use(uploadBodyLimit());
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

  await warnSchemaBehind(app.get<Pool>(POOL));
  await warnFactoryPasswords(app.get<Pool>(POOL));
}

/** 库里的迁移比代码旧了 —— **每次启动大声报一次**。
 *
 *  ── 这一条是被一次真事故逼出来的 ────────────────────────────────
 *  代码部署上去了，迁移没跑。症状不是"起不来"，是**某几条端点回 500**，
 *  而别的一切看起来都正常 —— 因为新代码引用了一张还不存在的表、
 *  一个还不存在的函数，或者指望着一条还没放松的约束。
 *
 *  查这种事要花掉的时间，和它值得的时间差着两个数量级：日志里那句
 *  `relation "acceptance_letter" does not exist` 埋在一堆请求日志中间，
 *  而界面上只说「服务内部错误」。
 *
 *  ── 为什么不拒绝启动 ────────────────────────────────────────────
 *  有些部署顺序是先起服务再跑迁移（容器编排里很常见）。拒绝启动会把
 *  那种编排变成一个重启循环，而重启循环比 500 更难看出原因。
 *  所以：**照常起，但在启动那一行里把缺的迁移逐个点名**。
 *
 *  ── 判据 ────────────────────────────────────────────────────────
 *  比的是 `db/migrations` 下的文件名与 `schema_migration` 表里的记录。
 *  打包之后那个目录通常不在镜像里 —— 找不到就跳过，不报错：
 *  一条对着空目录永远绿的检查，比没有检查更糟，所以它说的是"跳过"。 */
async function warnSchemaBehind(pool: Pool): Promise<void> {
  try {
    const dir = new URL("../../../db/migrations", import.meta.url);
    const files = await readdir(dir);
    const onDisk = files.filter(f => f.endsWith(".sql"))
      .map(f => f.replace(/\.sql$/, "")).sort();
    if (!onDisk.length) {
      emit("info", "schema", "迁移自检跳过：镜像里没有 db/migrations");
      return;
    }
    const { rows } = await pool.query<{ name: string }>(
      "SELECT name FROM schema_migration");
    const applied = new Set(rows.map(r => r.name));
    const missing = onDisk.filter(n => !applied.has(n));
    if (!missing.length) {
      emit("info", "schema", `迁移已是最新（${onDisk.at(-1)}）`);
      return;
    }
    emit("error", "schema",
      `库里的迁移比代码旧 ${missing.length} 条 —— **先跑 npm run db:up 再用**。\n` +
      `    缺：${missing.join("、")}\n` +
      "    症状不会是「起不来」，而是某几条端点回 500（新代码引用了还不存在的表 / 函数），\n" +
      "    而界面上只说「服务内部错误」。",
      { missing });
  } catch (err) {
    /* 连不上库、没有 schema_migration 表（全新库还没跑过任何迁移）——
       两种都不该把启动拖死。 */
    emit("info", "schema", "迁移自检跳过", {
      err: err instanceof Error ? err.message : String(err) });
  }
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
