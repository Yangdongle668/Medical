import { call, setToken, ApiError } from "../../api/client.js";
import { forgetMe } from "./me.js";

/* ════════════════════════════════════════════════════════════════════
   会话。

   令牌存在 sessionStorage 而不是 localStorage：
   **关掉标签页就该断开。** 这是共用电脑的场景决定的 ——
   医院示教室那台机器，上一个人是谁没人说得准。

   也没有存进 cookie：会话要能被服务端单方面撤销（停用即断线），
   而那件事已经由 auth_session 表做到了；cookie 只会多一条
   需要同步失效的副本。
   ════════════════════════════════════════════════════════════════════ */

const KEY = "sitedesk.token";
/** 上一次成功拿到的身份。**只用来认领发件箱里的活，不用来判权限。** */
const WHO = "sitedesk.who";

export function loadToken(): string | null {
  try {
    const t = sessionStorage.getItem(KEY);
    setToken(t);
    return t;
  } catch { return null; }          // 隐私模式下 sessionStorage 会抛
}

export function saveToken(t: string | null) {
  setToken(t);
  /* 换令牌就是换身份 —— 缓存的 /v1/me 必须跟着作废，
     否则登出再登入另一个人，侧栏还挂着上一个人的名字与权限。 */
  forgetMe();
  try { t ? sessionStorage.setItem(KEY, t) : sessionStorage.removeItem(KEY); }
  catch { /* 存不下就只在内存里活着，刷新即失效 —— 可以接受 */ }
  /* 换令牌 = 换人：缓存的身份必须跟着走，否则冷启动时会用上一个人的
     名字去认领队列里的活。 */
  if (!t) { try { sessionStorage.removeItem(WHO); } catch { /* 同上 */ } }
}

/* ── 冷启动就离线的那种情况 ────────────────────────────────────────
   队列归属由 `/v1/me` 之后设置。打开应用时就没有网络的话，
   loadMe() 失败 → 没有归属 → **L2 命令根本入不了队**，
   于是那次在地下室做的活直接抛错丢掉了。主场景（进了地下室才断网）
   是覆盖住的，冷启动这一条不是。

   补法只能缓存身份，而那立刻牵出一个权限问题：
   **缓存的身份算不算一次有效登录？**

   这里的答案是**不算**：
     · 它只回答"发件箱里这条活是谁排的"，让人做的事不至于凭空消失；
     · 它**不**用来渲染权限（能看哪些中心、点得动哪些按钮）——
       那些一律等真正的 /v1/me 回来；离线时界面明说自己不知道。
     · 它存在 sessionStorage，和令牌同一个生命周期：关掉标签页就没了。
   换句话说：它能替你**排队**，不能替你**放行**。 */
export interface CachedWho { accountId: string; accountName: string; at: string }

export function rememberWho(accountId: string, accountName: string) {
  try {
    sessionStorage.setItem(WHO, JSON.stringify(
      { accountId, accountName, at: new Date().toISOString() } satisfies CachedWho));
  } catch { /* 存不下就退回原来的行为：冷启动离线时不入队 */ }
}

export function recallWho(): CachedWho | null {
  try {
    const raw = sessionStorage.getItem(WHO);
    if (!raw) return null;
    const w = JSON.parse(raw) as CachedWho;
    return w && typeof w.accountId === "string" && w.accountId ? w : null;
  } catch { return null; }
}

export interface SessionGranted { token: string; expiresAt: string }

/** 开发登录：只在后端 SITEDESK_DEV_LOGIN=1 时存在，生产 404。
 *
 *  **刻意绕开 call()**：这个端点不在公开契约里（把一个后门写进契约，
 *  等于告诉别人有这么个后门），而 call() 会拒绝契约里没有的 operationId ——
 *  那正是它该有的行为。所以这里直接 fetch，并且只此一处。 */
export async function devLogin(login: string): Promise<SessionGranted> {
  const res = await fetch("/v1/auth/dev-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login })
  });
  if (!res.ok) {
    const p = await res.json().catch(() => ({}));
    throw new ApiError({
      type: "", title: "开发登录不可用", status: res.status,
      code: res.status === 404 ? "not-found" : "unauthenticated",
      detail: (p as { detail?: string }).detail
        ?? "后端未开启 SITEDESK_DEV_LOGIN，或该账号不存在"
    });
  }
  const s = await res.json() as SessionGranted;
  saveToken(s.token);
  return s;
}

/** 申请一次性链接。**存在与不存在的账号返回同样的 202** —— 不做账号枚举器。 */
export async function requestLink(login: string) {
  return call<{ accepted: boolean; message: string; devToken?: string }>(
    "requestMagicLink", { body: { login } });
}

/** 兑换链接换会话。兑换在数据库里原子完成，并发只有一次能成功。 */
export async function redeem(token: string): Promise<SessionGranted> {
  const s = await call<SessionGranted>("redeemMagicLink", { body: { token } });
  saveToken(s.token);
  return s;
}

/** 口令登录。三种失败（账号不存在 / 没设口令 / 口令不对）拿到的是同一句话。 */
export async function passwordLogin(login: string, password: string): Promise<SessionGranted> {
  const s = await call<SessionGranted>("passwordLogin", { body: { login, password } });
  saveToken(s.token);
  return s;
}

/** 改自己的口令。改完服务端只留当前这个会话，所以**不必**重新登录。 */
export async function changePassword(currentPassword: string, newPassword: string) {
  await call("changePassword", { body: { currentPassword, newPassword } });
  /* 缓存的 /v1/me 里带着 credentials.passwordIsInitial —— 改完那条红条要下去，
     而它下不去的话，人会以为改密没生效，然后再改一遍。 */
  forgetMe();
}

export async function logout() {
  try { await call("logout"); } finally { saveToken(null); }
}
