import {
  Body, Controller, Get, Headers,
  HttpCode, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import {
  Uuid, ListFeasibilityQuery, CreateFeasibilityBody, DecideFeasibilityBody,
  RecordFeasibilityActualBody, ListBidsQuery, CreateBidBody, DecideBidBody,
  ListContractChangesQuery, CreateContractChangeBody, SettleContractChangeBody
} from "@sitedesk/contracts";
import { FeasibilityService } from "./feasibility.service.js";
import { BidService } from "./bid.service.js";
import { IdempotencyService } from "../../infra/idempotency.service.js";
import { command, idempotent } from "../../infra/command.js";
import { ZodPipe } from "../../infra/zod.pipe.js";
import { Operation } from "../../auth/guards.js";

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
  list(@Query(new ZodPipe(ListFeasibilityQuery)) q: z.infer<typeof ListFeasibilityQuery>) {
    return this.feas.list(q);
  }

  /* 幂等键可选：带了就走幂等那条路，没带照旧。
     这几个创建端点断网时会进发件箱（见 apps/web/src/api/outbox.ts），
     而重放意味着同一个请求可能到两次 —— 在此之前它们不认这把键：
     `createBid` 实测重放出两条投标，`createFeasibility` 撞唯一约束回 500。
     两种都不是"返回首次的结果"。 */
  @Post("/feasibility") @Operation("createFeasibility") @HttpCode(201)
  create(
    @Body(new ZodPipe(CreateFeasibilityBody)) b: z.infer<typeof CreateFeasibilityBody>,
    @Headers("idempotency-key") key?: string
  ) {
    return idempotent(this.idem, key, b, () => this.feas.create(b));
  }

  @Post("/feasibility/:id\\:decide") @Operation("decideFeasibility")
  decide(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(DecideFeasibilityBody)) b: z.infer<typeof DecideFeasibilityBody>,
    @Headers("idempotency-key") key?: string
  ) {
    return command(this.idem, key, { id, ...b }, () => this.feas.decide(id, b));
  }

  @Post("/feasibility/:id\\:actual") @Operation("recordFeasibilityActual")
  actual(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(RecordFeasibilityActualBody)) b: z.infer<typeof RecordFeasibilityActualBody>,
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
  listBids(@Query(new ZodPipe(ListBidsQuery)) q: z.infer<typeof ListBidsQuery>) {
    return this.bids.listBids(q);
  }

  @Post("/bids") @Operation("createBid") @HttpCode(201)
  createBid(
    @Body(new ZodPipe(CreateBidBody)) b: z.infer<typeof CreateBidBody>,
    @Headers("idempotency-key") key?: string
  ) {
    return idempotent(this.idem, key, b, () => this.bids.createBid(b));
  }

  @Post("/bids/:id\\:decide") @Operation("decideBid")
  decideBid(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(DecideBidBody)) b: z.infer<typeof DecideBidBody>,
    @Headers("idempotency-key") key?: string
  ) {
    return command(this.idem, key, { id, ...b }, () => this.bids.decideBid(id, b));
  }

  /* ── 合同变更 ─────────────────────────────────────────────────── */
  @Get("/contract-changes/scope-creep") @Operation("getScopeCreep")
  scopeCreep() { return this.bids.scopeCreep(); }

  @Get("/contract-changes") @Operation("listContractChanges")
  listChanges(@Query(new ZodPipe(ListContractChangesQuery)) q: z.infer<typeof ListContractChangesQuery>) {
    return this.bids.listChanges(q);
  }

  @Post("/contract-changes") @Operation("createContractChange") @HttpCode(201)
  createChange(
    @Body(new ZodPipe(CreateContractChangeBody)) b: z.infer<typeof CreateContractChangeBody>,
    @Headers("idempotency-key") key?: string
  ) {
    return idempotent(this.idem, key, b, () => this.bids.createChange(b));
  }

  @Post("/contract-changes/:id\\:settle") @Operation("settleContractChange")
  settleChange(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(SettleContractChangeBody)) b: z.infer<typeof SettleContractChangeBody>,
    @Headers("idempotency-key") key?: string
  ) {
    return command(this.idem, key, { id, ...b }, () => this.bids.settleChange(id, b));
  }
}
