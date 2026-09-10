import {
  Body, Controller, Get, Headers,
  HttpCode, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import {
  Uuid, DateOnly, WithReason, ListTimesheetsQuery,
  CreateTimesheetBody, ListRateCardsQuery, CreateRateCardBody, ListPnlQuery
} from "@sitedesk/contracts";
import { CostService } from "./cost.service.js";
import { IdempotencyService } from "../../infra/idempotency.service.js";
import { command, idempotent } from "../../infra/command.js";
import { ZodPipe } from "../../infra/zod.pipe.js";
import { Operation } from "../../auth/guards.js";

@Controller("/v1")
export class CostController {
  constructor(
    private readonly svc: CostService,
    private readonly idem: IdempotencyService
  ) {}

  @Get("/timesheets") @Operation("listTimesheets")
  list(@Query(new ZodPipe(ListTimesheetsQuery)) q: z.infer<typeof ListTimesheetsQuery>) {
    return this.svc.listTimesheets(q);
  }

  /* 幂等键在这里是**可选**的：带了就走幂等那条路（重放返回首次结果），
     没带就照旧。断网时这些创建请求要能排进发件箱，而重放意味着同一个
     请求可能发两次 —— 没有键的话，那就是实实在在的两笔。 */
  @Post("/timesheets") @Operation("createTimesheet") @HttpCode(201)
  create(
    @Body(new ZodPipe(CreateTimesheetBody)) b: z.infer<typeof CreateTimesheetBody>,
    @Headers("idempotency-key") key?: string
  ) {
    return idempotent(this.idem, key, b, () => this.svc.createTimesheet(b));
  }

  @Post("/timesheets/:id\\:approve") @Operation("approveTimesheet")
  approve(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(z.object({ note: z.string().max(500).optional() })))
      b: { note?: string },
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.approveTimesheet(id, b)); }

  @Post("/timesheets/:id\\:void") @Operation("voidTimesheet")
  void_(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(WithReason)) b: z.infer<typeof WithReason>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.voidTimesheet(id, b)); }

  @Get("/rate-cards") @Operation("listRateCards")
  rates(@Query(new ZodPipe(ListRateCardsQuery)) q: z.infer<typeof ListRateCardsQuery>) {
    return this.svc.listRateCards(q);
  }

  @Post("/rate-cards") @Operation("createRateCard") @HttpCode(201)
  createRate(
    @Body(new ZodPipe(CreateRateCardBody)) b: z.infer<typeof CreateRateCardBody>,
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

  @Get("/study-sites/:id/pnl/monthly") @Operation("getSitePnlTrend")
  pnlTrend(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Query(new ZodPipe(z.object({
      months: z.coerce.number().int().min(1).max(60).optional()
    }))) q: { months?: number }
  ) { return this.svc.sitePnlTrend(id, q.months); }

  @Get("/pnl") @Operation("listPnl")
  listPnl(@Query(new ZodPipe(ListPnlQuery)) q: z.infer<typeof ListPnlQuery>) { return this.svc.listPnl(q); }

  @Get("/study-sites/:id/pnl") @Operation("getSitePnl")
  pnl(@Param("id", new ZodPipe(Uuid)) id: string) { return this.svc.sitePnl(id); }
}
