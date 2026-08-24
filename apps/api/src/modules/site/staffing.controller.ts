import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { PageQuery, Uuid, DateOnly, WithReason, RoleKind, HandoverStatus }
  from "@sitedesk/contracts";
import { StaffingService } from "./staffing.service.js";
import { IdempotencyService } from "../../infra/idempotency.service.js";
import { ZodPipe } from "../../infra/zod.pipe.js";
import { Operation } from "../../auth/guards.js";
import { ProblemException } from "../../infra/problem.js";

const StaffQ = PageQuery.extend({
  roleKind: RoleKind.optional(),
  successionGap: z.coerce.boolean().optional()
});
const HandoverQ = PageQuery.extend({ status: HandoverStatus.optional() });
const CreateHandover = z.object({
  toAccountId: Uuid,
  studySiteIds: z.array(Uuid).min(1),
  reason: z.string().trim().min(5).max(500),
  plannedOn: DateOnly
});

/** L2 命令的幂等外壳 —— 每个命令都要写一遍太啰嗦，收在这里 */
async function command<T>(
  idem: IdempotencyService, key: string | undefined, body: unknown, run: () => Promise<T>
): Promise<T> {
  if (!key) throw new ProblemException("validation-failed", {
    detail: "L2 命令必须携带 Idempotency-Key 请求头",
    issues: [{ path: "/headers/idempotency-key", message: "必填" }] });
  const replay = await idem.begin(key, body);
  if (replay) return replay.body as T;
  const out = await run();
  await idem.complete(key, 200, out);
  return out;
}

@Controller("/v1")
export class StaffingController {
  constructor(
    private readonly svc: StaffingService,
    private readonly idem: IdempotencyService
  ) {}

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

  @Post("/handovers") @Operation("createHandover") @HttpCode(201)
  createHandover(@Body(new ZodPipe(CreateHandover)) b: z.infer<typeof CreateHandover>) {
    return this.svc.createHandover(b);
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
