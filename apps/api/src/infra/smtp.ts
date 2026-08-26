/* 最小 SMTP 客户端 —— 只为发一封纯文本信。
 *
 *  ── 为什么不装 nodemailer ────────────────────────────────────────────
 *  这个进程的运行时依赖只有 @nestjs / pg / rxjs / zod 四样，
 *  而它要发的信只有一种：一行正文、一个链接、一个收件人。
 *  为这件事引入一棵依赖树，换来的是一份长期要跟的 CVE 清单 ——
 *  代价不在写代码的这一天，在之后的每一天。
 *
 *  ── 协议里真正会咬人的四处 ──────────────────────────────────────────
 *  ① **多行应答**。`250-PIPELINING` / `250 STARTTLS` —— 带横杠的是"还有"，
 *     带空格的才是最后一行。按第一行判，EHLO 之后就会错位，
 *     而错位的症状是"某些服务器上发不出去"。
 *  ② **点开头的行**。正文里一行单独一个 `.` 就是数据结束符。
 *     不做 dot-stuffing 的话，一封普通的信可能在中途被截断，
 *     剩下的部分被当成 SMTP 命令送进服务器。
 *  ③ **换行必须是 CRLF**。只发 \n 的话，有的服务器接受、有的不认，
 *     于是"在测试环境好好的"。
 *  ④ **中文主题要编码**。SMTP 头是 ASCII 的，直接塞 UTF-8 会变成乱码
 *     或者被拒。用 RFC 2047 的 encoded-word。
 *
 *  ── TLS ──────────────────────────────────────────────────────────────
 *  `smtps://` 直接 TLS；`smtp://` 先明文连上、再 STARTTLS 升级。
 *  **默认必须升级成功**，否则拒绝发送 —— 登录链接是一次性凭据，
 *  明文过网等于把它交出去。真要在内网明文发，得显式 `?insecure=1`。
 */
import net from "node:net";
import tls from "node:tls";

export interface SmtpConfig {
  /** smtp://user:pass@host:port 或 smtps://…。端口缺省：smtps 465，smtp 587 */
  url: string;
  /** 信封与信头的发件人 */
  from: string;
  timeoutMs?: number;
}

export interface Mail { to: string; subject: string; text: string }

/** RFC 2047 encoded-word。主题是中文，直接进头会乱码或被拒。 */
const encodeHeader = (s: string) =>
  /^[\x20-\x7e]*$/.test(s) ? s
    : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;

/** 收件人 / 发件人里绝不能出现 CR LF —— 否则它就成了一条注入的 SMTP 命令。 */
const assertNoCrlf = (v: string, what: string) => {
  if (/[\r\n\0]/.test(v)) throw new Error(`${what} 含有换行符，拒绝发送`);
  return v;
};

/** 一条 TCP/TLS 连接上的 SMTP 会话。 */
class Session {
  private buf = "";
  private waiting: ((line: string) => void) | null = null;
  private failed: Error | null = null;

  constructor(private sock: net.Socket | tls.TLSSocket, private timeoutMs: number) {
    this.attach(sock);
  }

  private attach(sock: net.Socket | tls.TLSSocket) {
    this.sock = sock;
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      this.buf += chunk;
      /* 带横杠的是"还有下一行"，带空格的才是最后一行。 */
      const m = this.buf.match(/^\d{3} [^\r\n]*\r?\n/m);
      if (!m) return;
      const done = this.buf.slice(0, this.buf.indexOf(m[0]) + m[0].length);
      this.buf = this.buf.slice(done.length);
      const w = this.waiting; this.waiting = null;
      w?.(done);
    });
    sock.on("error", (e) => { this.failed = e; this.waiting?.(""); this.waiting = null; });
  }

  /** 读一条完整应答，校验状态码。 */
  private read(expect: number): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.failed) return reject(this.failed);
      const timer = setTimeout(
        () => reject(new Error(`SMTP 等待 ${expect} 应答超时（${this.timeoutMs}ms）`)), this.timeoutMs);
      this.waiting = (reply) => {
        clearTimeout(timer);
        if (this.failed) return reject(this.failed);
        const code = Number(reply.slice(0, 3));
        /* 应答原文带进错误里 —— "550 5.7.1 relay denied" 和
           "535 authentication failed" 指向完全不同的处置，只说"发送失败"等于没说。 */
        if (code !== expect)
          return reject(new Error(`SMTP 期望 ${expect}，收到：${reply.trim()}`));
        resolve(reply);
      };
    });
  }

  async cmd(line: string, expect: number): Promise<string> {
    this.sock.write(line + "\r\n");
    return this.read(expect);
  }

  greet(expect: number) { return this.read(expect); }

  /** 只写不等应答 —— DATA 之后的正文就是这么发的。 */
  write(data: string) { this.sock.write(data); }

  /** STARTTLS 之后同一条 socket 要换成 TLS 的那一条。 */
  upgrade(servername: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const plain = this.sock as net.Socket;
      plain.removeAllListeners("data");
      plain.removeAllListeners("error");
      const secure = tls.connect({ socket: plain, servername }, () => {
        this.buf = "";
        this.attach(secure);
        resolve();
      });
      secure.once("error", reject);
    });
  }

  end() { try { this.sock.end(); } catch { /* 关不掉就算了，信已经发出去了 */ } }
}

