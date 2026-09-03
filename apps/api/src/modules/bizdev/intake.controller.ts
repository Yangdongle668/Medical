import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { PageQuery, Uuid, IntakeState, QueryBool } from "@sitedesk/contracts";
import { IntakeService } from "./intake.service.js";
import { IdempotencyService } from "../../infra/idempotency.service.js";
import { command } from "../../infra/command.js";
import { ZodPipe } from "../../infra/zod.pipe.js";
import { Operation } from "../../auth/guards.js";

const arr = <T extends z.ZodType>(t: T) =>
  z.union([t, z.array(t)]).transform(v => Array.isArray(v) ? v : [v]).optional();

const ListQ = PageQuery.extend({
  state: arr(IntakeState),
  mine: QueryBool.optional(),
  belowGateOnly: QueryBool.optional()
});
const Submit = z.object({
  drug: z.string().trim().min(2).max(200),
  sponsorName: z.string().trim().min(2).max(120),
  phase: z.string().trim().min(1).max(20),
  indication: z.string().trim().min(2).max(120),
  plannedSites: z.int().min(1).max(200),
  plannedSubjects: z.int().min(1).max(20000),
  enrollMonths: z.int().min(1).max(120),
  contractCents: z.int().min(0),
  estimatedCostCents: z.int().min(0),
  note: z.string().trim().max(1000).optional()
});
const Decide = z.object({
  result: z.enum(["approved", "returned"]),
  reason: z.string().trim().max(1000).optional()
});

/* `/intake-applications/board` 排在任何 `/intake-applications/:x` 之前。 */
@Controller("/v1")
export class IntakeController {
  constructor(
    private readonly svc: IntakeService,
    private readonly idem: IdempotencyService
  ) {}

  @Get("/intake-applications/board") @Operation("getIntakeBoard")
  board() { return this.svc.board(); }

  @Get("/intake-applications") @Operation("listIntakeApplications")
  list(@Query(new ZodPipe(ListQ)) q: z.infer<typeof ListQ>) {
    return this.svc.list(q);
  }

  @Post("/intake-applications") @Operation("submitIntakeApplication") @HttpCode(201)
  submit(
    @Body(new ZodPipe(Submit)) b: z.infer<typeof Submit>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.submit(b)); }

  @Post("/intake-applications/:id\\:decide") @Operation("decideIntakeApplication")
  decide(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(Decide)) b: z.infer<typeof Decide>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.decide(id, b)); }
}
