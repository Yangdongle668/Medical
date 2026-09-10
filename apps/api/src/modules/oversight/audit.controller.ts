import {
  Body, Controller, Get, Headers,
  HttpCode, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import {
  Uuid, GetAuditBoardQuery, ListInternalAuditsQuery, OpenInternalAuditBody,
  AddAuditFindingBody, CloseAuditFindingBody
} from "@sitedesk/contracts";
import { InternalAuditService } from "./audit.service.js";
import { IdempotencyService } from "../../infra/idempotency.service.js";
import { command } from "../../infra/command.js";
import { ZodPipe } from "../../infra/zod.pipe.js";
import { Operation } from "../../auth/guards.js";

/* `/internal-audits/board` 排在任何 `/internal-audits/:x` 之前 —— 同 monitor。 */
@Controller("/v1")
export class InternalAuditController {
  constructor(
    private readonly svc: InternalAuditService,
    private readonly idem: IdempotencyService
  ) {}

  @Get("/internal-audits/board") @Operation("getAuditBoard")
  board(@Query(new ZodPipe(GetAuditBoardQuery)) q: z.infer<typeof GetAuditBoardQuery>) {
    return this.svc.board(q);
  }

  @Get("/internal-audits") @Operation("listInternalAudits")
  list(@Query(new ZodPipe(ListInternalAuditsQuery)) q: z.infer<typeof ListInternalAuditsQuery>) {
    return this.svc.list(q);
  }

  @Post("/internal-audits") @Operation("openInternalAudit") @HttpCode(201)
  open(
    @Body(new ZodPipe(OpenInternalAuditBody)) b: z.infer<typeof OpenInternalAuditBody>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.open(b)); }

  @Post("/internal-audits/:id\\:finding") @Operation("addAuditFinding")
  finding(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(AddAuditFindingBody)) b: z.infer<typeof AddAuditFindingBody>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.addFinding(id, b)); }

  @Post("/internal-audits/:id/findings/:seq\\:close") @Operation("closeAuditFinding")
  closeFinding(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Param("seq", new ZodPipe(z.coerce.number().int().min(0))) seq: number,
    @Body(new ZodPipe(CloseAuditFindingBody)) b: z.infer<typeof CloseAuditFindingBody>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.closeFinding(id, seq, b)); }
}
