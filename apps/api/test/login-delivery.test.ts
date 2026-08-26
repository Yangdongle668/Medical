import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { sendMail, buildMessage } from "../src/infra/smtp.js";
import {
  deliveryPlan, mask, bodyOf, smsOf, LoginDelivery, subjectOf
} from "../src/infra/login-delivery.js";

/* ════════════════════════════════════════════════════════════════════
   登录链接的投递通道 —— 这套系统上线前必须补的那一件事。

   在此之前 `POST /v1/auth/magic-link` 会签发令牌、写进库，
   然后**不告诉任何人**：一套刚部署好的系统没有任何人能登进去。

   这一组分两半：
     · SMTP 客户端本体 —— 用一个进程内的假服务器真的走一遍协议。
       "发信"这件事最典型的失败方式是"在我的测试环境好好的"，
       所以这里连多行应答、点开头的行、CRLF 都各有一条。
     · 通道选择与文案 —— 纯函数，不连网。

   验过它不是空的：把 STARTTLS 那道检查去掉，
   "不支持 STARTTLS 就拒绝发送"当场红。
   ════════════════════════════════════════════════════════════════════ */

interface Fake {
  server: net.Server; port: number;
  /** 收到的每一条命令（不含 DATA 正文） */
  cmds: string[];
  /** DATA 的正文原文 */
  body: string;
}

/** 一个刚好够用的 SMTP 服务器。 */
function fakeSmtp(opts: { starttls?: boolean; auth?: boolean; failAuth?: boolean } = {}): Promise<Fake> {
  const state: Fake = { server: null as never, port: 0, cmds: [], body: "" };
  const server = net.createServer((sock) => {
    let inData = false, buf = "";
    sock.setEncoding("utf8");
    sock.write("220 fake.example ESMTP\r\n");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      for (;;) {
        const i = buf.indexOf("\r\n");
        if (i < 0) break;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === ".") { inData = false; sock.write("250 OK 收下了\r\n"); }
          else state.body += line + "\r\n";
          continue;
        }
        state.cmds.push(line);
        const up = line.toUpperCase();
        if (up.startsWith("EHLO"))
          /* **多行应答**：带横杠的是"还有下一行"。按第一行判会在这里错位，
             而错位的症状是"某些服务器上发不出去"。 */
          sock.write("250-fake.example 你好\r\n250-PIPELINING\r\n250-SIZE 10240000\r\n" +
            (opts.starttls ? "250-STARTTLS\r\n" : "") +
            (opts.auth ? "250-AUTH PLAIN LOGIN\r\n" : "") + "250 8BITMIME\r\n");
        else if (up.startsWith("AUTH")) sock.write(opts.failAuth
          ? "535 5.7.8 Authentication credentials invalid\r\n" : "235 2.7.0 认证通过\r\n");
        else if (up.startsWith("MAIL FROM") || up.startsWith("RCPT TO")) sock.write("250 OK\r\n");
        else if (up === "DATA") { inData = true; sock.write("354 结束请用 .\r\n"); }
        else if (up === "QUIT") { sock.write("221 再见\r\n"); sock.end(); }
        else sock.write("250 OK\r\n");
      }
    });
    sock.on("error", () => { /* 客户端拒发时会直接断开，正常 */ });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      state.server = server;
      state.port = (server.address() as AddressInfo).port;
      resolve(state);
    });
  });
}

const close = (f: Fake) => new Promise((r) => f.server.close(r));

/** 从 DATA 正文里把 base64 的信体解出来 */
function decodeBody(raw: string): string {
  const b64 = raw.split("\r\n\r\n").slice(1).join("\r\n\r\n").trim().replace(/\r\n/g, "");
  return Buffer.from(b64, "base64").toString("utf8");
}