const connect = (secure: boolean, host: string, port: number, timeoutMs: number) =>
  new Promise<net.Socket | tls.TLSSocket>((resolve, reject) => {
    const sock = secure
      ? tls.connect({ host, port, servername: host }, () => resolve(sock))
      : net.connect({ host, port }, () => resolve(sock));
    sock.setTimeout(timeoutMs, () => { sock.destroy(new Error("SMTP 连接超时")); });
    sock.once("error", reject);
  });

export async function sendMail(cfg: SmtpConfig, mail: Mail): Promise<void> {
  const u = new URL(cfg.url);
  const implicitTls = u.protocol === "smtps:";
  const insecureOk = u.searchParams.get("insecure") === "1";
  const host = u.hostname;
  const port = Number(u.port || (implicitTls ? 465 : 587));
  const timeoutMs = cfg.timeoutMs ?? 10_000;
  const user = u.username ? decodeURIComponent(u.username) : "";
  const pass = u.password ? decodeURIComponent(u.password) : "";

  assertNoCrlf(mail.to, "收件地址");
  assertNoCrlf(cfg.from, "发件地址");
  assertNoCrlf(mail.subject, "主题");

  const sock = await connect(implicitTls, host, port, timeoutMs);
  const s = new Session(sock, timeoutMs);
  try {
    await s.greet(220);
    let ehlo = await s.cmd(`EHLO ${hostnameForEhlo()}`, 250);

    if (!implicitTls) {
      if (/\bSTARTTLS\b/i.test(ehlo)) {
        await s.cmd("STARTTLS", 220);
        await s.upgrade(host);
        /* 升级之后必须重发 EHLO：能力列表在加密通道上可能不一样
           （AUTH 通常只在这时才出现）。 */
        ehlo = await s.cmd(`EHLO ${hostnameForEhlo()}`, 250);
      } else if (!insecureOk) {
        /* 登录链接是一次性凭据。明文过网等于把它交出去。 */
        throw new Error(
          "SMTP 服务器不支持 STARTTLS，拒绝以明文发送登录链接。" +
          "确实要在内网明文发的话，在 SITEDESK_SMTP_URL 上加 ?insecure=1。");
      }
    }

    if (user || pass) {
      if (/AUTH[ =-][^\r\n]*PLAIN/i.test(ehlo)) {
        const token = Buffer.from(`\0${user}\0${pass}`, "utf8").toString("base64");
        await s.cmd(`AUTH PLAIN ${token}`, 235);
      } else if (/AUTH[ =-][^\r\n]*LOGIN/i.test(ehlo)) {
        await s.cmd("AUTH LOGIN", 334);
        await s.cmd(Buffer.from(user, "utf8").toString("base64"), 334);
        await s.cmd(Buffer.from(pass, "utf8").toString("base64"), 235);
      } else {
        throw new Error("SMTP 服务器没有提供 PLAIN / LOGIN 认证，无法登录");
      }
    }

    await s.cmd(`MAIL FROM:<${cfg.from}>`, 250);
    await s.cmd(`RCPT TO:<${mail.to}>`, 250);
    await s.cmd("DATA", 354);
    s.write(buildMessage(cfg.from, mail));
    await s.cmd(".", 250);
    await s.cmd("QUIT", 221).catch(() => { /* 服务器先挂断也算发出去了 */ });
  } finally {
    s.end();
  }
}

/** EHLO 里报的名字。给不出 FQDN 的时候用方括号 IP 字面量之外最保守的写法。 */
const hostnameForEhlo = () => process.env["SITEDESK_SMTP_EHLO"] || "sitedesk.local";

/** 正文与信头。CRLF、dot-stuffing、base64 正文，三件都不能少。 */
export function buildMessage(from: string, mail: Mail): string {
  const headers = [
    `From: ${from}`,
    `To: ${mail.to}`,
    `Subject: ${encodeHeader(mail.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    /* base64 正文：中文不会被中间的网关按 7bit 截断，
       也顺带绕开了"某一行恰好是一个点"的那件事。 */
    "Content-Transfer-Encoding: base64",
    /* 一次性登录链接不该被邮箱客户端预取 —— 预取等于替用户点了一次，
       而链接是**一次性**的：点过就作废，本人再打开就是"链接无效"。 */
    "Auto-Submitted: auto-generated",
    "X-Auto-Response-Suppress: All"
  ].join("\r\n");
  const body = Buffer.from(mail.text, "utf8").toString("base64")
    .replace(/(.{76})/g, "$1\r\n");
  /* dot-stuffing：base64 不会产出以点开头的行，但这一步不能靠"不会"——
     将来有人把正文换成明文，那个截断会静默发生。 */
  const safe = body.split("\r\n").map((l) => (l.startsWith(".") ? "." + l : l)).join("\r\n");
  return `${headers}\r\n\r\n${safe}\r\n`;
}
