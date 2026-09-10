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

/* ════════════════════════════════════════════════════════════════════
   进程时区必须是 UTC。

   ── 这条测试是为哪个 bug 写的 ────────────────────────────────────
   全仓 25 处这样把 date 列切成日期串：

       const day = (v: Date | null) => v ? v.toISOString().slice(0, 10) : null;

   pg 把无时区的 `date` 列解析成**本地零点**的 JS Date（只有 INT8 覆盖了
   type parser，1082 用的是默认那份）。实测：库里存 2026-09-09，
   TZ 未设时 day() 给 2026-09-09，**TZ=Asia/Shanghai 时给 2026-09-08**。
   入组日、知情签署日、访视窗口、里程碑达成日、发票到期日，全线少一天。

   容器默认 UTC，所以从来没触发过 —— 但没有任何地方钉死它，
   而「给中国部署设 TZ=Asia/Shanghai 让日志时间正常」是运维会做的第一件事。
   **这类改动的失败方式是安静的**：没有报错，只是每个日期少一天。
   ════════════════════════════════════════════════════════════════════ */
describe("服务端只能在 UTC 下跑", () => {
  const base = { APP_DATABASE_URL: APP } as NodeJS.ProcessEnv;

  it("不设 TZ → 放行（容器默认就是 UTC）", () => {
    expect(preflight(base).fatal).toEqual([]);
  });

  for (const tz of ["UTC", "Etc/UTC", "GMT", "utc", " UTC "])
    it(`TZ=${JSON.stringify(tz)} → 放行`, () => {
      expect(preflight({ ...base, TZ: tz }).fatal).toEqual([]);
    });

  for (const tz of ["Asia/Shanghai", "America/New_York", "Europe/Berlin", "Asia/Tokyo"])
    it(`TZ=${tz} → 拒绝启动`, () => {
      const { fatal } = preflight({ ...base, TZ: tz });
      expect(fatal.length, `${tz} 应当被拦下`).toBe(1);
      /* 报错要说得出后果，不能只说"时区不对" ——
         看到的人得知道为什么不能用他那个时区。 */
      expect(fatal[0]).toContain("少一天");
    });

  it("拦的是 TZ 本身，不是别的配置项", () => {
    const { fatal } = preflight({
      NODE_ENV: "production", APP_DATABASE_URL: APP, TZ: "Asia/Shanghai"
    } as NodeJS.ProcessEnv);
    expect(fatal.some(f => f.startsWith("TZ="))).toBe(true);
  });
});