describe("SMTP 客户端 —— 真的走一遍协议", () => {
  it("发得出去，而且收件人、主题、正文都对", async () => {
    const f = await fakeSmtp({ auth: true });
    try {
      await sendMail(
        { url: `smtp://用户:口令@127.0.0.1:${f.port}?insecure=1`, from: "台<no-reply@hengji.example>" },
        { to: "linmin@hengji.example", subject: "中心台登录链接（15 分钟内有效）",
          text: "点这里：https://台/login?token=abc" });
      expect(f.cmds).toContain("MAIL FROM:<台<no-reply@hengji.example>>");
      expect(f.cmds).toContain("RCPT TO:<linmin@hengji.example>");
      expect(decodeBody(f.body)).toContain("https://台/login?token=abc");
      /* 中文主题必须编码 —— SMTP 的头是 ASCII 的 */
      expect(f.body).toMatch(/Subject: =\?UTF-8\?B\?/);
    } finally { await close(f); }
  });

  it("多行 EHLO 应答不会错位", async () => {
    /* 假服务器的 EHLO 应答有五行。按第一行判的实现会把后面四行
       当成下一条命令的应答，于是整场对话往后错一位。 */
    const f = await fakeSmtp({ auth: true });
    try {
      await sendMail({ url: `smtp://u:p@127.0.0.1:${f.port}?insecure=1`, from: "a@x.example" },
        { to: "b@y.example", subject: "s", text: "t" });
      expect(f.cmds.filter((c) => c.startsWith("EHLO")).length).toBe(1);
      expect(f.cmds.at(-1)).toBe("QUIT");
    } finally { await close(f); }
  });

  it("**服务器不支持 STARTTLS 就拒绝发送** —— 链接是一次性凭据", async () => {
    /* 明文过网等于把凭据交出去。这一条是这个文件里最要紧的一条。 */
    const f = await fakeSmtp({ starttls: false });
    try {
      await expect(sendMail({ url: `smtp://127.0.0.1:${f.port}`, from: "a@x.example" },
        { to: "b@y.example", subject: "s", text: "t" })).rejects.toThrow(/STARTTLS/);
    } finally { await close(f); }
  });

  it("显式 ?insecure=1 才允许明文 —— 而且要自己写出来", async () => {
    const f = await fakeSmtp({ starttls: false });
    try {
      await sendMail({ url: `smtp://127.0.0.1:${f.port}?insecure=1`, from: "a@x.example" },
        { to: "b@y.example", subject: "s", text: "t" });
      expect(f.cmds).toContain("DATA");
    } finally { await close(f); }
  });

  it("认证失败时把服务器原话带出来", async () => {
    /* "535 认证失败"和"550 relay denied"指向完全不同的处置，
       只说"发送失败"等于什么都没说。 */
    const f = await fakeSmtp({ auth: true, failAuth: true });
    try {
      await expect(sendMail({ url: `smtp://u:p@127.0.0.1:${f.port}?insecure=1`, from: "a@x.example" },
        { to: "b@y.example", subject: "s", text: "t" }))
        .rejects.toThrow(/535/);
    } finally { await close(f); }
  });

  it("收件地址里带换行 → 拒发，那是一条 SMTP 注入", async () => {
    const f = await fakeSmtp({ starttls: false });
    try {
      await expect(sendMail({ url: `smtp://127.0.0.1:${f.port}?insecure=1`, from: "a@x.example" },
        { to: "b@y.example\r\nRCPT TO:<偷偷加的@x.example>", subject: "s", text: "t" }))
        .rejects.toThrow(/换行/);
    } finally { await close(f); }
  });
});

describe("信的形状", () => {
  const msg = () => buildMessage("a@x.example",
    { to: "b@y.example", subject: "中文主题", text: "第一行\n.孤零零一个点开头\n最后一行" });

  it("换行一律 CRLF", () => {
    /* 只发 \n 的话，有的服务器接受、有的不认 —— 于是"在测试环境好好的"。 */
    expect(msg().split("\n").every((l, i, all) => i === all.length - 1 || l.endsWith("\r")))
      .toBe(true);
  });

  it("正文是 base64，不会被当成命令截断", () => {
    const m = msg();
    expect(m).toContain("Content-Transfer-Encoding: base64");
    expect(decodeBody(m)).toContain(".孤零零一个点开头");
  });

  it("带上 Auto-Submitted —— 一次性链接不该被客户端预取", () => {
    /* 预取等于替用户点了一次，而链接点过就作废：本人再打开只看到"链接无效"。 */
    expect(msg()).toContain("Auto-Submitted: auto-generated");
  });
});

