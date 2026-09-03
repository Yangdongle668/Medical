import { Body, Controller, Get, Headers, Param, Patch, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { PageQuery, Uuid, DateOnly, QueryBool, MilestoneState } from "@sitedesk/contracts";
import { FinanceService } from "./finance.service.js";
import { IdempotencyService } from "../../infra/idempotency.service.js";
import { command } from "../../infra/command.js";
import { ZodPipe } from "../../infra/zod.pipe.js";
import { Operation } from "../../auth/guards.js";

const arr = <T extends z.ZodType>(t: T) =>
  z.union([t, z.array(t)]).transform(v => Array.isArray(v) ? v : [v]).optional();

const MsQ = PageQuery.extend({
  studySiteId: Uuid.optional(),
  studyId: Uuid.optional(),
  clientId: Uuid.optional(),
  state: arr(MilestoneState),
  receivableOnly: QueryBool.optional(),
  overdueOnly: QueryBool.optional()
});
const Dated = z.object({
  invoicedOn: DateOnly.optional(),
  note: z.string().max(500).optional()
});
const Paid = z.object({
  paidOn: DateOnly.optional(),
  note: z.string().max(500).optional()
});
const ClientQ = PageQuery.extend({ q: z.string().max(64).optional() });
const UpdateClient = z.object({
  sinceYear: z.int().min(1980).max(2200).nullable().optional(),
  contact: z.string().max(120).nullable().optional(),
  paymentTermsDays: z.int().min(0).max(365).optional(),
  nps: z.int().min(0).max(10).nullable().optional(),
  note: z.string().max(1000).nullable().optional()
});
const CashQ = z.object({
  months: z.coerce.number().int().min(1).max(12).optional()
});

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
  list(@Query(new ZodPipe(MsQ)) q: z.infer<typeof MsQ>) {
    return this.svc.listMilestones(q);
  }

  @Post("/milestones/:id\\:invoice") @Operation("invoiceMilestone")
  invoice(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(Dated)) b: z.infer<typeof Dated>,
    @Headers("idempotency-key") key?: string
  ) {
    return command(this.idem, key, { id, ...b }, () => this.svc.invoice(id, b));
  }

  @Post("/milestones/:id\\:pay") @Operation("payMilestone")
  pay(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(Paid)) b: z.infer<typeof Paid>,
    @Headers("idempotency-key") key?: string
  ) {
    return command(this.idem, key, { id, ...b }, () => this.svc.pay(id, b));
  }

  @Get("/clients") @Operation("listClients")
  clients(@Query(new ZodPipe(ClientQ)) q: z.infer<typeof ClientQ>) {
    return this.svc.listClients(q);
  }

  @Patch("/clients/:id") @Operation("updateClient")
  updateClient(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(UpdateClient)) b: z.infer<typeof UpdateClient>
  ) {
    return this.svc.updateClient(id, b);
  }

  @Get("/cash-forecast") @Operation("getCashForecast")
  cash(@Query(new ZodPipe(CashQ)) q: z.infer<typeof CashQ>) {
    return this.svc.cashForecast(q.months ?? 6);
  }
}
