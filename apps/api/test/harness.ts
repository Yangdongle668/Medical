import "reflect-metadata";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AppModule } from "../src/app.module.js";

/* 测试以 apps/api 为 cwd 运行；用 cwd 定位仓库根，避免 import.meta 与 CommonJS 输出冲突 */
const ROOT = path.resolve(process.cwd(), "../..");
for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
}
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
