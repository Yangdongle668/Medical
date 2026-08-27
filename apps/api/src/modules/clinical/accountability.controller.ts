import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { PageQuery, Uuid, DateOnly, QueryBool } from "@sitedesk/contracts";
import { AccountabilityService } from "./accountability.service.js";
import { IdempotencyService } from "../../infra/idempotency.service.js";
import { command, idempotent } from "../../infra/command.js";
import { ZodPipe } from "../../infra/zod.pipe.js";
import { Operation } from "../../auth/guards.js";

/* 药品台账 / 生物样本 / 伦理递交 —— 关闭闸门那四项检查的数据来源。
   为什么是三张表而不是一个"关闭前检查表"：闸门问的是**事实**
   （药还剩几盒、样本闭没闭环、批复下来没有），而事实要有出处。
   让人在关闭时勾四个框，等于把闸门变成一句口头承诺。 */

const IpQ = PageQuery;
const SpecimenQ = PageQuery.extend({ openOnly: QueryBool.optional() });

const IpKind = z.enum(["receipt", "dispense", "return", "ship_back", "destroy"]);
const RecordIp = z.object({
  movedOn: DateOnly.optional(),
  kind: IpKind,
  quantity: z.coerce.number().int().positive().max(100_000),
  subjectRef: z.string().max(32).optional(),
  refNo: z.string().max(64).optional(),
  note: z.string().max(500).optional()
});
const RecordSpecimen = z.object({
  subjectRef: z.string().min(1).max(32),
  kind: z.string().min(1).max(32),
  collectedOn: DateOnly,
  trackingNo: z.string().max(64).optional()
});
const Advance = z.object({
  stage: z.enum(["shipped", "received", "discarded"]),
  on: DateOnly
});
const RecordSubmission = z.object({
  kind: z.enum(["initial", "amendment", "annual", "closeout"]),
  submittedOn: DateOnly,
  refNo: z.string().max(64).optional(),
  note: z.string().max(500).optional()
});
const Decide = z.object({
  decision: z.enum(["approved", "rejected"]),
  decidedOn: DateOnly,
  note: z.string().max(500).optional()
});

@Controller("/v1")
export class AccountabilityController {
  constructor(
    private readonly svc: AccountabilityService,
    private readonly idem: IdempotencyService
  ) {}

  /* ── 药品 ───────────────────────────────────────────────────────── */

  @Get("/study-sites/:id/ip-movements") @Operation("listIpMovements")
  listIp(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Query(new ZodPipe(IpQ)) q: z.infer<typeof IpQ>
  ) { return this.svc.listIp(id, q); }

  @Post("/study-sites/:id/ip-movements") @Operation("recordIpMovement") @HttpCode(201)
  recordIp(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(RecordIp)) b: z.infer<typeof RecordIp>,
    @Headers("idempotency-key") key?: string
  ) { return idempotent(this.idem, key, b, () => this.svc.recordIp(id, b)); }

  /* ── 样本 ───────────────────────────────────────────────────────── */

  @Get("/study-sites/:id/specimens") @Operation("listSpecimens")
  listSpecimens(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Query(new ZodPipe(SpecimenQ)) q: z.infer<typeof SpecimenQ>
  ) { return this.svc.listSpecimens(id, q); }

  @Post("/study-sites/:id/specimens") @Operation("recordSpecimen") @HttpCode(201)
  recordSpecimen(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(RecordSpecimen)) b: z.infer<typeof RecordSpecimen>,
    @Headers("idempotency-key") key?: string
  ) { return idempotent(this.idem, key, b, () => this.svc.recordSpecimen(id, b)); }

  @Post("/specimens/:id\\:advance") @Operation("advanceSpecimen")
  advance(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(Advance)) b: z.infer<typeof Advance>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.advanceSpecimen(id, b)); }

  /* ── 伦理递交 ───────────────────────────────────────────────────── */

  @Get("/study-sites/:id/regulatory-submissions") @Operation("listRegulatorySubmissions")
  listSubmissions(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Query(new ZodPipe(IpQ)) q: z.infer<typeof IpQ>
  ) { return this.svc.listSubmissions(id, q); }

  @Post("/study-sites/:id/regulatory-submissions")
  @Operation("recordRegulatorySubmission") @HttpCode(201)
  recordSubmission(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(RecordSubmission)) b: z.infer<typeof RecordSubmission>,
    @Headers("idempotency-key") key?: string
  ) { return idempotent(this.idem, key, b, () => this.svc.recordSubmission(id, b)); }

  @Post("/regulatory-submissions/:id\\:decide") @Operation("decideRegulatorySubmission")
  decide(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(Decide)) b: z.infer<typeof Decide>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.decide(id, b)); }
}
