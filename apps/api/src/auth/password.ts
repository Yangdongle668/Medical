import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

/* ════════════════════════════════════════════════════════════════════
   口令。

   到这个阶段为止，系统只有一次性链接一条入口 —— 那对机构老师和 PI
   是对的（一周登录两次的人不会记得住密码），但它有一个前提：
   **得先有人在库里，而且登记过收件地址**。而一次干净的部署跑完，
   库里一个账号都没有 —— 于是没有人能登进去建第一个账号。

   所以这里加的不是"另一种登录方式"，是**开机的那把钥匙**。

   ── 为什么是 scrypt 而不是 bcrypt / argon2 ──────────────────────────
   node:crypto 自带，不引依赖。参数按 RFC 7914 的建议取
   N=16384 r=8 p=1（约 16 MB 内存、单次几十毫秒）——
   比 bcrypt 更抗 GPU，且不必为一个二进制扩展去改镜像。

   ── 编码 ────────────────────────────────────────────────────────────
     scrypt$N$r$p$<salt base64url>$<derived base64url>
   参数写在串里，不写在代码里：以后调高 N，老口令仍然验得过，
   下一次改密自然升上去。把参数当常量读的实现，调参那天会把所有人锁在门外。
   ════════════════════════════════════════════════════════════════════ */

const scrypt = promisify(scryptCb) as
  (pw: string | Buffer, salt: Buffer, keylen: number, opts: object) => Promise<Buffer>;

const N = 16384, R = 8, P = 1, KEYLEN = 32, MAXMEM = 64 * 1024 * 1024;

export async function hashPassword(plain: string, salt = randomBytes(16)): Promise<string> {
  const dk = await scrypt(norm(plain), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${dk.toString("base64url")}`;
}

/** 恒定时间比对。**串对不上时也要把 scrypt 跑完** —— 见下面那段注释。 */
export async function verifyPassword(plain: string, stored: string | null): Promise<boolean> {
  const parts = (stored ?? "").split("$");
  if (parts[0] !== "scrypt" || parts.length !== 6) {
    /* 账号没有口令、或者串坏了。**照样烧掉一次 scrypt 的时间**：
       直接 return false 的话，"这个账号有没有设过口令"就能用秒表读出来，
       而那正是登录接口最不该泄漏的一位信息。 */
    await scrypt(norm(plain), randomBytes(16), KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
    return false;
  }
  const [, n, r, p, salt, want] = parts as [string, string, string, string, string, string];
  const opts = { N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM };
  if (!Number.isSafeInteger(opts.N) || !Number.isSafeInteger(opts.r) || !Number.isSafeInteger(opts.p))
    return false;
  const expect = Buffer.from(want, "base64url");
  const got = await scrypt(norm(plain), Buffer.from(salt, "base64url"), expect.length, opts);
  return got.length === expect.length && timingSafeEqual(got, expect);
}

/** 出厂口令是不是还在用。库里存的是哈希，只能靠标记，验不出来。 */
export const FACTORY_PASSWORD = "admin";

/* NFKC：全角字符与半角在视觉上一样，在字节上不一样。
   有人用中文输入法打出 ｐａｓｓ，下次用英文输入法就登不进去了 ——
   而界面上两个串看起来完全相同。 */
const norm = (s: string) => s.normalize("NFKC");

/** 口令强度。只拦真正拦得住的那几件事，不搞"必须含大写和符号"。 */
export function passwordProblem(plain: string): string | null {
  const s = norm(plain);
  if (s.length < 8) return "口令至少 8 位";
  if (s.length > 200) return "口令最长 200 位";
  if (/^\s|\s$/.test(s)) return "口令首尾不能是空白 —— 复制粘贴时最容易多带一个空格";
  if (WEAK.has(s.toLowerCase())) return "这个口令在任何一份常见口令表的前一百名里，换一个";
  return null;
}
const WEAK = new Set([
  "admin", "password", "12345678", "123456789", "1234567890", "qwertyui",
  "admin123", "password1", "password123", "abc12345", "iloveyou", "sitedesk",
  "11111111", "00000000", "adminadmin", "administrator"
]);
