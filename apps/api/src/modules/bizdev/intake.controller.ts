import {
  Body, Controller, Get, Headers,
  HttpCode, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import {
  Uuid, ListIntakeApplicationsQuery, SubmitIntakeApplicationBody, DecideIntakeApplicationBody
} from "@sitedesk/contracts";
import { IntakeService } from "./intake.service.js";
import { IdempotencyService } from "../../infra/idempotency.service.js";
import { command } from "../../infra/command.js";
import { ZodPipe } from "../../infra/zod.pipe.js";
import { Operation } from "../../auth/guards.js";

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
  list(@Query(new ZodPipe(ListIntakeApplicationsQuery)) q: z.infer<typeof ListIntakeApplicationsQuery>) {
    return this.svc.list(q);
  }

  @Post("/intake-applications") @Operation("submitIntakeApplication") @HttpCode(201)
  submit(
    @Body(new ZodPipe(SubmitIntakeApplicationBody)) b: z.infer<typeof SubmitIntakeApplicationBody>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.submit(b)); }

  @Post("/intake-applications/:id\\:decide") @Operation("decideIntakeApplication")
  decide(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(DecideIntakeApplicationBody)) b: z.infer<typeof DecideIntakeApplicationBody>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.decide(id, b)); }
}
