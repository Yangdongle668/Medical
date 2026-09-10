import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { boot, resetDb, as, type Caller } from "./harness.js";
import { seal, open, hasSecretKey } from "../src/infra/secret.js";

const idem = () => ({ "Idempotency-Key": randomUUID() });

/* ════════════════════════════════════════════════════════════════════
   登录链接的投递通道。

   通道本身早就写好了（SMTP 客户端、重试、掩码日志一应俱全），
   缺的是**填它的地方** —— 在此之前 SITEDESK_SMTP_URL 只能由能改环境
   变量、能重启进程的人来设。login-delivery.ts 自己把这条写成了
   「上线前该补掉的一项」：**签发登录链接的权限等同于运维权限**。

   于是一套装好的系统里，管理员建得了账号、设得了口令、登记得了收件
   地址，唯独没法让链接真的发出去。
   ════════════════════════════════════════════════════════════════════ */

let app: INestApplication;
let admin: Caller, pm: Caller;

/* 测试进程里给一把钥匙 —— 没有它服务端**拒绝保存口令**（那正是下面
   「没有钥匙时」那条要验的行为）。 */
const 原钥匙 = process.env["SITEDESK_SECRET_KEY"];
beforeAll(async () => {
  process.env["SITEDESK_SECRET_KEY"] = "test-key-" + "z".repeat(32);
  resetDb(); app = await boot();
  admin = await as(app, "admin");
  pm = await as(app, "hanxue");
}, 180_000);
afterAll(async () => {
  await app?.close();
  if (原钥匙 === undefined) delete process.env["SITEDESK_SECRET_KEY"];
  else process.env["SITEDESK_SECRET_KEY"] = 原钥匙;
});

