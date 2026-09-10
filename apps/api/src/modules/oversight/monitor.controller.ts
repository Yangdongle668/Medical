import { GetMonitorBoardQuery, ListMonitorVisitsQuery, PlanMonitorVisitBody, PerformMonitorVisitBody, SetMonitorItemDoneBody } from "@sitedesk/contracts";
import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { PageQuery, Uuid, DateOnly, MonitorKind, MonitorState, QueryBool }
  from "@sitedesk/contracts";
import { MonitorService } from "./monitor.service.js";
import { IdempotencyService } from "../../infra/idempotency.service.js";
import { command } from "../../infra/command.js";
import { ZodPipe } from "../../infra/zod.pipe.js";
import { Operation } from "../../auth/guards.js";

/* `/monitor-visits/board` 必须排在任何 `/monitor-visits/:x` 之前 ——
   否则 board 会被当成一个 id 走进详情路由，而那条路由不存在时
   报的是「不是合法 uuid」，看着像调用方传错了参数。 */
@Controller("/v1")
export class MonitorController {
  constructor(
    private readonly svc: MonitorService,
    private readonly idem: IdempotencyService
  ) {}

  @Get("/monitor-visits/board") @Operation("getMonitorBoard")
  board(@Query(new ZodPipe(GetMonitorBoardQuery)) q: z.infer<typeof GetMonitorBoardQuery>) {
    return this.svc.board(q);
  }

  @Get("/monitor-visits") @Operation("listMonitorVisits")
  list(@Query(new ZodPipe(ListMonitorVisitsQuery)) q: z.infer<typeof ListMonitorVisitsQuery>) {
    return this.svc.list(q);
  }

  @Post("/monitor-visits") @Operation("planMonitorVisit") @HttpCode(201)
  plan(
    @Body(new ZodPipe(PlanMonitorVisitBody)) b: z.infer<typeof PlanMonitorVisitBody>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.plan(b)); }

  @Post("/monitor-visits/:id\\:confirm") @Operation("confirmMonitorVisit")
  confirm(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(z.object({}))) b: unknown,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.confirm(id)); }

  @Post("/monitor-visits/:id\\:perform") @Operation("performMonitorVisit")
  perform(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(PerformMonitorVisitBody)) b: z.infer<typeof PerformMonitorVisitBody>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.perform(id, b)); }

  @Post("/monitor-visits/:id/items/:seq\\:done") @Operation("setMonitorItemDone")
  itemDone(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Param("seq", new ZodPipe(z.coerce.number().int().min(0))) seq: number,
    @Body(new ZodPipe(SetMonitorItemDoneBody)) b: z.infer<typeof SetMonitorItemDoneBody>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.setItemDone(id, seq, b)); }

  @Post("/monitor-visits/:id\\:report") @Operation("submitMonitorReport")
  report(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(z.object({}))) b: unknown,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.submitReport(id)); }
}
