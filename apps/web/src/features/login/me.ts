import { call } from "../../api/client.js";

/* ════════════════════════════════════════════════════════════════════
   当前身份 —— 一次取，多处用。

   为什么要有这个模块，而不是每个页面各自 call("getMe")：
   `/v1/me` 是**每个页面都要问一遍**的东西（我是谁、我能做什么），
   各自取会在一次导航里发出四五个同样的请求；更糟的是各自缓存，
   于是登出之后有的页面还拿着旧身份。

   所以：一个模块级的 in-flight Promise，登出时清掉。
   ════════════════════════════════════════════════════════════════════ */

export interface Me {
  account: {
    id: string; login: string; displayName: string;
    role: { code: string; name: string; isExternal: boolean };
  };
  scopeLabel: string;
  permissions: {
    rowRule: string; fields: string[]; actions: string[]; modules: string[];
  };
}

let inflight: Promise<Me> | null = null;

export function loadMe(): Promise<Me> {
  inflight ??= call<Me>("getMe").catch(e => { inflight = null; throw e; });
  return inflight;
}

/** 登出、换人，都必须让下一次 loadMe() 重新去问。 */
export const forgetMe = () => { inflight = null; };