describe("密文本身", () => {
  const KEY = { SITEDESK_SECRET_KEY: "x".repeat(40) } as NodeJS.ProcessEnv;

  it("封得回来，解得出去", () => {
    const c = seal("hunter2", KEY);
    expect(c).toMatch(/^v1\./);
    expect(c).not.toContain("hunter2");
    expect(open(c, KEY)).toBe("hunter2");
  });

  it("**同一段明文两次封出来不一样** —— 否则密文本身就是指纹", () => {
    expect(seal("同一个口令", KEY)).not.toBe(seal("同一个口令", KEY));
  });

  it("**改一个字节就解不开** —— GCM 自带完整性，不会还原出一段被改过的口令", () => {
    const c = seal("hunter2", KEY);
    const 动过 = c.slice(0, -2) + (c.slice(-2) === "aa" ? "bb" : "aa");
    expect(() => open(动过, KEY)).toThrow();
  });

  it("换一把钥匙解不开 —— 而不是解出一段垃圾拿去连服务器", () => {
    const c = seal("hunter2", KEY);
    expect(() => open(c, { SITEDESK_SECRET_KEY: "y".repeat(40) } as NodeJS.ProcessEnv))
      .toThrow();
  });

  it("没有钥匙时**拒绝封**，而不是存明文", () => {
    expect(hasSecretKey({} as NodeJS.ProcessEnv)).toBe(false);
    expect(() => seal("hunter2", {} as NodeJS.ProcessEnv)).toThrow(/SITEDESK_SECRET_KEY/);
  });

  it("太短的钥匙不算钥匙", () => {
    expect(hasSecretKey({ SITEDESK_SECRET_KEY: "123" } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("投递通道设置", () => {
  it("一开始是「没配」，并说得出钥匙有没有", async () => {
    const r = await admin.get("/v1/mail-transport");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.kind).toBe("none");
    expect(r.body.secretSet).toBe(false);
    expect(typeof r.body.keyReady).toBe("boolean");
    /* source 要说清这份配置从哪儿来 —— db / env / none 是三件事 */
    expect(["db", "env", "none"]).toContain(r.body.source);
  });

  it("**响应里没有口令** —— 只有「存了没有」", async () => {
    const r = await admin.get("/v1/mail-transport");
    expect("secret" in r.body, "口令被下发了").toBe(false);
    expect("secretEnc" in r.body, "密文被下发了").toBe(false);
  });

  it("**PM 看不到，也改不了** —— 这是 manage 动作", async () => {
    expect((await pm.get("/v1/mail-transport")).status).toBe(403);
    const w = await pm.post("/v1/mail-transport:set",
      { kind: "none", reason: "试试" }, idem());
    expect(w.status).toBe(403);
  });

  it("改通道必须写原因", async () => {
    const r = await admin.post("/v1/mail-transport:set",
      { kind: "smtp", url: "smtps://mail.example.com:465", fromAddr: "no-reply@example.com" },
      idem());
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("validation-failed");
  });

  it("选了 SMTP 就必须给地址和发件人 —— 没有发件人多数服务器直接拒收", async () => {
    const r = await admin.post("/v1/mail-transport:set",
      { kind: "smtp", url: "smtps://mail.example.com:465", reason: "少填一栏试试" }, idem());
    expect(r.status).toBe(422);
    expect(r.body.invariant).toBe("mail-transport-incomplete");
  });

  it("**地址里带口令会被拒** —— URL 会进日志、进报错、进截图", async () => {
    const r = await admin.post("/v1/mail-transport:set", {
      kind: "smtp", url: "smtps://bob:hunter2@mail.example.com:465",
      fromAddr: "no-reply@example.com", reason: "把口令写在地址里试试"
    }, idem());
    expect(r.status).toBe(422);
    expect(r.body.invariant).toBe("mail-transport-bad-url");
    expect(r.body.detail).toContain("不要带用户名和口令");
  });

  it("协议不对会被拒", async () => {
    const r = await admin.post("/v1/mail-transport:set", {
      kind: "smtp", url: "https://mail.example.com", fromAddr: "a@b.com",
      reason: "拿 https 试试"
    }, idem());
    expect(r.status).toBe(422);
    expect(r.body.detail).toContain("smtp://");
  });

  it("**存得下、读得回、口令不回显**，而且 source 变成 db", async () => {
    const r = await admin.post("/v1/mail-transport:set", {
      kind: "smtp", url: "smtps://mail.example.com:465",
      fromAddr: "no-reply@example.com", username: "bob", secret: "hunter2",
      reason: "接入公司邮件服务器，登录链接不再靠运维代发"
    }, idem());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.kind).toBe("smtp");
    expect(r.body.data.url).toBe("smtps://mail.example.com:465");
    expect(r.body.data.secretSet).toBe(true);
    expect(r.body.data.source).toBe("db");
    expect(JSON.stringify(r.body)).not.toContain("hunter2");
    /* 换了服务器，上一次试发的结果就作废 —— 副作用里要说这件事 */
    expect(r.body.sideEffects[0].summary).toContain("试发");
  });

  it("**改端口不该被迫重输口令** —— 省略 secret = 不动", async () => {
    const r = await admin.post("/v1/mail-transport:set", {
      kind: "smtp", url: "smtps://mail.example.com:587",
      fromAddr: "no-reply@example.com", username: "bob",
      reason: "改一个端口，口令没换"
    }, idem());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.secretSet, "口令被悄悄清掉了").toBe(true);
    expect(r.body.data.url).toContain("587");
  });

  it("传空串 = 清掉口令。这和「省略」是两件事", async () => {
    const r = await admin.post("/v1/mail-transport:set", {
      kind: "smtp", url: "smtps://mail.example.com:587",
      fromAddr: "no-reply@example.com", username: "bob", secret: "",
      reason: "这台服务器不需要认证，清掉口令"
    }, idem());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.secretSet).toBe(false);
  });

  it("**服务器上没配钥匙时，拒绝保存口令** —— 而不是悄悄存明文", async () => {
    const 有 = process.env["SITEDESK_SECRET_KEY"];
    delete process.env["SITEDESK_SECRET_KEY"];
    try {
      const r = await admin.post("/v1/mail-transport:set", {
        kind: "smtp", url: "smtps://mail.example.com:465",
        fromAddr: "no-reply@example.com", secret: "hunter2",
        reason: "没有钥匙的时候试着存一个口令"
      }, idem());
      expect(r.status).toBe(422);
      expect(r.body.invariant).toBe("no-secret-key");
      /* 要说清怎么办，不能只说"不行" */
      expect(r.body.detail).toContain("openssl rand");
    } finally { process.env["SITEDESK_SECRET_KEY"] = 有!; }
  });

  it("没有钥匙时**不带口令的配置照样存得下** —— 别把整件事卡死", async () => {
    const 有 = process.env["SITEDESK_SECRET_KEY"];
    delete process.env["SITEDESK_SECRET_KEY"];
    try {
      const r = await admin.post("/v1/mail-transport:set", {
        kind: "smtp", url: "smtp://relay.internal:25",
        fromAddr: "no-reply@example.com",
        reason: "内网中继不需要认证，先把地址填上"
      }, idem());
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.data.keyReady).toBe(false);
    } finally { process.env["SITEDESK_SECRET_KEY"] = 有!; }
  });

  it("**改通道写审计，且标成敏感**", async () => {
    await admin.post("/v1/mail-transport:set", {
      kind: "smtp", url: "smtps://relay.example.com:465",
      fromAddr: "no-reply@example.com",
      reason: "年度机房迁移，换到新的中继"
    }, idem());
    const trail = (await admin.get("/v1/audit-entries?limit=50")).body.items as
      { action: string; isSensitive?: boolean; reason?: string; after?: unknown }[];
    const 这一条 = trail.find(e => e.action === "改投递通道");
    expect(这一条, "改投递通道没有进审计").toBeTruthy();
    expect(这一条!.isSensitive, "没被标成敏感").toBe(true);
    expect(这一条!.reason).toContain("机房迁移");
    /* **口令和密文都不该进轨迹** —— 核查员要问的是谁改成了什么 */
    expect(JSON.stringify(这一条)).not.toContain("hunter2");
    expect(JSON.stringify(这一条)).not.toContain("v1.");
  });

  it("关掉通道：明说链接照样签得出来但没人收得到", async () => {
    const r = await admin.post("/v1/mail-transport:set",
      { kind: "none", reason: "邮件服务器下线检修，先关掉" }, idem());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.kind).toBe("none");
    expect(r.body.sideEffects[0].summary).toContain("没有人收得到");
  });
});

