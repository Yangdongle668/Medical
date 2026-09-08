/* ════════════════════════════════════════════════════════════════════
   幂等键用的 UUID v4。

   ── 为什么不能直接 `crypto.randomUUID()` ────────────────────────────
   **它只在安全上下文里存在。** https、`localhost`、`127.0.0.1` 有它；
   `http://192.168.1.20:8080` 没有 —— `crypto.randomUUID` 是 `undefined`，
   调用它抛的是

       TypeError: crypto.randomUUID is not a function

   而这正是这套系统被部署起来之后最常见的打开方式：README 里写着
   TLS 握手交给前面那层 ingress、`强制 https 默认关`（"纯 http 的部署会
   当场打不开"），`.env.example` 里 `SITEDESK_PUBLIC_ORIGIN=http://localhost:8080`。
   装在一台机器上、同事从别的机器用 IP 打开 —— 那就是个非安全上下文。

   代价不是"少一个功能"：`client.ts` 给**每一个非 GET 请求**都生成幂等键，
   所以整台系统上**所有写操作**都在那一行抛错。建账号、填工时、
   推进中心、完成访视，一个都点不动。而本机开发与 e2e 全跑在
   localhost 上 —— 那里 `randomUUID` 一直好好的，所以这件事在
   313 条 e2e、580 条 api 测试里一次都撞不上。

   ── 为什么退到 getRandomValues，而不是 Math.random ──────────────────
   `crypto.getRandomValues` **在非安全上下文里也有**（被 gate 的是
   `randomUUID` 与 `crypto.subtle`）。所以退一步就够了，不必退两步。

   Math.random 不行，而且理由不是"不够随机"这种泛泛的话：
   幂等键撞了的后果是**服务端把一条新命令当成旧命令的重放**，
   原样返回上一次的结果、不做事、也不报错。那是静默丢活 ——
   正是发件箱那一整套设计要防的东西。所以宁可当场抛一个说得清的错。
   ════════════════════════════════════════════════════════════════════ */

/** RFC 4122 版本 4 的 UUID。 */
export function uuid(): string {
  const c: Crypto | undefined = globalThis.crypto;

  /* 有就用它 —— 浏览器自带的实现比这里这段快，也少一次出错的机会。 */
  if (typeof c?.randomUUID === "function") return c.randomUUID();

  if (typeof c?.getRandomValues !== "function")
    throw new Error(
      "这个浏览器没有 crypto.getRandomValues，生成不了幂等键。" +
      "没有幂等键的写请求会被服务端拒绝 —— 请换一个浏览器，" +
      "或者把站点放到 https 后面。");

  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;   // 版本 4
  b[8] = (b[8]! & 0x3f) | 0x80;   // 变体 10xx
  const h = Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-` +
         `${h.slice(16, 20)}-${h.slice(20)}`;
}
