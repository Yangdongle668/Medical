import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { boot, resetDb, as, api, type Caller } from "./harness.js";

/* ════════════════════════════════════════════════════════════════════
   权限矩阵 —— 8 个角色 × 行 / 列 / 动作，走真实 HTTP。

   这一组测试证明的是：**绕过前端直接打接口，权限依然成立**。
   前端那一份 policy 只用来收敛 UI，从来不是安全边界。
   ════════════════════════════════════════════════════════════════════ */

let app: INestApplication;
const C: Record<string, Caller> = {};
const LOGINS = ["lingyuan", "hanxue", "cendi", "linmin", "wutong",
                "liaomeng", "miaoqing", "weilan", "zhanghm", "chenguod"];

beforeAll(async () => {
  resetDb();
  app = await boot();
  for (const l of LOGINS) C[l] = await as(app, l);
}, 120_000);
afterAll(async () => { await app?.close(); });

describe("未认证：一律 401，且是 Problem Details", () => {
  it("没有令牌 → 401", async () => {
    const r = await api(app).get("/v1/study-sites");
    expect(r.status).toBe(401);
    expect(r.headers["content-type"]).toContain("application/problem+json");
    expect(r.body).toMatchObject({ code: "unauthenticated", status: 401 });
    expect(r.body.type).toMatch(/problems\/unauthenticated$/);
  });
  it("伪造令牌 → 401（不泄漏为什么）", async () => {
    const r = await api(app).get("/v1/me").set({ Authorization: "Bearer forged-token-0123456789abcdef" });
    expect(r.status).toBe(401);
  });
});

describe("行维度：每个角色只看得到自己该看的中心", () => {
  const EXPECT: [string, number, string][] = [
    ["lingyuan", 15, "经营层 · 全部"],
    ["miaoqing", 15, "数据管理 · 全部"],
    ["weilan",   15, "质量保证 · 全部"],
    ["hanxue",    8, "PM · 本组承接 2 个项目"],
    ["cendi",     7, "PM · 另一组"],
    ["linmin",    4, "CRA · 被指派"],
    ["wutong",    2, "CRC · 驻场"],
    ["liaomeng",  3, "CRC · 驻场"],
    ["zhanghm",   2, "机构办 · 本院"],
    ["chenguod",  1, "PI · 本人担任研究者"]
  ];
  for (const [login, n, why] of EXPECT)
    it(`${login} 看到 ${n} 个中心 —— ${why}`, async () => {
      const r = await C[login]!.get("/v1/study-sites?limit=200");
      expect(r.status).toBe(200);
      expect(r.body.items).toHaveLength(n);
    });

  it("GET /v1/me 报告的范围与实际返回的一致", async () => {
    /* 这条不变量原来是拿 `me.visibleSiteIds.length` 去比的 —— 而那个字段
       已经删掉了（它随中心数线性变长，是 /v1/me 上的一颗定时炸弹）。
       不变量本身没变、也仍然值得守：**服务端自己报的范围，必须和它
       真的给出来的行数对得上**。两者不一致意味着 scopeLabel 是编的，
       而那是用户唯一能看到的"我能看见多少"。
       现在从 scopeLabel 里把数取出来比 —— 那正是它对外承诺的东西。 */
    for (const login of LOGINS) {
      const me = await C[login]!.get("/v1/me");
      const list = await C[login]!.get("/v1/study-sites?limit=200");
      const said = /(\d+)\s*个中心/.exec(me.body.scopeLabel as string)?.[1];
      expect(said, `${login} 的 scopeLabel 里没有中心数：${me.body.scopeLabel}`).toBeTruthy();
      expect(Number(said), login).toBe(list.body.items.length);
    }
  });

  it("范围外的中心返回 404 而不是 403 —— 403 等于确认它存在", async () => {
    const all = await C.lingyuan!.get("/v1/study-sites?limit=200");
    const mine = new Set((await C.wutong!.get("/v1/study-sites?limit=200"))
      .body.items.map((x: { id: string }) => x.id));
    const outside = all.body.items.find((x: { id: string }) => !mine.has(x.id));
    const r = await C.wutong!.get(`/v1/study-sites/${outside.id}`);
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("not-found");
  });

  it("查询参数不能扩大范围，只能在范围内收窄", async () => {
    const foreign = (await C.lingyuan!.get("/v1/study-sites?limit=200"))
      .body.items.find((x: { hospital: string }) => x.hospital !== "北京协和医院");
    const r = await C.zhanghm!.get(`/v1/study-sites?hospital=${encodeURIComponent(foreign.hospital)}`);
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(0);
  });

  it("两个 PM 的可见集合不重叠，并集为全集", async () => {
    const a = (await C.hanxue!.get("/v1/study-sites?limit=200")).body.items.map((x: any) => x.id);
    const b = (await C.cendi!.get("/v1/study-sites?limit=200")).body.items.map((x: any) => x.id);
    expect(a.filter((x: string) => b.includes(x))).toEqual([]);
    expect(new Set([...a, ...b]).size).toBe(15);
  });
});

