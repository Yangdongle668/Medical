import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { PageQuery, Uuid, DateOnly, WithReason, RoleKind, HandoverStatus, QueryBool }
  from "@sitedesk/contracts";
import { StaffingService } from "./staffing.service.js";
import { IdempotencyService } from "../../infra/idempotency.service.js";
import { ZodPipe } from "../../infra/zod.pipe.js";
import { Operation } from "../../auth/guards.js";
import { command, idempotent } from "../../infra/command.js";

const StaffQ = PageQuery.extend({
  roleKind: RoleKind.optional(),
  successionGap: QueryBool.optional(),
  activeOnly: QueryBool.optional()
});
const HandoverQ = PageQuery.extend({ status: HandoverStatus.optional() });
const CreateHandover = z.object({
  toAccountId: Uuid,
  studySiteIds: z.array(Uuid).min(1),
  reason: z.string().trim().min(5).max(500),
  plannedOn: DateOnly
});

const ChecklistQ = PageQuery.extend({ blockedOnly: QueryBool.optional() });

@Controller("/v1")
export class StaffingController {
  constructor(
    private readonly svc: StaffingService,
    private readonly idem: IdempotencyService
  ) {}

  @Get("/startup-checklists") @Operation("listStartupChecklists")
  listChecklists(@Query(new ZodPipe(ChecklistQ)) q: z.infer<typeof ChecklistQ>) {
    return this.svc.listChecklists(q);
  }

  @Get("/study-sites/:id/startup-items") @Operation("getStartupChecklist")
  checklist(@Param("id", new ZodPipe(Uuid)) id: string) { return this.svc.checklist(id); }

  @Post("/startup-items/:id\\:complete") @Operation("completeStartupItem")
  complete(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(z.object({ note: z.string().max(500).optional() }))) b: { note?: string },
    @Headers("idempotency-key") key?: string
  ) {
    return command(this.idem, key, { id, ...b },
      () => this.svc.completeItem(id, b.note));
  }

  @Post("/startup-items/:id\\:reopen") @Operation("reopenStartupItem")
  reopen(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(WithReason)) b: { reason: string },
    @Headers("idempotency-key") key?: string
  ) {
    return command(this.idem, key, { id, ...b }, () => this.svc.reopenItem(id, b.reason));
  }

  @Get("/staff") @Operation("listStaff")
  staff(@Query(new ZodPipe(StaffQ)) q: z.infer<typeof StaffQ>) { return this.svc.listStaff(q); }

  @Get("/handovers") @Operation("listHandovers")
  handovers(@Query(new ZodPipe(HandoverQ)) q: z.infer<typeof HandoverQ>) {
    return this.svc.listHandovers(q);
  }

  /* 幂等键在这里是**可选**的：带了就走幂等那条路（重放返回首次结果），
     没带就照旧。断网时这些创建请求要能排进发件箱，而重放意味着同一个
     请求可能发两次 —— 没有键的话，那就是实实在在的两笔。 */
  @Post("/handovers") @Operation("createHandover") @HttpCode(201)
  createHandover(
    @Body(new ZodPipe(CreateHandover)) b: z.infer<typeof CreateHandover>,
    @Headers("idempotency-key") key?: string
  ) {
    return idempotent(this.idem, key, b, () => this.svc.createHandover(b));
  }

  @Post("/handovers/:id/items/:seq\\:done") @Operation("completeHandoverItem")
  itemDone(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Param("seq", new ZodPipe(z.coerce.number().int().min(0))) seq: number,
    @Headers("idempotency-key") key?: string
  ) {
    return command(this.idem, key, { id, seq }, () => this.svc.completeHandoverItem(id, seq));
  }

  @Post("/handovers/:id\\:complete") @Operation("completeHandover")
  completeHandover(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Headers("idempotency-key") key?: string
  ) {
    return command(this.idem, key, { id }, () => this.svc.completeHandover(id));
  }
}
