import { z } from "zod";
import { define } from "../kernel/registry.js";

/* ════════════════════════════════════════════════════════════════════
   平台面 —— 给编排器看的两个探针。

   **存活与就绪必须分开，而且分得很清楚：**

     存活（liveness）  这个进程还活着吗？→ 绝不碰数据库。
     就绪（readiness） 现在能接流量吗？  → 必须真的碰一下数据库。

   把存活也接到数据库上是一个很常见、代价很大的错误：
   数据库抖一下，所有实例的存活探针一起失败，编排器把它们**全部重启** ——
   一次数据库故障就此被放大成一次全站故障，而重启风暴还会让数据库
   恢复得更慢。存活只回答"要不要重启我"，那和数据库无关。

   反过来，就绪探针**必须**真的探一次库，并且在探不通时返回 **503**：
   只回 200 的就绪探针等于没有 —— 编排器只看状态码，
   它会把一个连不上库的实例照样放进负载均衡。

   两个都不需要认证（控制器上标 @Public()）：探针在拿到凭据之前就要能用。
   代价是它们也成了公开面，所以两者都**不返回任何内部细节**：
   没有版本号、没有主机名、没有连接串、没有栈。
   ════════════════════════════════════════════════════════════════════ */

const CTX = "platform";

export const Liveness = z.object({
  status: z.literal("ok"),
  uptimeSec: z.number().int().nonnegative()
}).meta({ id: "Liveness" });

export const Readiness = z.object({
  status: z.literal("ready"),
  /** 探库耗时。在编排器日志里，"慢"和"断"是两回事，得分得出来。 */
  checkMs: z.number().int().nonnegative()
}).meta({ id: "Readiness" });

define({
  id: "liveness", method: "get", path: "/v1/health",
  layer: "L1", context: CTX, status: 200,
  summary: "存活探针（不碰数据库）",
  description:
    "只回答「这个进程要不要被重启」。**绝不碰数据库** —— " +
    "接上数据库的话，一次数据库抖动会让编排器重启全部实例，" +
    "把数据库故障放大成全站故障。\n\n" +
    "无需认证。不返回任何内部细节。",
  response: Liveness
});

define({
  id: "readiness", method: "get", path: "/v1/health/ready",
  layer: "L1", context: CTX, status: 200,
  summary: "就绪探针（真的探一次库）",
  description:
    "**真的探一次库**，探不通返回 503。\n" +
    "只回 200 的就绪探针等于没有 —— 编排器只看状态码，" +
    "它会把一个连不上库的实例照样放进负载均衡。\n\n" +
    "无需认证。不返回任何内部细节。",
  response: Readiness,
  errors: ["service-unavailable"]
});
