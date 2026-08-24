import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { makePool, POOL } from "./infra/db.js";
import { ProblemFilter } from "./infra/problem.js";
import { RequestMiddleware } from "./infra/request.middleware.js";
import { TxInterceptor } from "./infra/tx.interceptor.js";
import { MaskInterceptor } from "./infra/mask.interceptor.js";
import { AuditService } from "./infra/audit.service.js";
import { IdempotencyService } from "./infra/idempotency.service.js";
import { AuthGuard, ActionGuard } from "./auth/guards.js";
import { AuthService } from "./auth/auth.service.js";
import { AuthController } from "./auth/auth.controller.js";
import { IdentityService } from "./modules/identity/identity.service.js";
import { IdentityController } from "./modules/identity/identity.controller.js";
import { SiteService } from "./modules/site/site.service.js";
import { SiteController } from "./modules/site/site.controller.js";

/* 拦截器执行顺序 = 注册顺序（外 → 内）：
   TxInterceptor 在最外层，保证脱敏之后才提交/回滚；
   MaskInterceptor 紧贴处理器，对**所有**出口统一脱敏。 */
@Module({
  controllers: [AuthController, IdentityController, SiteController],
  providers: [
    { provide: POOL, useFactory: () => makePool() },
    AuthService, AuditService, IdempotencyService, IdentityService, SiteService,
    { provide: APP_FILTER, useClass: ProblemFilter },
    { provide: APP_INTERCEPTOR, useClass: TxInterceptor },
    { provide: APP_INTERCEPTOR, useClass: MaskInterceptor },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: ActionGuard }
  ]
})
export class AppModule implements NestModule {
  configure(c: MiddlewareConsumer) { c.apply(RequestMiddleware).forRoutes("*path"); }
}
