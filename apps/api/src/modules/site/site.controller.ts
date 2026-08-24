import { Body, Controller, Get, Param, Post, Query, Headers, HttpCode } from "@nestjs/common";
import { z } from "zod";
import { PageQuery, Uuid, CentsNonNeg, DateOnly, SiteState } from "@sitedesk/contracts";
import { SiteService } from "./site.service.js";
import { IdempotencyService } from "../../infra/idempotency.service.js";
import { ZodPipe } from "../../infra/zod.pipe.js";
import { Operation, RequireAction } from "../../auth/guards.js";
import { ProblemException } from "../../infra/problem.js";

const ListQ = PageQuery.extend({
  studyId: Uuid.optional(),
  state: z.union([SiteState, z.array(SiteState)]).optional()
    .transform(v => v === undefined ? undefined : Array.isArray(v) ? v : [v]),
  hospital: z.string().optional(),
  q: z.string().max(64).optional()
});
const CreateBody = z.object({
  studyId: Uuid, code: z.string().min(1).max(64),
  hospital: z.string().min(1).max(128), dept: z.string().min(1).max(64),
  city: z.string().min(1).max(32), piName: z.string().min(1).max(64),
  piAccountId: Uuid.nullable().optional(), contracted: z.int().positive(),
  unitPriceCents: CentsNonNeg, startupFeeCents: CentsNonNeg.default(0),
  sivPlannedOn: DateOnly.nullable().optional()
});
const AdvanceBody = z.object({
  to: SiteState, reason: z.string().trim().min(4).max(500).optional()
});

@Controller("/v1")
export class SiteController {
  constructor(
    private readonly svc: SiteService,
    private readonly idem: IdempotencyService
  ) {}

  @Get("/studies") @Operation("listStudies")
  studies(@Query(new ZodPipe(PageQuery)) q: z.infer<typeof PageQuery>) {
    return this.svc.listStudies(q.limit, q.cursor);
  }

  @Get("/study-sites") @Operation("listStudySites")
  list(@Query(new ZodPipe(ListQ)) q: z.infer<typeof ListQ>) { return this.svc.list(q); }

  @Get("/study-sites/:id") @Operation("getStudySite")
  get(@Param("id", new ZodPipe(Uuid)) id: string) { return this.svc.get(id); }

  @Post("/study-sites") @Operation("createStudySite") @HttpCode(201)
  create(@Body(new ZodPipe(CreateBody)) b: z.infer<typeof CreateBody>) {
    return this.svc.create(b);
  }

  @Get("/study-sites/:id/gate") @Operation("getSiteGate")
  gate(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Query("to") to?: string
  ) { return this.svc.gate(id, to); }

  @Post("/study-sites/:id\\:advance") @Operation("advanceStudySite") @RequireAction("advance")
  async advance(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(AdvanceBody)) b: z.infer<typeof AdvanceBody>,
    @Headers("idempotency-key") key?: string
  ) {
    if (!key) throw new ProblemException("validation-failed", {
      detail: "L2 命令必须携带 Idempotency-Key 请求头",
      issues: [{ path: "/headers/idempotency-key", message: "必填" }] });
    const replay = await this.idem.begin(key, { id, ...b });
    if (replay) return replay.body;
    const out = await this.svc.advance(id, b.to, b.reason);
    await this.idem.complete(key, 200, out);
    return out;
  }
}
