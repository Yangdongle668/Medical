import { describe, it, expect } from "vitest";
import { drainConfig, FALLBACK_MS } from "../src/infra/drain.js";
import { preflight } from "../src/infra/preflight.js";

/* ════════════════════════════════════════════════════════════════════
   排空时长 —— 纯函数，不起进程也不等时间。

   盯的是那个「拍出来的 5 秒」的两个后果：

     · 一个手滑的值（`5s`、`3o`、`5.5`）会被 Number() 变成 NaN，
       而 `NaN > 0` 是 false —— 三步停机于是**静默**降级成「立刻关」。
       没有任何一行日志会提到它，发布看起来一切正常。
     · 5000 本身在最常见的两种编排器上都是错的（k8s 30 秒、ALB 60 秒），
       而错法同样是静默的。

   验过它不是空的：把 intOf 换回 Number()，"NaN 不许静默通过"当场红。
   ════════════════════════════════════════════════════════════════════ */

const APP = "postgres://sitedesk_app:pw@db/sitedesk";
const env = (o: Record<string, string>) => o as NodeJS.ProcessEnv;

describe("显式给的值", () => {
  it("整数照用", () => {
    const c = drainConfig(env({ SITEDESK_DRAIN_MS: "30000" }));
    expect(c).toMatchObject({ ms: 30_000, source: "explicit" });
    expect(c.error).toBeUndefined();
  });

  it("0 是合法的 —— 本地开发就是要立刻关", () => {
    expect(drainConfig(env({ SITEDESK_DRAIN_MS: "0" })).ms).toBe(0);
  });

  for (const bad of ["5s", "3o", "5.5", "-1", "abc", "1e4"])
    it(`${JSON.stringify(bad)} 不许静默通过 —— 它会变成「立刻关」`, () => {
      const c = drainConfig(env({ SITEDESK_DRAIN_MS: bad }));
      expect(c.error).toMatch(/SITEDESK_DRAIN_MS/);
    });

  it("空串当成没设，不当成 0", () => {
    /* `SITEDESK_DRAIN_MS=` 在 compose 里太容易出现（变量没展开）。
       把它读成 0 等于悄悄关掉排空。 */
    const c = drainConfig(env({ SITEDESK_DRAIN_MS: "  " }));
    expect(c).toMatchObject({ ms: FALLBACK_MS, source: "default" });
  });

  it("超过上限也拦 —— 排空比宽限期还长，只会被 SIGKILL 砍断", () => {
    expect(drainConfig(env({ SITEDESK_DRAIN_MS: "3600000" })).error).toMatch(/上限/);
  });
});

describe("按 LB 参数推算 —— 让运维填他知道的那个数", () => {
  it("探测间隔 × 失败阈值 + 余量", () => {
    const c = drainConfig(env({ SITEDESK_LB_PROBE_MS: "10000", SITEDESK_LB_PROBE_FAILURES: "3" }));
    expect(c).toMatchObject({ ms: 31_000, source: "derived" });   // k8s 的默认组合
  });

  it("没给失败阈值就按 2 次", () => {
    const c = drainConfig(env({ SITEDESK_LB_PROBE_MS: "30000" }));
    expect(c.ms).toBe(61_000);                                    // ALB 的默认组合
  });

  it("显式的 SITEDESK_DRAIN_MS 优先于推算", () => {
    const c = drainConfig(env({ SITEDESK_DRAIN_MS: "8000", SITEDESK_LB_PROBE_MS: "30000" }));
    expect(c).toMatchObject({ ms: 8000, source: "explicit" });
  });

  it("畸形的 LB 参数同样拒绝，不退回默认值", () => {
    /* 退回默认值是最坏的处理：填了参数的人以为自己配好了。 */
    expect(drainConfig(env({ SITEDESK_LB_PROBE_MS: "10s" })).error).toMatch(/SITEDESK_LB_PROBE_MS/);
    expect(drainConfig(env({ SITEDESK_LB_PROBE_MS: "10000", SITEDESK_LB_PROBE_FAILURES: "0" }))
      .error).toMatch(/SITEDESK_LB_PROBE_FAILURES/);
  });
});

describe("自检把它接了起来", () => {
  it("畸形的值 → 拒绝启动", () => {
    const { fatal } = preflight(env({
      NODE_ENV: "production", APP_DATABASE_URL: APP, SITEDESK_DRAIN_MS: "5s" }));
    expect(fatal.join()).toMatch(/SITEDESK_DRAIN_MS/);
  });

  it("生产环境用默认值 → 告警（但不拦）", () => {
    const { fatal, warn } = preflight(env({ NODE_ENV: "production", APP_DATABASE_URL: APP }));
    expect(fatal).toEqual([]);
    expect(warn.join()).toMatch(/探测间隔 × 连续失败阈值/);
  });

  it("生产环境显式配过 → 不啰嗦", () => {
    /* 只问排空这一件事：同一个 preflight 还会为别的事告警
       （比如没配登录链接的投递通道），那些不该把这条测试带红。 */
    const { warn } = preflight(env({
      NODE_ENV: "production", APP_DATABASE_URL: APP, SITEDESK_DRAIN_MS: "30000" }));
    expect(warn.join()).not.toMatch(/探测间隔/);
  });

  it("生产环境显式设成 0 → 告警：那是本地开发的配法", () => {
    const { warn } = preflight(env({
      NODE_ENV: "production", APP_DATABASE_URL: APP, SITEDESK_DRAIN_MS: "0" }));
    expect(warn.join()).toMatch(/主动丢一小撮请求/);
  });

  it("开发环境安安静静", () => {
    const { fatal, warn } = preflight(env({ NODE_ENV: "development", APP_DATABASE_URL: APP }));
    expect(fatal).toEqual([]);
    expect(warn).toEqual([]);
  });

  it("生产环境没配投递通道 → 告警，但仍然能启动", () => {
    /* 运维用 deploy/login-link.sh 代发仍然是一条可用的路径，
       所以它不是致命项 —— 但它必须被说出来。 */
    const { fatal, warn } = preflight(env({ NODE_ENV: "production", APP_DATABASE_URL: APP }));
    expect(fatal).toEqual([]);
    expect(warn.join()).toMatch(/投递通道/);
  });
});
