import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

/* ════════════════════════════════════════════════════════════════════
   落库的可还原密文。**目前只有一处用它：SMTP 口令。**

   ── 为什么不是哈希 ──────────────────────────────────────────────
   `auth_password` 存哈希，因为登录只需要"对不对"。SMTP 口令不一样：
   它必须被还原出来交给邮件服务器。所以这里是**加密**，不是散列 ——
   而加密意味着有一把钥匙，钥匙在哪儿就是这个模块的全部内容。

   ── 钥匙在环境变量里，不在库里 ──────────────────────────────────
   放库里等于没加密：拿到 dump 的人同时拿到密文和钥匙。
   所以钥匙来自 `SITEDESK_SECRET_KEY`，只在进程内存里。

   **没配钥匙时不许存明文。** 调用方会拿到一个说得明白的异常，
   由它翻译成给人看的话。一份会进备份、进从库、进 dump 的明文口令，
   比"这个功能暂时不能用"糟得多。

   ── AES-256-GCM，不是 CBC ──────────────────────────────────────
   GCM 自带完整性校验：密文被改过一个字节，解密直接抛，
   而不是还原出一段被篡改的口令去连一台别人的服务器。

   ── 密文格式 ────────────────────────────────────────────────────
   `v1.<iv>.<tag>.<密文>`，三段都是 base64url。带版本号是为了
   将来换算法时能认出旧数据 —— 不带的话，换算法那天只能猜。
   ════════════════════════════════════════════════════════════════════ */

const ALG = "aes-256-gcm";
const PREFIX = "v1";

/** 缺钥匙时抛这个 —— 调用方据此给出"去服务器上设一个"那句话。 */
export class NoSecretKey extends Error {
  constructor() {
    super("没有配置 SITEDESK_SECRET_KEY，无法安全地保存口令");
    this.name = "NoSecretKey";
  }
}

export const hasSecretKey = (env: NodeJS.ProcessEnv = process.env): boolean =>
  (env["SITEDESK_SECRET_KEY"] ?? "").trim().length >= 16;

/** 把任意长度的钥匙串规整成 32 字节。
 *
 *  用 SHA-256 而不是直接截断/补零：截断会让"前 32 个字符相同"的两把
 *  钥匙变成同一把，而那种事没有任何征兆。
 *
 *  这不是 KDF —— 钥匙本来就该是随机的高熵串（`openssl rand -base64 32`），
 *  不是人想出来的口令。所以不需要慢哈希，需要的只是定长。 */
function keyOf(env: NodeJS.ProcessEnv): Buffer {
  const raw = (env["SITEDESK_SECRET_KEY"] ?? "").trim();
  if (raw.length < 16) throw new NoSecretKey();
  return createHash("sha256").update(raw, "utf8").digest();
}

const b64 = (b: Buffer) => b.toString("base64url");
const un64 = (s: string) => Buffer.from(s, "base64url");

export function seal(plain: string, env: NodeJS.ProcessEnv = process.env): string {
  const iv = randomBytes(12);
  const c = createCipheriv(ALG, keyOf(env), iv);
  const out = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [PREFIX, b64(iv), b64(c.getAuthTag()), b64(out)].join(".");
}

export function open(sealed: string, env: NodeJS.ProcessEnv = process.env): string {
  const [v, iv, tag, body] = sealed.split(".");
  if (v !== PREFIX || !iv || !tag || !body)
    throw new Error(`密文格式不认识（期望 ${PREFIX}.iv.tag.body）`);
  const d = createDecipheriv(ALG, keyOf(env), un64(iv));
  d.setAuthTag(un64(tag));
  /* 钥匙换过、密文被改过，都在这一行抛 —— 而不是还原出一段
     看起来像口令的垃圾，拿去连一台服务器。 */
  return Buffer.concat([d.update(un64(body)), d.final()]).toString("utf8");
}
