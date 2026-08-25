import { IdempotencyService } from "./idempotency.service.js";
import { ProblemException } from "./problem.js";

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
  const replay = await idem.begin(key, body);
  if (replay) return replay.body as T;
  const out = await run();
  await idem.complete(key, 200, out);
  return out;
}
