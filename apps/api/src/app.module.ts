import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { makePool, POOL } from "./infra/db.js";
import { HealthController } from "./modules/platform/health.controller.js";
import { ProblemFilter } from "./infra/problem.js";
import { RequestMiddleware } from "./infra/request.middleware.js";
import { TxInterceptor } from "./infra/tx.interceptor.js";
import { MaskInterceptor } from "./infra/mask.interceptor.js";
import { AuditService } from "./infra/audit.service.js";
import { IdempotencyService } from "./infra/idempotency.service.js";
import { RateLimitService } from "./infra/rate-limit.service.js";
import { LoginDelivery } from "./infra/login-delivery.js";
import { NotifyService } from "./infra/notify.js";
import { startGc } from "./infra/gc.js";
import { AuthGuard, ActionGuard } from "./auth/guards.js";
import { AuthService } from "./auth/auth.service.js";
import { AuthController } from "./auth/auth.controller.js";
import { IdentityService } from "./modules/identity/identity.service.js";
import { IdentityController } from "./modules/identity/identity.controller.js";
import { SiteService } from "./modules/site/site.service.js";
import { SiteController } from "./modules/site/site.controller.js";
import { StaffingService } from "./modules/site/staffing.service.js";
import { StaffingController } from "./modules/site/staffing.controller.js";
import { ClinicalService } from "./modules/clinical/clinical.service.js";
import { ClinicalController } from "./modules/clinical/clinical.controller.js";
import { AccountabilityService } from "./modules/clinical/accountability.service.js";
import { AccountabilityController } from "./modules/clinical/accountability.controller.js";
import { CostService } from "./modules/cost/cost.service.js";
import { CostController } from "./modules/cost/cost.controller.js";
import { FeasibilityService } from "./modules/bizdev/feasibility.service.js";
import { BidService } from "./modules/bizdev/bid.service.js";
import { BizdevController } from "./modules/bizdev/bizdev.controller.js";
import { FinanceService } from "./modules/finance/finance.service.js";
import { FinanceController } from "./modules/finance/finance.controller.js";
import { VISIT_TIMESHEET_PORT } from "./modules/clinical/ports.js";

/* 拦截器执行顺序 = 注册顺序（外 → 内）：
   TxInterceptor 在最外层，保证脱敏之后才提交/回滚；
   MaskInterceptor 紧贴处理器，对**所有**出口统一脱敏。 */
@Module({
  controllers: [HealthController, AuthController, IdentityController, SiteController, StaffingController,
                ClinicalController, AccountabilityController, CostController, BizdevController, FinanceController],
  providers: [
    /* 池子必须能被关掉。`enableShutdownHooks()` 会调 `app.close()`，
       而 `app.close()` 只会去调 provider 的 onModuleDestroy ——
       原来这里只有 useFactory，没有任何人负责 `pool.end()`：
       滚动发布时旧实例的连接一直挂到 TCP 超时，
       每个实例 max=10，几轮就能把 postgres 的 max_connections 吃光。 */
    {
      provide: POOL,
      useFactory: () => {
        const pool = makePool();
        /* 过期数据的清理跟着池子一起活、一起死 —— 它要用池子，
           而停机时必须先停它再关池子，否则最后一轮会打在一个关掉的池上。 */
        const gc = startGc(pool);
        return Object.assign(pool, {
          async onModuleDestroy() { gc.stop(); await pool.end(); }
        });
      }
    },
    AuthService, AuditService, IdempotencyService, RateLimitService,
    /* 投递通道按环境变量决定走哪一种；没配就是不发，见 infra/login-delivery.ts。
       NotifyService 复用同一批通道 —— 两套投递逻辑必然漂移，
       而漂移的表现是"有的通知发得出去，有的发不出去"。 */
    LoginDelivery, NotifyService,
    IdentityService, SiteService, StaffingService,
    ClinicalService, AccountabilityService, CostService, FeasibilityService, BidService, FinanceService,
    /* 跨上下文装配：ClinicalOps 只认 ports.ts 里的接口，不 import CostService */
    { provide: VISIT_TIMESHEET_PORT, useExisting: CostService },
    { provide: APP_FILTER, useClass: ProblemFilter },
    { provide: APP_INTERCEPTOR, useClass: TxInterceptor },
    { provide: APP_INTERCEPTOR, useClass: MaskInterceptor },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: ActionGuard }
  ]
})
export class AppModule implements NestModule {
  /* 健康探针照常经过中间件（全局守卫依赖它建立的上下文），
     但中间件对这两条路径**不取连接、不开事务**（见 DBLESS）。 */
  configure(c: MiddlewareConsumer) { c.apply(RequestMiddleware).forRoutes("*path"); }
}