describe("列维度：无权限的字段消失，不是 null", () => {
  it("经营层看得到报价字段", async () => {
    const r = await C.lingyuan!.get("/v1/study-sites?limit=1");
    expect(r.body.items[0].unitPriceCents).toBeTypeOf("number");
  });

  it("CRA 看得到中心，但报价字段**不在响应里**", async () => {
    const r = await C.linmin!.get("/v1/study-sites?limit=1");
    const item = r.body.items[0];
    expect(item.code).toBeTruthy();
    expect("unitPriceCents" in item).toBe(false);
    expect("startupFeeCents" in item).toBe(false);
    /* 关键：不是 null。null 会泄漏「这个字段存在」 */
    expect(JSON.stringify(item)).not.toContain("unitPriceCents");
  });

  it("嵌套字段同样脱敏 —— 项目合同额藏在 study 里也不行", async () => {
    const r = await C.linmin!.get("/v1/studies?limit=5");
    for (const s of r.body.items) expect("contractAmountCents" in s).toBe(false);
    const boss = await C.lingyuan!.get("/v1/studies?limit=5");
    expect(boss.body.items[0].contractAmountCents).toBeTypeOf("number");
  });

  it("外部角色默认什么敏感字段都拿不到", async () => {
    for (const login of ["zhanghm", "chenguod"]) {
      const r = await C[login]!.get("/v1/study-sites?limit=5");
      for (const item of r.body.items) {
        expect("unitPriceCents" in item, login).toBe(false);
        expect("startupFeeCents" in item, login).toBe(false);
      }
    }
  });
});

describe("动作维度：看得到不等于能操作", () => {
  it("非 manage 角色调用停用账号 → 403", async () => {
    const target = (await C.lingyuan!.get("/v1/accounts?limit=200")).body.items
      .find((a: { login: string }) => a.login === "tangyan");
    const r = await C.linmin!.post(`/v1/accounts/${target.id}:disable`,
      { reason: "测试越权" }, { "Idempotency-Key": crypto.randomUUID() });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("forbidden-action");
  });

  it("非 advance 角色调用推进阶段 → 403", async () => {
    const site = (await C.wutong!.get("/v1/study-sites?limit=1")).body.items[0];
    const r = await C.wutong!.post(`/v1/study-sites/${site.id}:advance`,
      { to: "closed" }, { "Idempotency-Key": crypto.randomUUID() });
    expect(r.status).toBe(403);
  });

  it("动作权限先于行范围判定 —— 越权动作不会顺带泄漏「这个 id 存不存在」", async () => {
    const r = await C.wutong!.post(
      `/v1/study-sites/00000000-0000-0000-0000-0000000000zz:advance`.replace("zz", "01"),
      { to: "closed" }, { "Idempotency-Key": crypto.randomUUID() });
    expect(r.status).toBe(403);
  });

  it("有 manage 权限的经营层可以调整角色权限，且立即生效", async () => {
    const roles = (await C.lingyuan!.get("/v1/roles")).body.items;
    const cra = roles.find((r: { code: string }) => r.code === "cra");
    expect(cra.visibleFields).not.toContain("price");

    const up = await C.lingyuan!.patch(`/v1/roles/${cra.id}`, {
      visibleFields: [...cra.visibleFields, "price"],
      reason: "临时开放报价字段以验证权限即时生效"
    });
    expect(up.status).toBe(200);

    /* 同一个 CRA 重新发起请求 —— 权限在下一次请求就变了 */
    const after = await C.linmin!.get("/v1/study-sites?limit=1");
    expect(after.body.items[0].unitPriceCents).toBeTypeOf("number");

    /* 收回 */
    await C.lingyuan!.patch(`/v1/roles/${cra.id}`, {
      visibleFields: cra.visibleFields, reason: "验证完毕，收回报价字段权限"
    });
    const back = await C.linmin!.get("/v1/study-sites?limit=1");
    expect("unitPriceCents" in back.body.items[0]).toBe(false);
  });
});

describe("account 表：外部方只看得到自己", () => {
  it("内部员工看得到全部账号", async () => {
    const r = await C.linmin!.get("/v1/accounts?limit=200");
    expect(r.body.items.length).toBe(20);
  });
  it("机构办只看得到自己", async () => {
    const r = await C.zhanghm!.get("/v1/accounts?limit=200");
    expect(r.body.items.map((a: { login: string }) => a.login)).toEqual(["zhanghm"]);
  });
});
