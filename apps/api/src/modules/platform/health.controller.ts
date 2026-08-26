import { Controller, Get, Inject } from "@nestjs/common";
import type { Pool } from "pg";
import { POOL } from "../../infra/db.js";
import { Public, Operation } from "../../auth/guards.js";
import { ProblemException } from "../../infra/problem.js";

/* ════════════════════════════════════════════════════════════════════
   两个探针。区别是本质性的，不是命名上的：

     /v1/health        存活 —— 绝不碰数据库
     /v1/health/ready  就绪 —— 必须碰数据库

   存活接上数据库，一次数据库抖动就会让编排器重启全部实例，
   把数据库故障放大成全站故障；就绪不碰数据库，等于把连不上库的实例
   放进负载均衡。两个方向都错得很贵，所以分开写、分开说。

   注意这两条**绕开了请求中间件**（见 app.module 的 exclude）：
   中间件对每个请求取连接 + BEGIN，存活探针要是也走那条路，
   它就间接依赖数据库了 —— 那正是上面要避免的事。
   ════════════════════════════════════════════════════════════════════ */
@Controller("/v1/health")
export class HealthController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  @Get() @Public() @Operation("liveness")
  live() {
    return { status: "ok" as const, uptimeSec: Math.floor(process.uptime()) };
  }

  @Get("/ready") @Public() @Operation("readiness")
  async ready() {
    const t0 = Date.now();
    try {
      /* 自己从池子里取连接、自己还回去 —— 这里没有请求事务可用。
         查询要足够轻（SELECT 1），但**必须真的往返一次**：
         只检查"池子对象存在"是查不出网络断了的。 */
      const c = await this.pool.connect();
      try { await c.query("SELECT 1"); } finally { c.release(); }
    } catch {
      /* 不把原始错误throw出去：探针是公开面，
         连接串、主机名、栈都不该出现在这里。 */
      throw new ProblemException("service-unavailable", {
        detail: "数据库不可达，本实例暂不接收流量。" });
    }
    return { status: "ready" as const, checkMs: Date.now() - t0 };
  }
}
