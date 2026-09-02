import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { PageQuery, Uuid, WithReason, QualityState, QualitySeverity, QueryBool }
  from "@sitedesk/contracts";
import { DataQueryService } from "./query.service.js";
import { IdempotencyService } from "../../infra/idempotency.service.js";
import { command } from "../../infra/command.js";
import { ZodPipe } from "../../infra/zod.pipe.js";
import { Operation } from "../../auth/guards.js";

/* 查询参数的形状与契约同源：契约改了这里必然编译不过。 */
const arr = <T extends z.ZodType>(t: T) =>
  z.union([t, z.array(t)]).transform(v => Array.isArray(v) ? v : [v]).optional();

const ListQ = PageQuery.extend({
  studySiteId: Uuid.optional(),
  subjectId: Uuid.optional(),
  state: arr(QualityState),
  mine: QueryBool.optional(),
  raisedByMe: QueryBool.optional(),
  staleOnly: QueryBool.optional()
});
const StatsQ = z.object({
  studySiteId: Uuid.optional(),
  mine: QueryBool.optional()
});
const Raise = z.object({
  subjectId: Uuid,
  form: z.string().trim().min(1).max(80),
  fieldName: z.string().trim().min(2).max(80),
  detail: z.string().trim().min(10).max(2000),
  ownerAccountId: Uuid.optional(),
  severity: QualitySeverity.optional()
});
const Answer = z.object({ answer: z.string().trim().min(10).max(2000) });

/* 路由顺序：`/data-queries/stats` 必须排在任何 `/data-queries/:x` 之前。
   这里没有 `:id` 的 GET，所以暂时不会撞上 —— 但顺序仍按安全的那一种写，
   将来加一个「质疑详情」端点时不必先想起这件事。 */
@Controller("/v1")
export class DataQueryController {
  constructor(
    private readonly svc: DataQueryService,
    private readonly idem: IdempotencyService
  ) {}

  @Get("/data-queries/stats") @Operation("getQueryStats")
  stats(@Query(new ZodPipe(StatsQ)) q: z.infer<typeof StatsQ>) {
    return this.svc.stats(q);
  }

  @Get("/data-queries") @Operation("listDataQueries")
  list(@Query(new ZodPipe(ListQ)) q: z.infer<typeof ListQ>) {
    return this.svc.list(q);
  }

  @Post("/data-queries") @Operation("raiseDataQuery") @HttpCode(201)
  raise(
    @Body(new ZodPipe(Raise)) b: z.infer<typeof Raise>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.raise(b)); }

  @Post("/data-queries/:id\\:answer") @Operation("answerDataQuery")
  answer(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(Answer)) b: z.infer<typeof Answer>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.answer(id, b)); }

  @Post("/data-queries/:id\\:close") @Operation("closeDataQuery")
  close(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(WithReason)) b: z.infer<typeof WithReason>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.close(id, b)); }

  @Post("/data-queries/:id\\:return") @Operation("returnDataQuery")
  back(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(WithReason)) b: z.infer<typeof WithReason>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.returnToSite(id, b)); }

  @Post("/data-queries/:id\\:chase") @Operation("chaseDataQuery")
  chase(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(WithReason)) b: z.infer<typeof WithReason>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.chase(id, b)); }
}
