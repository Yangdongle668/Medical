import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import {
  PageQuery, Uuid, DateOnly, CentsNonNeg, WithReason, WorkType, RoleKindForRate, QueryBool
} from "@sitedesk/contracts";
import { CostService } from "./cost.service.js";
import { IdempotencyService } from "../../infra/idempotency.service.js";
import { command, idempotent } from "../../infra/command.js";
import { ZodPipe } from "../../infra/zod.pipe.js";
import { Operation } from "../../auth/guards.js";

const arr = <T extends z.ZodType>(t: T) =>
  z.union([t, z.array(t)]).transform(v => Array.isArray(v) ? v : [v]).optional();

const TimesheetQ = PageQuery.extend({
  studySiteId: Uuid.optional(),
  accountId: Uuid.optional(),
  workType: arr(WorkType),
  from: DateOnly.optional(), to: DateOnly.optional(),
  includeVoided: QueryBool.optional()
});
const CreateTimesheet = z.object({
  studySiteId: Uuid,
  workDate: DateOnly,
  workType: WorkType,
  hours: z.number().min(0.25).max(24),
  travelCents: CentsNonNeg.optional(),
  subjectId: Uuid.optional(),
  note: z.string().max(500).optional()
});
const RateQ = PageQuery.extend({ roleKind: RoleKindForRate.optional() });
const CreateRate = z.object({
  roleKind: RoleKindForRate,
  level: z.string().max(16).nullable().optional(),
  dayCostCents: CentsNonNeg.min(1),
  validFrom: DateOnly,
  validTo: DateOnly.nullable().optional(),
  note: z.string().max(200).optional()
});

@Controller("/v1")
export class CostController {
  constructor(
    private readonly svc: CostService,
    private readonly idem: IdempotencyService
  ) {}

  @Get("/timesheets") @Operation("listTimesheets")
  list(@Query(new ZodPipe(TimesheetQ)) q: z.infer<typeof TimesheetQ>) {
    return this.svc.listTimesheets(q);
  }

  /* 幂等键在这里是**可选**的：带了就走幂等那条路（重放返回首次结果），
     没带就照旧。断网时这些创建请求要能排进发件箱，而重放意味着同一个
     请求可能发两次 —— 没有键的话，那就是实实在在的两笔。 */
  @Post("/timesheets") @Operation("createTimesheet") @HttpCode(201)
  create(
    @Body(new ZodPipe(CreateTimesheet)) b: z.infer<typeof CreateTimesheet>,
    @Headers("idempotency-key") key?: string
  ) {
    return idempotent(this.idem, key, b, () => this.svc.createTimesheet(b));
  }

  @Post("/timesheets/:id\\:void") @Operation("voidTimesheet")
  void_(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(WithReason)) b: z.infer<typeof WithReason>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.voidTimesheet(id, b)); }

  @Get("/rate-cards") @Operation("listRateCards")
  rates(@Query(new ZodPipe(RateQ)) q: z.infer<typeof RateQ>) {
    return this.svc.listRateCards(q);
  }

  @Post("/rate-cards") @Operation("createRateCard") @HttpCode(201)
  createRate(
    @Body(new ZodPipe(CreateRate)) b: z.infer<typeof CreateRate>,
    @Headers("idempotency-key") key?: string
  ) {
    return idempotent(this.idem, key, b, () => this.svc.createRateCard(b));
  }

  @Post("/rate-cards/:id\\:close") @Operation("closeRateCard")
  closeRate(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(z.object({ validTo: DateOnly }))) b: { validTo: string },
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.closeRateCard(id, b)); }

  @Get("/study-sites/:id/pnl") @Operation("getSitePnl")
  pnl(@Param("id", new ZodPipe(Uuid)) id: string) { return this.svc.sitePnl(id); }
}
