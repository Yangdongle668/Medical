import {
  Body, Controller, Get, Headers,
  Param, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import {
  Uuid, WithReason, SubmitAcceptance, ListSiteAcceptancesQuery,
  SetAcceptanceDocBody, RecordAcceptanceLetterBody,
  GetIsfBoardQuery, UpdateIsfItemBody
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

  /* 一线的第二个日期 + 那张纸。**L2** —— 它把这条受理翻成「已受理」，
     而那一步会放行中心状态机的「伦理递交」。 */
  @Post("/site-acceptances/:id\\:record-letter") @Operation("recordAcceptanceLetter")
  recordLetter(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(RecordAcceptanceLetterBody)) b: z.infer<typeof RecordAcceptanceLetterBody>,
    @Headers("idempotency-key") key: string
  ) { return command(this.idem, key, { id, ...b }, () => this.svc.recordLetter(id, b)); }

  /* 取原件。**这一条不返回 JSON** —— 所以要 @Res，而拿了 @Res 就得
     自己把响应写完（Nest 不再接管返回值）。全仓库只有这一条是这样，
     因为全仓库只有这一条返回的是文件。 */
  @Get("/site-acceptances/:id/letter") @Operation("getAcceptanceLetter")
  async getLetter(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Res() res: Response
  ) {
    const f = await this.svc.letter(id);
    /* `inline` 而不是 `attachment`：这是一张要被看一眼的纸，
       不是一份要存到本地的文件。文件名用 RFC 5987 编码 ——
       受理意向函的名字里通常带中文，直接塞进 header 会被截断成乱码。 */
    res.setHeader("Content-Type", f.content_type);
    res.setHeader("Content-Disposition",
      `inline; filename*=UTF-8''${encodeURIComponent(f.filename)}`);
    /* 这份文件的可见性跟着受理那一行走（RLS），**不许被缓存到共享层**：
       同一个 URL 对不同的人答案不同。 */
    res.setHeader("Cache-Control", "private, no-store");
    res.end(f.bytes);
  }

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
