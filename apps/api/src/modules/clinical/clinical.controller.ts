import {
  Body, Controller, Get, Headers,
  HttpCode, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import {
  PageQuery, Uuid, WithReason, CreateSubjectBody,
  ListSubjectsQuery, ListEnrollmentQuery, ListSubjectVisitsQuery, ListQualityEventsQuery,
  ListSubjectPaymentsQuery, SignIcfBody, EnrollSubjectBody, ScreenFailSubjectBody,
  WithdrawSubjectBody, CompleteSubjectVisitBody, ReportSaeBody, ReplaceSoaBody,
  ReportSaeSubmittedBody, SetCapaPlanBody, PaySubjectPaymentBody, CompleteVisitTaskBody,
  ConfirmSubjectVisitBody, EnterVisitToEdcBody
} from "@sitedesk/contracts";
import { ClinicalService } from "./clinical.service.js";
import { IdempotencyService } from "../../infra/idempotency.service.js";
import { command, idempotent } from "../../infra/command.js";
import { ZodPipe } from "../../infra/zod.pipe.js";
import { Operation } from "../../auth/guards.js";

/* 查询参数的形状与契约同源：契约改了这里必然编译不过 */

/* 预筛登记请求体**直接用契约那一个**（CreateSubjectBody）——
   这里原来是一份手抄的副本，而副本会和契约分叉，且两边各自自洽。 */

@Controller("/v1")
export class ClinicalController {
  constructor(
    private readonly svc: ClinicalService,
    private readonly idem: IdempotencyService
  ) {}

  /* ── 读 ─────────────────────────────────────────────────────────── */

  @Get("/subjects") @Operation("listSubjects")
  listSubjects(@Query(new ZodPipe(ListSubjectsQuery)) q: z.infer<typeof ListSubjectsQuery>) {
    return this.svc.listSubjects(q);
  }

  @Get("/subjects/:id") @Operation("getSubject")
  getSubject(@Param("id", new ZodPipe(Uuid)) id: string) { return this.svc.getSubject(id); }

  @Get("/study-sites/:id/funnel") @Operation("getSiteFunnel")
  funnel(@Param("id", new ZodPipe(Uuid)) id: string) { return this.svc.funnel(id); }

  @Get("/enrollment") @Operation("listEnrollment")
  listEnrollment(@Query(new ZodPipe(ListEnrollmentQuery)) q: z.infer<typeof ListEnrollmentQuery>) {
    return this.svc.listEnrollment(q);
  }

  @Get("/subject-visits") @Operation("listSubjectVisits")
  listVisits(@Query(new ZodPipe(ListSubjectVisitsQuery)) q: z.infer<typeof ListSubjectVisitsQuery>) {
    return this.svc.listVisits(q);
  }

  @Get("/subject-visits/:id") @Operation("getSubjectVisit")
  getVisit(@Param("id", new ZodPipe(Uuid)) id: string) { return this.svc.visit(id); }

  @Get("/quality-events") @Operation("listQualityEvents")
  listQuality(@Query(new ZodPipe(ListQualityEventsQuery)) q: z.infer<typeof ListQualityEventsQuery>) {
    return this.svc.listQualityEvents(q);
  }

  @Get("/study-sites/:id/sae") @Operation("listSaeEvents")
  listSae(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Query(new ZodPipe(PageQuery)) q: z.infer<typeof PageQuery>
  ) { return this.svc.listSae(id, q); }

  @Get("/studies/:id/visit-template") @Operation("getSoa")
  soa(@Param("id", new ZodPipe(Uuid)) id: string) { return this.svc.soa(id); }

  @Get("/subject-payments") @Operation("listSubjectPayments")
  listPayments(@Query(new ZodPipe(ListSubjectPaymentsQuery)) q: z.infer<typeof ListSubjectPaymentsQuery>) {
    return this.svc.listPayments(q);
  }

  /* ── 受试者生命周期 ─────────────────────────────────────────────── */

  /* 幂等键在这里是**可选**的：带了就走幂等那条路（重放返回首次结果），
     没带就照旧。断网时这些创建请求要能排进发件箱，而重放意味着同一个
     请求可能发两次 —— 没有键的话，那就是实实在在的两笔。 */
  @Post("/subjects") @Operation("createSubject") @HttpCode(201)
  createSubject(
    @Body(new ZodPipe(CreateSubjectBody)) b: z.infer<typeof CreateSubjectBody>,
    @Headers("idempotency-key") key?: string
  ) {
    return idempotent(this.idem, key, b, () => this.svc.createSubject(b));
  }

  @Post("/subjects/:id\\:sign-icf") @Operation("signIcf")
  signIcf(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(SignIcfBody)) b: z.infer<typeof SignIcfBody>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.signIcf(id, b)); }

  @Post("/subjects/:id\\:enroll") @Operation("enrollSubject")
  enroll(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(EnrollSubjectBody)) b: z.infer<typeof EnrollSubjectBody>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.enroll(id, b)); }

  @Post("/subjects/:id\\:screen-fail") @Operation("screenFailSubject")
  screenFail(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(ScreenFailSubjectBody)) b: z.infer<typeof ScreenFailSubjectBody>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.screenFail(id, b)); }

  @Post("/subjects/:id\\:withdraw") @Operation("withdrawSubject")
  withdraw(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(WithdrawSubjectBody)) b: z.infer<typeof WithdrawSubjectBody>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.withdraw(id, b)); }

  /* ── 访视 ───────────────────────────────────────────────────────── */

  @Post("/subject-visits/:id/tasks/:seq\\:done") @Operation("completeVisitTask")
  completeTask(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Param("seq", new ZodPipe(z.coerce.number().int().min(0))) seq: number,
    @Body(new ZodPipe(CompleteVisitTaskBody)) b: unknown,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, { id, seq }, () => this.svc.completeTask(id, seq)); }

  @Post("/subject-visits/:id\\:complete") @Operation("completeSubjectVisit")
  completeVisit(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(CompleteSubjectVisitBody)) b: z.infer<typeof CompleteSubjectVisitBody>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.completeVisit(id, b)); }

  @Post("/subject-visits/:id\\:confirm") @Operation("confirmSubjectVisit")
  confirmVisit(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(ConfirmSubjectVisitBody)) b: unknown,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, { id }, () => this.svc.confirmVisit(id)); }

  @Post("/subject-visits/:id\\:edc-entered") @Operation("enterVisitToEdc")
  edcEntered(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(EnterVisitToEdcBody)) b: unknown,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, { id }, () => this.svc.markEdcEntered(id)); }

  /* ── 质量事件与补偿 ─────────────────────────────────────────────── */

  @Post("/study-sites/:id/sae") @Operation("reportSae") @HttpCode(201)
  reportSae(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(ReportSaeBody)) b: z.infer<typeof ReportSaeBody>,
    @Headers("idempotency-key") key?: string
  ) { return idempotent(this.idem, key, b, () => this.svc.reportSae(id, b)); }

  @Post("/studies/:id/visit-template\\:replace") @Operation("replaceSoa")
  replaceSoa(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(ReplaceSoaBody)) b: z.infer<typeof ReplaceSoaBody>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.replaceSoa(id, b)); }

  @Post("/quality-events/:id\\:sae-reported") @Operation("reportSaeSubmitted")
  saeReported(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(ReportSaeSubmittedBody)) b: z.infer<typeof ReportSaeSubmittedBody>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.markSaeReported(id, b)); }

  @Post("/quality-events/:id\\:capa") @Operation("setCapaPlan")
  capa(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(SetCapaPlanBody)) b: z.infer<typeof SetCapaPlanBody>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.setCapaPlan(id, b)); }

  @Post("/quality-events/:id\\:close") @Operation("closeQualityEvent")
  closeQuality(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(WithReason)) b: z.infer<typeof WithReason>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.closeQualityEvent(id, b)); }

  @Post("/subject-payments/:id\\:pay") @Operation("paySubjectPayment")
  pay(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(PaySubjectPaymentBody)) b: z.infer<typeof PaySubjectPaymentBody>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.payPayment(id, b)); }
}
