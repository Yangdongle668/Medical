import { allEndpoints, type Endpoint } from "@sitedesk/contracts";
import { enqueue } from "./outbox.js";

/* ════════════════════════════════════════════════════════════════════
   API client —— **由契约注册表直接派生**。

   Phase 0 的目录规划里写的是「由 openapi.yaml 生成的 client」。
   这里少走一步：openapi.yaml 本身就是由同一份注册表生成的，
   直接读注册表等于读同一个源，还省掉一个代码生成器和它的漂移风险。
   （偏离已记在 docs/05。）

   于是有一件事是编译期保证的：**契约里没有的端点，前端调不出来。**
   operationId 打错一个字母，tsc 立刻报错，而不是运行时 404。
   ════════════════════════════════════════════════════════════════════ */

const BY_ID = new Map(allEndpoints().map(e => [e.id, e]));

export type OperationId = ReturnType<typeof allEndpoints>[number]["id"];

export interface ProblemDetails {
  type: string; title: string; status: number; code: string;
  detail?: string; instance?: string; traceId?: string;
  issues?: { path: string; message: string }[];
  unmet?: { code: string; message: string; module?: string }[];
  invariant?: string;
}

export class ApiError extends Error {
  constructor(readonly problem: ProblemDetails) {
    super(problem.detail ?? problem.title);
  }
}

export interface CallOptions {
  /** 路径参数，如 { id } */
  params?: Record<string, string | number>;
  query?: Record<string, unknown>;
  body?: unknown;
  /** L2 命令必填。不传则由 client 生成 —— 但**离线重放必须传自己保存的那个**。 */
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** 面向人的一句话，断网入队时显示在发件箱里。
   *  不给的话发件箱里就只剩一个 operationId，人看不出那是哪次活。 */
  label?: string;
  /** 重放通道：由发件箱调用，失败就是失败，不再入队（否则会自我复制）。 */
  noQueue?: boolean;
}

/** 断网时 L2 命令被收进发件箱 —— **不是失败，是还没发出去**。
 *
 *  继承 ApiError 是为了让既有页面的
 *  `catch (e) { if (e instanceof ApiError) setProblem(e.problem) }`
 *  原样就能把它显示出来。在这之前，网络错误会被 `else throw e` 再抛出去，
 *  落进没人接的 promise —— 按钮弹回来，什么都没有，那次活就没了。 */
export class QueuedError extends ApiError {
  constructor(readonly item: { seq: number; label: string }) {
    super({
      type: "https://sitedesk.dev/problems/queued-offline",
      title: "已放进发件箱",
      status: 0,
      code: "queued-offline",
      detail: `当前连不上服务器，「${item.label}」已排队，联网后会自动发送。` +
        "它带着自己的幂等键，重发不会记成两笔。"
    });
  }
}

let token: string | null = null;
export const setToken = (t: string | null) => { token = t; };
export const getToken = () => token;

function buildPath(e: Endpoint, params?: Record<string, string | number>): string {
  return e.path.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = params?.[k];
    if (v === undefined)
      throw new Error(`${e.id}: 缺少路径参数 ${k}`);
    return encodeURIComponent(String(v));
  });
}

function buildQuery(q?: Record<string, unknown>): string {
  if (!q) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === "") continue;
    /* 数组参数重复出现同名键（?state=a&state=b），与后端的 arr() 管道一致 */
    if (Array.isArray(v)) for (const x of v) sp.append(k, String(x));
    else sp.append(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export const BASE = "/v1";

export async function call<T = unknown>(
  id: OperationId, opts: CallOptions = {}
): Promise<T> {
  const e = BY_ID.get(id);
  if (!e) throw new Error(`契约里没有端点 ${id}`);

  const url = buildPath(e, opts.params) + buildQuery(opts.query);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  /* **幂等键在发请求之前就定下来。**
     以前它是在拼 headers 时顺手生成的，那样断网重试就会换一把新键 ——
     服务端看到的是两条不同的命令，于是记两笔。
     先生成、再尝试、入队时连它一起存，重放时原样带上：
     这一条是整个离线队列能成立的前提。 */
  /* L2 命令必须带键。**L1 的写入现在也带** —— 在此之前只有 L2 进队列，
     L1 的那几个 POST（填工时、建受试者、建交接单）断网时直接抛错：
     人做的事就这么没了。要让它们排队，就必须有幂等键，
     因为重放意味着同一个请求可能发两次 —— 没有键的话那是两笔工时。
     auth 的几个端点除外：排一次登录没有意义（而且它们也不该被重放）。 */
  const idem = e.layer === "L2" || (e.method !== "get" && e.context !== "auth")
    ? (opts.idempotencyKey ?? crypto.randomUUID()) : undefined;
  if (e.method !== "get") {
    headers["Content-Type"] = "application/json";
    if (idem) headers["Idempotency-Key"] = idem;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: e.method.toUpperCase(),
      headers,
      ...(e.method === "get" ? {} : { body: JSON.stringify(opts.body ?? {}) }),
      ...(opts.signal ? { signal: opts.signal } : {})
    });
  } catch (err) {
    /* 走到这里表示**没拿到响应**：断网、DNS、连接中途断掉、被 abort。
       服务端返回的任何状态码都不会走 catch —— 那些是 res.ok 的事。

       注意这里**不能**推断"请求一定没到服务端"：
       请求发出去、服务端处理完、响应在回来的路上丢了，也长这个样子。
       所以入队重发是有可能"发第二次"的 ——
       **而这正是幂等键存在的理由**：重放带着同一把键，
       服务端认得它，返回首次的结果，不会产生第二次副作用。
       安全性来自那把键，不来自"它应该没到"这种猜测。 */
    if (idem && !opts.noQueue) {
      const who = queueOwner();
      if (who) {
        const label = opts.label ?? e.summary;
        const item = enqueue({
          ...who, operationId: id, label, idempotencyKey: idem,
          ...(opts.params ? { params: opts.params } : {}),
          ...(opts.query ? { query: opts.query } : {}),
          ...(opts.body !== undefined ? { body: opts.body } : {})
        });
        throw new QueuedError({ seq: item.seq, label });
      }
    }
    throw err;
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(json as ProblemDetails);
  return json as T;
}

/** 入队要知道是谁排的 —— 共用电脑上不许把 A 的活用 B 的会话发出去。
 *  由 shell 在拿到 /v1/me 之后设置；没有身份时不入队（也就没法冒名）。 */
let owner: { accountId: string; accountName: string } | null = null;
export const setQueueOwner = (o: typeof owner) => { owner = o; };
/** 队列的归属人。界面上「这一行待发」只能是**本人**排的那一条：
 *  共用电脑上队列里可能躺着上一个人的活，把它显示成"你刚勾的"是骗人。 */
export const queueOwner = () => owner;

/** 端点元数据 —— 界面上要知道「这个动作是不是 L2」「要不要动作权限」。 */
export const endpoint = (id: OperationId): Endpoint => {
  const e = BY_ID.get(id);
  if (!e) throw new Error(`契约里没有端点 ${id}`);
  return e;
};