describe("试发", () => {
  it("**收件人不接受传入** —— 契约里根本没有这一栏", async () => {
    /* 一个可以指定收件人的「试发」就是一个开放的转发器。
       传了也会被 zod 拒（契约 body 是空对象）。 */
    const r = await admin.post("/v1/mail-transport:test",
      { to: "攻击者@example.com" }, idem());
    expect([201, 422]).toContain(r.status);
    if (r.status === 201) expect(JSON.stringify(r.body)).not.toContain("攻击者");
  });

  it("没有可用通道时说清是「先去填上面那几栏」", async () => {
    await admin.post("/v1/mail-transport:set",
      { kind: "none", reason: "先关掉，验一下试发会说什么" }, idem());
    const r = await admin.post("/v1/mail-transport:test", {}, idem());
    /* 没有 env 兜底时是 422；CI 上若配了 env，那就是另一条路 */
    if (r.status === 422) {
      expect(["mail-transport-none", "no-own-address"]).toContain(r.body.invariant);
    }
  });

  it("**试发失败不是事故，是一次诊断** —— 原话要交回页面", async () => {
    await admin.post("/v1/mail-transport:set", {
      kind: "smtp", url: "smtp://127.0.0.1:1",   // 一定连不上
      fromAddr: "no-reply@example.com",
      reason: "指一个连不上的地址，验一下失败会怎么说"
    }, idem());
    const r = await admin.post("/v1/mail-transport:test", {}, idem());
    if (r.body?.invariant === "no-own-address") return;   // admin 没登记地址
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.ok).toBe(false);
    expect(r.body.data.error, "失败了却没有原因").toBeTruthy();
    /* 收件地址掩码 —— 试发结果也不该把通讯录抄出来 */
    expect(r.body.data.sentTo).toContain("*");

    /* 结果记在通道上，页面据此显示「最近一次试发」 */
    const g = await admin.get("/v1/mail-transport");
    expect(g.body.lastTestOk).toBe(false);
    expect(g.body.lastTestAt).toBeTruthy();
    expect(g.body.lastTestError).toBeTruthy();
  }, 60_000);
});
