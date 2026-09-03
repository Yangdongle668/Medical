import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import {
  PageQuery, Uuid, DateOnly, QueryBool, CentsNonNeg,
  FeasibilityAnswers, FeasibilityStatus, BidStatus, ChangeKind, ChangeStatus
} from "@sitedesk/contracts";
import { FeasibilityService } from "./feasibility.service.js";
import { BidService } from "./bid.service.js";
import { IdempotencyService } from "../../infra/idempotency.service.js";
import { command } from "../../infra/command.js";
import { ZodPipe } from "../../infra/zod.pipe.js";
import { Operation } from "../../auth/guards.js";

const arr = <T extends z.ZodType>(t: T) =>
  z.union([t, z.array(t)]).transform(v => Array.isArray(v) ? v : [v]).optional();

const FeasQ = PageQuery.extend({
  studyId: Uuid.optional(),
  status: arr(FeasibilityStatus),
  overrideOnly: QueryBool.optional(),
  q: z.string().max(64).optional()
});
const CreateFeas = z.object({
  studyId: Uuid,
  hospital: z.string().trim().min(2).max(80),
  city: z.string().trim().min(2).max(40),
  dept: z.string().trim().min(2).max(40),
  piName: z.string().trim().min(2).max(40),
  surveyedOn: DateOnly,
  answers: FeasibilityAnswers
});
const Decide = z.object({
  decision: z.enum(["selected", "rejected"]),
  reason: z.string().trim().max(500).optional()
});
const Actual = z.object({ actualRate: z.number().min(0).max(1000) });

const BidQ = PageQuery.extend({
  status: arr(BidStatus),
  sponsor: z.string().max(64).optional()
});
const CreateBid = z.object({
  sponsor: z.string().trim().min(2).max(80),
  name: z.string().trim().min(2).max(120),
  submittedOn: DateOnly,
  sites: z.int().min(1).max(999),
  subjects: z.int().min(1).max(99999),
  ourQuoteCents: CentsNonNeg.min(1),
  ourPersonDays: z.number().min(0.1).max(999999),
  note: z.string().max(500).optional()
});
const DecideBid = z.object({
  result: z.enum(["won", "lost"]),
  winningPriceCents: CentsNonNeg.min(1).nullable().optional(),
  note: z.string().max(500).optional()
});

const ChangeQ = PageQuery.extend({
  studyId: Uuid.optional(),
  studySiteId: Uuid.optional(),
  status: arr(ChangeStatus),
  uncoveredOnly: QueryBool.optional()
});
const CreateChange = z.object({
  studyId: Uuid,
  studySiteId: Uuid.nullable().optional(),
  kind: ChangeKind,
  raisedOn: DateOnly,
  what: z.string().trim().min(4).max(500),
  personDaysImpact: z.number().min(-99999).max(99999),
  perSubject: z.boolean(),
  note: z.string().max(500).optional()
});
const Settle = z.object({
  status: z.enum(["submitted", "signed", "rejected"]),
  settledCents: z.number().int().min(-99999999999).max(99999999999)
    .nullable().optional(),
  note: z.string().max(500).optional()
});

@Controller("/v1")
export class BizdevController {
  constructor(
    private readonly feas: FeasibilityService,
    private readonly bids: BidService,
    private readonly idem: IdempotencyService
  ) {}

  /* **具体路径排在带参数的那条前面。**
     `/v1/feasibility/calibration` 与 `/v1/feasibility/:id` 长得一样，
     NestJS 按注册顺序匹配 —— 反过来的话，"calibration" 会被当成一个 id，
     然后在 uuid 校验那里报 422，而报的是"参数不符合契约"，
     看不出是路由撞了。 */
  @Get("/feasibility/calibration") @Operation("getFeasibilityCalibration")
  calibration() { return this.feas.calibration(); }

  @Get("/feasibility") @Operation("listFeasibility")
  list(@Query(new ZodPipe(FeasQ)) q: z.infer<typeof FeasQ>) {
    return this.feas.list(q);
  }

  @Post("/feasibility") @Operation("createFeasibility") @HttpCode(201)
  create(@Body(new ZodPipe(CreateFeas)) b: z.infer<typeof CreateFeas>) {
    return this.feas.create(b);
  }

  @Post("/feasibility/:id\\:decide") @Operation("decideFeasibility")
  decide(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(Decide)) b: z.infer<typeof Decide>,
    @Headers("idempotency-key") key?: string
  ) {
    return command(this.idem, key, { id, ...b }, () => this.feas.decide(id, b));
  }

  @Post("/feasibility/:id\\:actual") @Operation("recordFeasibilityActual")
  actual(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(Actual)) b: z.infer<typeof Actual>,
    @Headers("idempotency-key") key?: string
  ) {
    return command(this.idem, key, { id, ...b },
      () => this.feas.recordActual(id, b.actualRate));
  }

  /* ── 投标 ─────────────────────────────────────────────────────
     `/v1/bids/review` 同样排在带参数那条前面（这里没有 `/bids/:id`，
     但顺序是一眼能看出来的，那条"不会撞"的推理不是）。 */
  @Get("/bids/review") @Operation("getBidReview")
  bidReview() { return this.bids.bidReview(); }

  @Get("/bids") @Operation("listBids")
  listBids(@Query(new ZodPipe(BidQ)) q: z.infer<typeof BidQ>) {
    return this.bids.listBids(q);
  }

  @Post("/bids") @Operation("createBid") @HttpCode(201)
  createBid(@Body(new ZodPipe(CreateBid)) b: z.infer<typeof CreateBid>) {
    return this.bids.createBid(b);
  }

  @Post("/bids/:id\\:decide") @Operation("decideBid")
  decideBid(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(DecideBid)) b: z.infer<typeof DecideBid>,
    @Headers("idempotency-key") key?: string
  ) {
    return command(this.idem, key, { id, ...b }, () => this.bids.decideBid(id, b));
  }

  /* ── 合同变更 ─────────────────────────────────────────────────── */
  @Get("/contract-changes/scope-creep") @Operation("getScopeCreep")
  scopeCreep() { return this.bids.scopeCreep(); }

  @Get("/contract-changes") @Operation("listContractChanges")
  listChanges(@Query(new ZodPipe(ChangeQ)) q: z.infer<typeof ChangeQ>) {
    return this.bids.listChanges(q);
  }

  @Post("/contract-changes") @Operation("createContractChange") @HttpCode(201)
  createChange(@Body(new ZodPipe(CreateChange)) b: z.infer<typeof CreateChange>) {
    return this.bids.createChange(b);
  }

  @Post("/contract-changes/:id\\:settle") @Operation("settleContractChange")
  settleChange(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(Settle)) b: z.infer<typeof Settle>,
    @Headers("idempotency-key") key?: string
  ) {
    return command(this.idem, key, { id, ...b }, () => this.bids.settleChange(id, b));
  }
}
