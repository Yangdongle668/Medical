import {
  Body, Controller, Get, Param,
  Post, Query, Headers, HttpCode } from "@nestjs/common";
import { z } from "zod";
import {
  PageQuery, Uuid, CreateStudySiteBody, SetStudyTeamBody,
  ListStudySitesQuery, ReplaceStartupTemplateBody, AdvanceStudySiteBody
} from "@sitedesk/contracts";
import { SiteService } from "./site.service.js";
import { IdempotencyService } from "../../infra/idempotency.service.js";
import { ZodPipe } from "../../infra/zod.pipe.js";
import { Operation } from "../../auth/guards.js";
import { command, idempotent } from "../../infra/command.js";

/* 建档请求体**直接用契约那一个**（CreateStudySiteBody）。
   这里原来是一份手抄的副本，而副本会分叉：契约把 `code` 改成可选
   之后，副本仍然要求必填 —— 接口于是回一句「请求参数不符合契约」，
   而它自己就是那份契约的实现。这种错两边各自都自洽，没有测试拦得住。 */

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

  /* 把项目划给另一个组。**L2** —— 它改的是行范围本身：
     划走那一刻，原来那个组的 PM 看不见这个项目和它下面的一切。
     所以幂等键是必需的（command 而不是 idempotent）：
     重放一次"划走"和真的划两次，在审计上是两件不同的事。 */
  @Post("/studies/:id\\:set-team") @Operation("setStudyTeam")
  setStudyTeam(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(SetStudyTeamBody)) b: z.infer<typeof SetStudyTeamBody>,
    @Headers("idempotency-key") key: string
  ) {
    return command(this.idem, key, { id, ...b }, () => this.svc.setStudyTeam(id, b));
  }

  @Get("/study-sites") @Operation("listStudySites")
  list(@Query(new ZodPipe(ListStudySitesQuery)) q: z.infer<typeof ListStudySitesQuery>) { return this.svc.list(q); }

  /* 模板路由排在 `/study-sites/:id` 之前不是必需的（路径不冲突），
     但它和下面那条命令要挨着 —— 读和写分开两处，改的时候容易只改一处。 */
  @Get("/startup-template") @Operation("getStartupTemplate")
  startupTemplate() { return this.svc.startupTemplate(); }

  @Post("/startup-template\\:replace") @Operation("replaceStartupTemplate")
  replaceTemplate(
    @Body(new ZodPipe(ReplaceStartupTemplateBody)) b: z.infer<typeof ReplaceStartupTemplateBody>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.replaceStartupTemplate(b)); }

  @Get("/study-sites/:id") @Operation("getStudySite")
  get(@Param("id", new ZodPipe(Uuid)) id: string) { return this.svc.get(id); }

  /* 幂等键在这里是**可选**的：带了就走幂等那条路（重放返回首次结果），
     没带就照旧。断网时这些创建请求要能排进发件箱，而重放意味着同一个
     请求可能发两次 —— 没有键的话，那就是实实在在的两笔。 */
  @Post("/study-sites") @Operation("createStudySite") @HttpCode(201)
  create(
    @Body(new ZodPipe(CreateStudySiteBody)) b: z.infer<typeof CreateStudySiteBody>,
    @Headers("idempotency-key") key?: string
  ) {
    return idempotent(this.idem, key, b, () => this.svc.create(b));
  }

  @Get("/study-sites/:id/gate") @Operation("getSiteGate")
  gate(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Query("to") to?: string
  ) { return this.svc.gate(id, to); }

  @Post("/study-sites/:id\\:advance") @Operation("advanceStudySite")
  advance(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(AdvanceStudySiteBody)) b: z.infer<typeof AdvanceStudySiteBody>,
    @Headers("idempotency-key") key?: string
  ) {
    return command(this.idem, key, { id, ...b }, () => this.svc.advance(id, b.to, b.reason));
  }
}
