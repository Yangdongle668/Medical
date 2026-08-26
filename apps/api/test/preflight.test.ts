import { describe, it, expect } from "vitest";
import { preflight } from "../src/infra/preflight.js";

/* ════════════════════════════════════════════════════════════════════
   启动自检 —— 纯函数，不碰数据库。

   验的是"哪些配置组合根本不该跑起来"。
   拒绝启动是最刺耳、也最安全的失败方式：它发生在部署那一刻，
   而不是三个月后有人翻日志的时候。
   ════════════════════════════════════════════════════════════════════ */

const APP = "postgres://sitedesk_app:pw@db/sitedesk";
const OWNER = "postgres://sitedesk:pw@db/sitedesk";

describe("开发登录不许出现在生产", () => {
  it("NODE_ENV=production + SITEDESK_DEV_LOGIN=1 → 拒绝启动", () => {
    /* 一个开关两个后门：无凭据换会话，以及把一次性登录令牌回显在响应体里。 */
    const { fatal } = preflight({
      NODE_ENV: "production", SITEDESK_DEV_LOGIN: "1", APP_DATABASE_URL: APP
    } as NodeJS.ProcessEnv);
    expect(fatal.join()).toMatch(/SITEDESK_DEV_LOGIN/);
  });

  it("开发环境下开着它是正常的", () => {
    const { fatal } = preflight({
      NODE_ENV: "development", SITEDESK_DEV_LOGIN: "1", APP_DATABASE_URL: APP
    } as NodeJS.ProcessEnv);
    expect(fatal).toEqual([]);
  });

  it("生产环境没设这个变量 → 放行", () => {
    const { fatal } = preflight({
      NODE_ENV: "production", APP_DATABASE_URL: APP
    } as NodeJS.ProcessEnv);
    expect(fatal).toEqual([]);
  });
});

describe("应用不许以 owner 角色连库", () => {
  it("APP_DATABASE_URL 指向 owner → 拒绝启动", () => {
    /* owner 绕过 RLS：行范围全面失效，而所有测试仍然是绿的 ——
       这是最难发现的那一类失守，所以只能在启动时拦。 */
    const { fatal } = preflight({
      NODE_ENV: "production", APP_DATABASE_URL: OWNER
    } as NodeJS.ProcessEnv);
    expect(fatal.join()).toMatch(/owner/);
  });

  it("sitedesk_app 不会被误判成 sitedesk", () => {
    /* 前缀相同，正则写松一点就会把正确配置也拦下来 —— 那种误报会让人
       直接把自检关掉，等于什么都没做。 */
    const { fatal } = preflight({
      NODE_ENV: "production", APP_DATABASE_URL: APP
    } as NodeJS.ProcessEnv);
    expect(fatal).toEqual([]);
  });
});
