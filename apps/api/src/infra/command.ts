import { allEndpoints } from "@sitedesk/contracts";
import { IdempotencyService } from "./idempotency.service.js";
import { ProblemException } from "./problem.js";
import { ctx } from "./ctx.js";
import { emit } from "./log.js";

/* 这个端点最终会用哪个状态码 —— 取自**契约**，不是猜的。
   Nest 的默认值：POST 201，其余 200；契约显式写了 status 就以它为准。 */
const DECLARED = new Map(allEndpoints().map(
  (e) => [e.id, e.status ?? (e.method === "post" ? 201 : 200)] as const));

/**
 * L2 命令的幂等外壳。
 *
 * 每个命令都写一遍这段太啰嗦，更要紧的是**漏写一个不会有任何提示**——
 * 而漏写的那个命令，正是 CRC 在信号不好的地铁站里重试三次的那个。
 */
export async function command<T>(
  idem: IdempotencyService, key: string | undefined, body: unknown, run: () => Promise<T>
): Promise<T> {
  if (!key) throw new ProblemException("validation-failed", {
    detail: "L2 命令必须携带 Idempotency-Key 请求头",
    issues: [{ path: "/headers/idempotency-key", message: "必填" }] });
  /* ── response_status 曾经是一句空话 ──────────────────────────────
     原来这里写死 `complete(key, 200, out)`，而重放时调用方只取 body、
     把 status 丢掉 —— 一个**只写不读、而且写的还不是真值**的列。

     现在写进去的是契约声明的那个码。响应状态本身仍然由 Nest 按路由
     元数据给出（重放走的是同一条路由，所以两次天然一致）——
     这一列的用处因此不是"决定状态码"，而是**发现不一致**：
     两次调用之间如果有人把端点的状态码改了并发布了，重放回去的 body
     配的就是另一个码。那种事故没有别的地方会说出来。 */
  const declared = DECLARED.get(ctx().operationId ?? "") ?? 200;
  const replay = await idem.begin(key, body);
  if (replay) {
    if (replay.status !== declared)
      emit("warn", "idempotency",
        "重放的状态码与端点当前声明的不一致 —— 这两次调用之间端点改过",
        { stored: replay.status, declared });
    return replay.body as T;
  }
  const out = await run();
  await idem.complete(key, declared, out);
  return out;
}

/**
 * L1 写入的幂等外壳 —— **键可有可无**。
 *
 * L2 命令必须带键（那是契约里写死的）。L1 的创建类端点原来完全没有这一层，
 * 于是它们在断网时也进不了发件箱：重放一个没有幂等键的创建请求，
 * 就是实实在在的两笔工时、两个受试者。
 *
 * 带了键就走和 L2 一样的那条路（同键同体返回首次结果）；
 * 没带就照旧执行 —— 旧客户端不带也照发，这不是一次破坏性变更。
 */
export async function idempotent<T>(
  idem: IdempotencyService, key: string | undefined, body: unknown, run: () => Promise<T>
): Promise<T> {
  if (!key) return run();
  return command(idem, key, body, run);
}
