import { allEndpoints, type Endpoint } from "@sitedesk/contracts";

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
  if (e.method !== "get") {
    headers["Content-Type"] = "application/json";
    /* L2 命令必须带幂等键。这里兜底生成，是为了「忘了传」不会变成
       一次静默的重复提交；真正的离线重放要传自己保存的那一个。 */
    if (e.layer === "L2")
      headers["Idempotency-Key"] = opts.idempotencyKey ?? crypto.randomUUID();
  }

  const res = await fetch(url, {
    method: e.method.toUpperCase(),
    headers,
    ...(e.method === "get" ? {} : { body: JSON.stringify(opts.body ?? {}) }),
    ...(opts.signal ? { signal: opts.signal } : {})
  });

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(json as ProblemDetails);
  return json as T;
}

/** 端点元数据 —— 界面上要知道「这个动作是不是 L2」「要不要动作权限」。 */
export const endpoint = (id: OperationId): Endpoint => {
  const e = BY_ID.get(id);
  if (!e) throw new Error(`契约里没有端点 ${id}`);
  return e;
};
