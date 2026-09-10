import {
  Body, Controller, Get, Headers,
  Param, Patch, Post, Query } from "@nestjs/common";
import { z } from "zod";
import {
  Uuid, ListMilestonesQuery, InvoiceMilestoneBody, PayMilestoneBody,
  ListClientsQuery, UpdateClientBody, GetCashForecastQuery
} from "@sitedesk/contracts";
import { FinanceService } from "./finance.service.js";
import { IdempotencyService } from "../../infra/idempotency.service.js";
import { command, idempotent } from "../../infra/command.js";
import { ZodPipe } from "../../infra/zod.pipe.js";
import { Operation } from "../../auth/guards.js";

@Controller("/v1")
export class FinanceController {
  constructor(
    private readonly svc: FinanceService,
    private readonly idem: IdempotencyService
  ) {}

  /* 具体路径排在带参数的那条前面 —— `/v1/milestones/plan` 与
     `/v1/milestones/:id` 长得一样，NestJS 按注册顺序匹配。 */
  @Get("/milestones/plan") @Operation("getMilestonePlan")
  plan() { return this.svc.plan(); }

  @Get("/milestones/ar-aging") @Operation("getArAging")
  aging(@Query(new ZodPipe(z.object({ clientId: Uuid.optional() })))
        q: { clientId?: string }) {
    return this.svc.arAging(q);
  }

  @Get("/milestones") @Operation("listMilestones")
  list(@Query(new ZodPipe(ListMilestonesQuery)) q: z.infer<typeof ListMilestonesQuery>) {
    return this.svc.listMilestones(q);
  }

  @Post("/milestones/:id\\:invoice") @Operation("invoiceMilestone")
  invoice(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(InvoiceMilestoneBody)) b: z.infer<typeof InvoiceMilestoneBody>,
    @Headers("idempotency-key") key?: string
  ) {
    return command(this.idem, key, { id, ...b }, () => this.svc.invoice(id, b));
  }

  @Post("/milestones/:id\\:pay") @Operation("payMilestone")
  pay(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(PayMilestoneBody)) b: z.infer<typeof PayMilestoneBody>,
    @Headers("idempotency-key") key?: string
  ) {
    return command(this.idem, key, { id, ...b }, () => this.svc.pay(id, b));
  }

  @Get("/clients") @Operation("listClients")
  clients(@Query(new ZodPipe(ListClientsQuery)) q: z.infer<typeof ListClientsQuery>) {
    return this.svc.listClients(q);
  }

  @Patch("/clients/:id") @Operation("updateClient")
  updateClient(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(UpdateClientBody)) b: z.infer<typeof UpdateClientBody>,
    @Headers("idempotency-key") key?: string
  ) {
    return idempotent(this.idem, key, { id, ...b }, () => this.svc.updateClient(id, b));
  }

  @Get("/cash-forecast") @Operation("getCashForecast")
  cash(@Query(new ZodPipe(GetCashForecastQuery)) q: z.infer<typeof GetCashForecastQuery>) {
    return this.svc.cashForecast(q.months ?? 6);
  }
}
