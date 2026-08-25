import "reflect-metadata";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { AppModule } from "../src/app.module.js";

/* 仓库根：从本文件位置往上找到带 package.json 的工作区根，**不靠 cwd**。
   靠 cwd 的版本（`path.resolve(process.cwd(), "../..")`）在换一个目录调用
   vitest 时会指到 /home，然后报 "ENOENT: /home/.env" —— 而那个报错
   看起来像环境问题，其实是定位方式的问题。 */
function repoRoot(): string {
  let d = path.resolve(__dirname, "..");          // apps/api
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(d, "package-lock.json"))) return d;
    d = path.dirname(d);
  }
  throw new Error("找不到仓库根（未在任何上层目录发现 package-lock.json）");
}
const ROOT = repoRoot();

/* .env 只是缺省值：CI 与生产用真实环境变量注入，这里只补齐缺的。
   反过来做的话，CI 上会静默连到开发库 —— 跑起来一切正常，只有数据不对。 */
const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile))
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim();
  }
if (!process.env.TEST_DATABASE_URL || !process.env.APP_TEST_DATABASE_URL)
  throw new Error("缺少 TEST_DATABASE_URL / APP_TEST_DATABASE_URL —— " +
    "请写入仓库根的 .env 或由环境注入");
process.env.SITEDESK_DEV_LOGIN = "1";

/* ── 每个测试文件一个独立数据库 ────────────────────────────────────
   原来是所有文件共用一个 sitedesk_test，各自在 beforeAll 里
   `migrate down 99 && up && seed`。共用 + 各自重置，是一种
   **每次都能跑通、但偶尔会莫名其妙红一片**的组合：
   症状是「刚建的中心查不到（404）」「boss 拿到空的项目列表」，
   看起来像功能坏了，其实是另一个文件把库清了。

   这个问题在本地连跑 8 次都复现不出来，却在 CI 上红了两次 ——
   而 CI 红一次的代价，远高于每个文件多花 1.3 秒建一个库。

   所以不再共用：库名由测试文件名派生，互相之间物理隔离。
   隔离不是靠约定，是靠没有共享的东西。 */

const BASE = process.env.TEST_DATABASE_URL!;
const APP_BASE = process.env.APP_TEST_DATABASE_URL!;

/** 把连接串里的库名换掉 */
const withDb = (url: string, db: string) =>
  url.replace(/\/[^/?]+(\?|$)/, `/${db}$1`);

/** 当前测试文件的短名，用作库名后缀 */
function fileKey(): string {
  const p = expect.getState().testPath ?? "shared";
  return path.basename(p).replace(/\.test\.ts$/, "").replace(/[^a-z0-9]/gi, "_").toLowerCase();
}

export function resetDb() {
  const db = `sitedesk_test_${fileKey()}`;
  const admin = withDb(BASE, "postgres");
  /* SQL 必须写成一行：多行字符串经 -c 传给 psql 时，换行会被当成
     另一个参数的开头，报出来的错完全指不到这里。 */
  const psql = (sql: string, url = admin) => {
    try {
      execSync(`psql "${url}" -v ON_ERROR_STOP=1 -c ${JSON.stringify(sql)}`,
        { cwd: ROOT, stdio: "pipe" });
    } catch (e) {
      const err = e as { stderr?: Buffer };
      throw new Error(`psql 失败：${sql}\n${err.stderr?.toString() ?? String(e)}`);
    }
  };

  /* DROP 前先踢掉残留连接：上一轮泄漏的连接池会让 DROP DATABASE 卡住，
     而那个失败的报错（"is being accessed by other users"）看不出是谁占着。 */
  psql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${db}' AND pid <> pg_backend_pid()`);
  psql(`DROP DATABASE IF EXISTS ${db}`);
  psql(`CREATE DATABASE ${db}`);
  psql("CREATE EXTENSION IF NOT EXISTS btree_gist", withDb(BASE, db));

  const url = withDb(BASE, db);
  const env = { ...process.env, DATABASE_URL: url };
  const M = "npx node-pg-migrate --migrations-dir db/migrations --migrations-table schema_migration";
  execSync(`${M} up`, { cwd: ROOT, env, stdio: "pipe" });
  execSync(`node db/scripts/seed.mjs`, { cwd: ROOT, env, stdio: "pipe" });

  /* 应用必须以非 owner 角色连接 —— 否则 RLS 形同虚设，测出来的全是假绿 */
  process.env.APP_DATABASE_URL = withDb(APP_BASE, db);
  process.env.TEST_DATABASE_URL = url;
}

export async function boot(): Promise<INestApplication> {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = mod.createNestApplication();
  await app.init();
  return app;
}

export const api = (app: INestApplication) => request(app.getHttpServer());

/** 以某账号开一个会话，返回带 Bearer 的调用器 */
export async function as(app: INestApplication, login: string) {
  const r = await api(app).post("/v1/auth/dev-session").send({ login });
  if (r.status !== 201 && r.status !== 200)
    throw new Error(`开会话失败 ${login}: ${r.status} ${JSON.stringify(r.body)}`);
  const token: string = r.body.token;
  const h = { Authorization: `Bearer ${token}` };
  return {
    token,
    get:   (p: string) => api(app).get(p).set(h),
    post:  (p: string, b?: unknown, extra: Record<string, string> = {}) =>
             api(app).post(p).set({ ...h, ...extra }).send(b ?? {}),
    patch: (p: string, b?: unknown) => api(app).patch(p).set(h).send(b ?? {})
  };
}
export type Caller = Awaited<ReturnType<typeof as>>;
