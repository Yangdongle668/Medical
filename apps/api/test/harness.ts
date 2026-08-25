import "reflect-metadata";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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
/* 应用必须以非 owner 角色连接 —— 否则 RLS 形同虚设，测出来的全是假绿 */
process.env.APP_DATABASE_URL = process.env.APP_TEST_DATABASE_URL;
process.env.SITEDESK_DEV_LOGIN = "1";

export function resetDb() {
  const env = { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL };
  const M = "npx node-pg-migrate --migrations-dir db/migrations --migrations-table schema_migration";
  execSync(`${M} down 99`, { cwd: ROOT, env, stdio: "pipe" });
  execSync(`${M} up`,      { cwd: ROOT, env, stdio: "pipe" });
  execSync(`node db/scripts/seed.mjs`, { cwd: ROOT, env, stdio: "pipe" });
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
