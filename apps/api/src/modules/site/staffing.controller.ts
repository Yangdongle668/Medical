import { ListStartupChecklistsQuery, ListStaffQuery, ListSiteStaffQuery,
  ListSiteAssignmentsQuery, ListRegistrationDutiesQuery, AssignSiteStaffBody, EndSiteAssignmentBody,
  ListHandoversQuery, CreateHandoverBody } from "@sitedesk/contracts";
import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { PageQuery, Uuid, DateOnly, WithReason, RoleKind, HandoverStatus, QueryBool }
  from "@sitedesk/contracts";
import { StaffingService } from "./staffing.service.js";
import { IdempotencyService } from "../../infra/idempotency.service.js";
import { ZodPipe } from "../../infra/zod.pipe.js";
import { Operation } from "../../auth/guards.js";
import { command, idempotent } from "../../infra/command.js";

@Controller("/v1")
export class StaffingController {
  constructor(
    private readonly svc: StaffingService,
    private readonly idem: IdempotencyService
  ) {}

  @Get("/startup-checklists") @Operation("listStartupChecklists")
  listChecklists(@Query(new ZodPipe(ListStartupChecklistsQuery)) q: z.infer<typeof ListStartupChecklistsQuery>) {
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
  staff(@Query(new ZodPipe(ListStaffQuery)) q: z.infer<typeof ListStaffQuery>) { return this.svc.listStaff(q); }

  @Get("/site-staff") @Operation("listSiteStaff")
  siteStaff(@Query(new ZodPipe(ListSiteStaffQuery)) q: z.infer<typeof ListSiteStaffQuery>) {
    return this.svc.listSiteStaff(q);
  }

  @Get("/site-assignments") @Operation("listSiteAssignments")
  assignments(@Query(new ZodPipe(ListSiteAssignmentsQuery)) q: z.infer<typeof ListSiteAssignmentsQuery>) {
    return this.svc.listAssignments(q);
  }

  @Get("/registration-duties") @Operation("listRegistrationDuties")
  duties(@Query(new ZodPipe(ListRegistrationDutiesQuery))
    q: z.infer<typeof ListRegistrationDutiesQuery>) {
    return this.svc.listRegistrationDuties(q);
  }

  /* 派工的两端。**幂等键必需**（command 而不是 idempotent）——
     它们改的是行范围本身：重放一次「派上去」和真的派两次，
     在审计上是两件不同的事，而重叠约束会让第二次以 23P01 收场，
     报错指不到这里。 */
  @Post("/staff/:id\\:assign-sites") @Operation("assignSiteStaff")
  assign(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(AssignSiteStaffBody)) b: z.infer<typeof AssignSiteStaffBody>,
    @Headers("idempotency-key") key: string
  ) {
    return command(this.idem, key, { id, ...b }, () => this.svc.assign(id, b));
  }

  @Post("/staff/:id\\:end-assignments") @Operation("endSiteAssignment")
  endAssignment(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(EndSiteAssignmentBody)) b: z.infer<typeof EndSiteAssignmentBody>,
    @Headers("idempotency-key") key: string
  ) {
    return command(this.idem, key, { id, ...b }, () => this.svc.endAssignment(id, b));
  }

  @Get("/handovers") @Operation("listHandovers")
  handovers(@Query(new ZodPipe(ListHandoversQuery)) q: z.infer<typeof ListHandoversQuery>) {
    return this.svc.listHandovers(q);
  }

  /* 幂等键在这里是**可选**的：带了就走幂等那条路（重放返回首次结果），
     没带就照旧。断网时这些创建请求要能排进发件箱，而重放意味着同一个
     请求可能发两次 —— 没有键的话，那就是实实在在的两笔。 */
  @Post("/handovers") @Operation("createHandover") @HttpCode(201)
  createHandover(
    @Body(new ZodPipe(CreateHandoverBody)) b: z.infer<typeof CreateHandoverBody>,
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
