import { Body, Controller, Get, Headers, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { PageQuery, Uuid, DateOnly, WithReason, AcceptanceState, SubmitAcceptance,
  IsfCategory, QueryBool } from "@sitedesk/contracts";
import { AcceptanceService } from "./acceptance.service.js";
import { IdempotencyService } from "../../infra/idempotency.service.js";
import { command } from "../../infra/command.js";
import { ZodPipe } from "../../infra/zod.pipe.js";
import { Operation } from "../../auth/guards.js";

const arr = <T extends z.ZodType>(t: T) =>
  z.union([t, z.array(t)]).transform(v => Array.isArray(v) ? v : [v]).optional();

const AcQ = PageQuery.extend({
  studyId: Uuid.optional(),
  state: arr(AcceptanceState),
  openOnly: QueryBool.optional()
});
const IsfQ = z.object({
  studySiteId: Uuid.optional(),
  category: arr(IsfCategory),
  openOnly: QueryBool.optional()
});
const SetDoc = z.object({ present: z.boolean() });
const UpdateIsf = z.object({
  present: z.boolean().optional(),
  expiresOn: DateOnly.nullable().optional(),
  quantity: z.int().min(0).nullable().optional(),
  note: z.string().trim().max(500).optional()
});

@Controller("/v1")
export class AcceptanceController {
  constructor(
    private readonly svc: AcceptanceService,
    private readonly idem: IdempotencyService
  ) {}

  @Get("/site-acceptances") @Operation("listSiteAcceptances")
  list(@Query(new ZodPipe(AcQ)) q: z.infer<typeof AcQ>) {
    return this.svc.listAcceptances(q);
  }

  @Post("/site-acceptances") @Operation("submitSiteAcceptance")
  submit(@Body(new ZodPipe(SubmitAcceptance)) b: z.infer<typeof SubmitAcceptance>) {
    return this.svc.submit(b);
  }

  @Post("/site-acceptances/:id/docs/:seq\\:set") @Operation("setAcceptanceDoc")
  setDoc(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Param("seq", new ZodPipe(z.coerce.number().int().min(0))) seq: number,
    @Body(new ZodPipe(SetDoc)) b: z.infer<typeof SetDoc>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.setDoc(id, seq, b)); }

  @Post("/site-acceptances/:id\\:accept") @Operation("acceptSite")
  accept(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(z.object({}))) b: unknown,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.accept(id)); }

  @Post("/site-acceptances/:id\\:amend") @Operation("requestAcceptanceAmend")
  amend(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(WithReason)) b: z.infer<typeof WithReason>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.requestAmend(id, b)); }

  @Get("/isf-items") @Operation("getIsfBoard")
  isf(@Query(new ZodPipe(IsfQ)) q: z.infer<typeof IsfQ>) {
    return this.svc.isfBoard(q);
  }

  @Post("/isf-items/:id\\:update") @Operation("updateIsfItem")
  updateIsf(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(UpdateIsf)) b: z.infer<typeof UpdateIsf>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.updateIsf(id, b)); }
}
