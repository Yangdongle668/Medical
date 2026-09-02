import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { PageQuery, Uuid, DateOnly, MonitorKind, MonitorState, QueryBool }
  from "@sitedesk/contracts";
import { MonitorService } from "./monitor.service.js";
import { IdempotencyService } from "../../infra/idempotency.service.js";
import { command } from "../../infra/command.js";
import { ZodPipe } from "../../infra/zod.pipe.js";
import { Operation } from "../../auth/guards.js";

const arr = <T extends z.ZodType>(t: T) =>
  z.union([t, z.array(t)]).transform(v => Array.isArray(v) ? v : [v]).optional();

const ListQ = PageQuery.extend({
  studySiteId: Uuid.optional(),
  kind: arr(MonitorKind),
  state: arr(MonitorState),
  mine: QueryBool.optional(),
  openOnly: QueryBool.optional()
});
const BoardQ = z.object({ studyId: Uuid.optional() });
const Plan = z.object({
  studySiteId: Uuid,
  kind: MonitorKind,
  plannedOn: DateOnly,
  monitorAccountId: Uuid.optional(),
  days: z.number().positive().max(30),
  sdvSamplePct: z.int().min(1).max(100).optional(),
  note: z.string().trim().max(500).optional(),
  items: z.array(z.string().trim().min(4).max(300)).min(1).max(30)
});
const Perform = z.object({ performedOn: DateOnly.optional() });
const ItemDone = z.object({ done: z.boolean() });

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
  board(@Query(new ZodPipe(BoardQ)) q: z.infer<typeof BoardQ>) {
    return this.svc.board(q);
  }

  @Get("/monitor-visits") @Operation("listMonitorVisits")
  list(@Query(new ZodPipe(ListQ)) q: z.infer<typeof ListQ>) {
    return this.svc.list(q);
  }

  @Post("/monitor-visits") @Operation("planMonitorVisit") @HttpCode(201)
  plan(
    @Body(new ZodPipe(Plan)) b: z.infer<typeof Plan>,
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
    @Body(new ZodPipe(Perform)) b: z.infer<typeof Perform>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.perform(id, b)); }

  @Post("/monitor-visits/:id/items/:seq\\:done") @Operation("setMonitorItemDone")
  itemDone(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Param("seq", new ZodPipe(z.coerce.number().int().min(0))) seq: number,
    @Body(new ZodPipe(ItemDone)) b: z.infer<typeof ItemDone>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.setItemDone(id, seq, b)); }

  @Post("/monitor-visits/:id\\:report") @Operation("submitMonitorReport")
  report(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(z.object({}))) b: unknown,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.submitReport(id)); }
}
