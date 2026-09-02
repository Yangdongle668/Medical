import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { PageQuery, Uuid, DateOnly, AuditKind, QueryBool } from "@sitedesk/contracts";
import { InternalAuditService } from "./audit.service.js";
import { IdempotencyService } from "../../infra/idempotency.service.js";
import { command } from "../../infra/command.js";
import { ZodPipe } from "../../infra/zod.pipe.js";
import { Operation } from "../../auth/guards.js";

const arr = <T extends z.ZodType>(t: T) =>
  z.union([t, z.array(t)]).transform(v => Array.isArray(v) ? v : [v]).optional();

const ListQ = PageQuery.extend({
  studySiteId: Uuid.optional(),
  kind: arr(AuditKind),
  openOnly: QueryBool.optional()
});
const BoardQ = z.object({ studySiteId: Uuid.optional() });
const Open = z.object({
  studySiteId: Uuid,
  kind: AuditKind,
  auditedOn: DateOnly.optional(),
  scope: z.string().trim().min(4).max(1000)
});
const Finding = z.object({
  severity: z.enum(["minor", "major", "critical"]),
  finding: z.string().trim().min(10).max(1000),
  repeatOf: Uuid.optional()
});
const CloseFinding = z.object({ verification: z.string().trim().min(10).max(1000) });

/* `/internal-audits/board` 排在任何 `/internal-audits/:x` 之前 —— 同 monitor。 */
@Controller("/v1")
export class InternalAuditController {
  constructor(
    private readonly svc: InternalAuditService,
    private readonly idem: IdempotencyService
  ) {}

  @Get("/internal-audits/board") @Operation("getAuditBoard")
  board(@Query(new ZodPipe(BoardQ)) q: z.infer<typeof BoardQ>) {
    return this.svc.board(q);
  }

  @Get("/internal-audits") @Operation("listInternalAudits")
  list(@Query(new ZodPipe(ListQ)) q: z.infer<typeof ListQ>) {
    return this.svc.list(q);
  }

  @Post("/internal-audits") @Operation("openInternalAudit") @HttpCode(201)
  open(
    @Body(new ZodPipe(Open)) b: z.infer<typeof Open>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.open(b)); }

  @Post("/internal-audits/:id\\:finding") @Operation("addAuditFinding")
  finding(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(Finding)) b: z.infer<typeof Finding>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.addFinding(id, b)); }

  @Post("/internal-audits/:id/findings/:seq\\:close") @Operation("closeAuditFinding")
  closeFinding(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Param("seq", new ZodPipe(z.coerce.number().int().min(0))) seq: number,
    @Body(new ZodPipe(CloseFinding)) b: z.infer<typeof CloseFinding>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.closeFinding(id, seq, b)); }
}
