import { GetQueryStatsQuery, ListDataQueriesQuery, RaiseDataQueryBody, AnswerDataQueryBody } from "@sitedesk/contracts";
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
  stats(@Query(new ZodPipe(GetQueryStatsQuery)) q: z.infer<typeof GetQueryStatsQuery>) {
    return this.svc.stats(q);
  }

  @Get("/data-queries") @Operation("listDataQueries")
  list(@Query(new ZodPipe(ListDataQueriesQuery)) q: z.infer<typeof ListDataQueriesQuery>) {
    return this.svc.list(q);
  }

  @Post("/data-queries") @Operation("raiseDataQuery") @HttpCode(201)
  raise(
    @Body(new ZodPipe(RaiseDataQueryBody)) b: z.infer<typeof RaiseDataQueryBody>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.raise(b)); }

  @Post("/data-queries/:id\\:answer") @Operation("answerDataQuery")
  answer(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(AnswerDataQueryBody)) b: z.infer<typeof AnswerDataQueryBody>,
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
