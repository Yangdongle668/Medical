import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { uuid } from "../src/api/uuid.js";

/* ════════════════════════════════════════════════════════════════════
   幂等键在**非安全上下文**里也得生成得出来。

   ── 这条测试是为哪次事故写的 ────────────────────────────────────
   `client.ts` 给每一个非 GET 请求生成幂等键，写的是 `crypto.randomUUID()`。
   那个函数**只在安全上下文里存在** —— https、localhost、127.0.0.1 有，
   `http://192.168.1.20:8080` 没有。于是把系统装到一台机器上、
   同事从别的机器用 IP 打开，F12 里是：

       TypeError: crypto.randomUUID is not a function

   而它挂的不是某一个按钮：**整台系统的写操作全废**，
   建账号、填工时、推进中心、完成访视，一个都点不动。

   ── 为什么 313 条 e2e 一次都没撞上 ──────────────────────────────
   Playwright 打的是 `http://127.0.0.1:4173` —— 那是安全上下文，
   `randomUUID` 在那里一直好好的。本机开发同理。
   **这个 bug 只在"真的装起来给别人用"的时候才出现**，
   而那条路上没有任何自动化。

   所以这里把那个上下文**造出来**：删掉 randomUUID，只留 getRandomValues。
   ════════════════════════════════════════════════════════════════════ */

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const real = globalThis.crypto.randomUUID;
afterEach(() => {
  Object.defineProperty(globalThis.crypto, "randomUUID",
    { value: real, configurable: true, writable: true });
});

/** 拿掉 randomUUID，模拟 http://<IP> 打开时的 window.crypto。 */
function 非安全上下文() {
  Object.defineProperty(globalThis.crypto, "randomUUID",
    { value: undefined, configurable: true, writable: true });
}

describe("uuid()：幂等键", () => {
  it("安全上下文里就是浏览器那一个", () => {
    expect(uuid()).toMatch(V4);
  });

  it("**没有 crypto.randomUUID 时照样生成得出来** —— 这一条就是那次事故", () => {
    非安全上下文();
    expect(() => crypto.randomUUID()).toThrow();   // 前提成立：它确实没了
    expect(uuid()).toMatch(V4);
  });

  it("版本位与变体位是对的，不是随手拼的十六进制", () => {
    非安全上下文();
    for (let i = 0; i < 200; i++) {
      const u = uuid();
      expect(u, u).toMatch(V4);
      expect(u[14], `第三段必须以 4 开头：${u}`).toBe("4");
      expect("89ab", `第四段必须是 8/9/a/b 开头：${u}`).toContain(u[19]);
    }
  });

  it("不重复 —— 幂等键撞了等于服务端把新命令当成旧命令的重放", () => {
    非安全上下文();
    /* 撞了不会报错：服务端原样返回上一次的结果、不做事。
       那是静默丢活，正好是发件箱那一整套要防的东西。 */
    const n = 5000;
    expect(new Set(Array.from({ length: n }, uuid)).size).toBe(n);
  });
});

/* 光修一处不够：下一个人照样会写 `crypto.randomUUID()`，
   而它在开发机上完全正常 —— 错误只会出现在别人的机器上。 */
describe("别再直接用 crypto.randomUUID", () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const SRC = path.resolve(HERE, "../src");

  function sources(dir: string, acc: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) sources(p, acc);
      else if (/\.tsx?$/.test(e.name)) acc.push(p);
    }
    return acc;
  }

  it("apps/web/src 里只有 api/uuid.ts 提得起这个名字", () => {
    const bad = sources(SRC)
      .filter(f => path.basename(f) !== "uuid.ts")
      .filter(f => /(?<!\/\/.*)\bcrypto\.randomUUID\s*\(/.test(
        /* 注释里提它是在讲这个坑，不算犯规 */
        fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "")
          .split("\n").filter(l => !/^\s*(\/\/|\*)/.test(l)).join("\n")))
      .map(f => path.relative(SRC, f));
    expect(bad, "这些地方在非安全上下文（http://<IP>）里会抛 TypeError，改用 api/uuid.ts 的 uuid()")
      .toEqual([]);
  });
});
