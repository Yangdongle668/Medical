import {
  Body, Controller, Get, Headers,
  Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import {
  Uuid, WithReason, SubmitAcceptance, ListSiteAcceptancesQuery,
  SetAcceptanceDocBody, GetIsfBoardQuery, UpdateIsfItemBody
} from "@sitedesk/contracts";
import { AcceptanceService } from "./acceptance.service.js";
import { IdempotencyService } from "../../infra/idempotency.service.js";
import { command, idempotent } from "../../infra/command.js";
import { ZodPipe } from "../../infra/zod.pipe.js";
import { Operation } from "../../auth/guards.js";

@Controller("/v1")
export class AcceptanceController {
  constructor(
    private readonly svc: AcceptanceService,
    private readonly idem: IdempotencyService
  ) {}

  @Get("/site-acceptances") @Operation("listSiteAcceptances")
  list(@Query(new ZodPipe(ListSiteAcceptancesQuery)) q: z.infer<typeof ListSiteAcceptancesQuery>) {
    return this.svc.listAcceptances(q);
  }

  /* 幂等键可选。递材料这件事**最容易在医院的网里断掉**，
     而断掉就会进发件箱重放 —— 没有这一层的话，重放出来的是
     第二份受理单，机构办那边看到同一家医院递了两次。 */
  @Post("/site-acceptances") @Operation("submitSiteAcceptance")
  submit(
    @Body(new ZodPipe(SubmitAcceptance)) b: z.infer<typeof SubmitAcceptance>,
    @Headers("idempotency-key") key?: string
  ) {
    return idempotent(this.idem, key, b, () => this.svc.submit(b));
  }

  @Post("/site-acceptances/:id/docs/:seq\\:set") @Operation("setAcceptanceDoc")
  setDoc(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Param("seq", new ZodPipe(z.coerce.number().int().min(0))) seq: number,
    @Body(new ZodPipe(SetAcceptanceDocBody)) b: z.infer<typeof SetAcceptanceDocBody>,
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
  isf(@Query(new ZodPipe(GetIsfBoardQuery)) q: z.infer<typeof GetIsfBoardQuery>) {
    return this.svc.isfBoard(q);
  }

  @Post("/isf-items/:id\\:update") @Operation("updateIsfItem")
  updateIsf(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(UpdateIsfItemBody)) b: z.infer<typeof UpdateIsfItemBody>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.updateIsf(id, b)); }
}