describe("通道怎么选", () => {
  const env = (o: Record<string, string>) => o as NodeJS.ProcessEnv;

  it("开发环境什么都不配 → console（否则本地根本拿不到链接）", () => {
    expect(deliveryPlan(env({}))).toMatchObject({ email: "console", sms: "console", fatal: [] });
  });

  it("生产环境什么都不配 → 不发，由运维代发", () => {
    expect(deliveryPlan(env({ NODE_ENV: "production" })))
      .toMatchObject({ email: "none", sms: "none" });
  });

  it("**生产环境 + console 通道 → 拒绝启动**", () => {
    /* 它会把可用的登录链接打进日志：所有能读日志的人都能以任何人的身份登录，
       而审计轨迹里看到的是那个人自己。 */
    const p = deliveryPlan(env({ NODE_ENV: "production", SITEDESK_LOGIN_LINK_TRANSPORT: "console" }));
    expect(p.fatal.join()).toMatch(/console/);
  });

  it("配了 SMTP 却没配发件人 → 拒绝启动", () => {
    /* 没有发件人绝大多数服务器直接拒收，而那要等到第一个人申请登录时才发现。 */
    const p = deliveryPlan(env({ SITEDESK_SMTP_URL: "smtp://mail.example:587" }));
    expect(p.fatal.join()).toMatch(/SITEDESK_MAIL_FROM/);
  });

  it("SMTP 地址不是 smtp(s):// → 拒绝启动", () => {
    const p = deliveryPlan(env({
      SITEDESK_SMTP_URL: "https://mail.example", SITEDESK_MAIL_FROM: "a@x.example" }));
    expect(p.fatal.join()).toMatch(/smtp/);
  });

  it("两条通道各走各的", () => {
    const p = deliveryPlan(env({
      NODE_ENV: "production",
      SITEDESK_SMTP_URL: "smtp://mail.example:587", SITEDESK_MAIL_FROM: "a@x.example",
      SITEDESK_SMS_WEBHOOK_URL: "https://sms.example/send" }));
    expect(p).toMatchObject({ email: "smtp", sms: "webhook", fatal: [] });
  });

  it("显式写 none 就是两条都关，哪怕 SMTP 还配着", () => {
    /* "我知道我配了，但现在别发"是一个合法的意图（临时停掉外发）。
       让它被一个还留在 .env 里的旧配置推翻，是最容易出事的那种"聪明"。 */
    const p = deliveryPlan(env({
      SITEDESK_LOGIN_LINK_TRANSPORT: "none",
      SITEDESK_SMTP_URL: "smtp://mail.example:587", SITEDESK_MAIL_FROM: "a@x.example",
      SITEDESK_SMS_WEBHOOK_URL: "https://sms.example/send" }));
    expect(p).toMatchObject({ email: "none", sms: "none", fatal: [] });
  });

  it("不认识的通道名 → 拒绝启动，不悄悄退回默认", () => {
    expect(deliveryPlan(env({ SITEDESK_LOGIN_LINK_TRANSPORT: "smtp" })).fatal.join())
      .toMatch(/不认识/);
  });

  it("没有对应通道时 deliver 说得出来，而不是抛错", async () => {
    /* 响应仍然是同一个 202 —— 差别只写进日志。 */
    const d = new LoginDelivery(env({ NODE_ENV: "production" }));
    expect(await d.deliver({ channel: "email", to: "a@x.example", displayName: null,
      link: "https://台/login?token=x", ttlMin: 15 })).toBe("no-transport");
  });
});

describe("日志里不许出现完整地址", () => {
  it("邮箱留头留尾", () => {
    expect(mask("lingyuan@hengji.example")).toBe("l******n@hengji.example");
    expect(mask("ab@x.example")).toBe("a*@x.example");
  });
  it("手机号只留前三后四", () => {
    expect(mask("+8613800001111")).toBe("+86*******1111");
  });
});

describe("文案", () => {
  const m = { channel: "email" as const, to: "linmin@hengji.example", displayName: "林敏",
    link: "https://台/login?token=abc", ttlMin: 15 };

  it("正文里有链接、有有效期、有「不是你就忽略」", () => {
    const t = bodyOf(m);
    expect(t).toContain(m.link);
    expect(t).toContain("15 分钟");
    expect(t).toContain("忽略");
    expect(t).toContain("林敏");
  });

  it("短信把有效期和链接放在前面，且不长", () => {
    expect(smsOf(m).length).toBeLessThan(140);
    expect(smsOf(m)).toContain(m.link);
  });

  it("主题说得清这是什么、多久失效", () => {
    expect(subjectOf(15)).toBe("中心台登录链接（15 分钟内有效）");
  });
});
