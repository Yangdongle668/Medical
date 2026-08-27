import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import {
  PageQuery, Uuid, DateOnly, Timestamp, WithReason,
  SubjectState, VisitStatus, ScreenFailReason, WithdrawReason,
  QualityKind, QualityState, QueryBool
} from "@sitedesk/contracts";
import { ClinicalService } from "./clinical.service.js";
import { IdempotencyService } from "../../infra/idempotency.service.js";
import { command, idempotent } from "../../infra/command.js";
import { ZodPipe } from "../../infra/zod.pipe.js";
import { Operation } from "../../auth/guards.js";

/* 查询参数的形状与契约同源：契约改了这里必然编译不过 */
const arr = <T extends z.ZodType>(t: T) =>
  z.union([t, z.array(t)]).transform(v => Array.isArray(v) ? v : [v]).optional();

const SubjectQ = PageQuery.extend({
  studySiteId: Uuid.optional(),
  state: arr(SubjectState),
  outOfWindow: QueryBool.optional(),
  q: z.string().max(64).optional()
});
const VisitQ = PageQuery.extend({
  studySiteId: Uuid.optional(),
  subjectId: Uuid.optional(),
  status: arr(VisitStatus),
  outOfWindow: QueryBool.optional(),
  pendingPi: QueryBool.optional()
});
const QualityQ = PageQuery.extend({
  studySiteId: Uuid.optional(),
  kind: arr(QualityKind),
  state: arr(QualityState)
});
const PaymentQ = PageQuery.extend({
  studySiteId: Uuid.optional(),
  unpaid: QueryBool.optional()
});

const CreateSubject = z.object({
  studySiteId: Uuid, screeningNo: z.string().trim().min(1).max(32)
});
const SignIcf = z.object({ signedOn: DateOnly });
const Enroll = z.object({
  randomizationNo: z.string().trim().min(1).max(32), enrolledOn: DateOnly
});
const ScreenFail = z.object({
  reason: ScreenFailReason, failedOn: DateOnly, note: z.string().max(500).optional()
});
const Withdraw = z.object({
  reason: WithdrawReason, withdrawnOn: DateOnly, note: z.string().trim().min(4).max(500)
});
const CompleteVisit = z.object({
  actualDate: DateOnly,
  outOfWindowReason: z.string().trim().min(4).max(500).optional(),
  hours: z.number().min(0.25).max(24),
  note: z.string().max(500).optional()
});
const Pay = z.object({
  paidOn: DateOnly, receiptRef: z.string().trim().min(1).max(64)
});
const Empty = z.object({});
const ReportSae = z.object({
  subjectId: Uuid.optional(),
  title: z.string().trim().min(1).max(200),
  detail: z.string().trim().min(4).max(2000),
  occurredAt: Timestamp,
  reportedAt: Timestamp.optional()
});
const SaeReported = z.object({ reportedAt: Timestamp });
const SoaVisitIn = z.object({
  seq: z.coerce.number().int().min(0),
  /* 与契约的 Code 同一条规则。`~` 不在允许字符里 ——
     服务端腾编号位置时用的正是那个后缀。 */
  visitCode: z.string().trim().min(1).max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  visitLabel: z.string().trim().min(1).max(120),
  anchor: z.enum(["icf", "enroll"]),
  offsetDays: z.coerce.number().int().min(-365).max(3650),
  windowDays: z.coerce.number().int().min(0).max(120),
  compensationCents: z.coerce.number().int().min(0),
  tasks: z.array(z.string().trim().min(1).max(120)).max(30)
});
const ReplaceSoa = z.object({
  visits: z.array(SoaVisitIn).min(1).max(80),
  reason: z.string().trim().min(4).max(500)
});

@Controller("/v1")
export class ClinicalController {
  constructor(
    private readonly svc: ClinicalService,
    private readonly idem: IdempotencyService
  ) {}

  /* ── 读 ─────────────────────────────────────────────────────────── */

  @Get("/subjects") @Operation("listSubjects")
  listSubjects(@Query(new ZodPipe(SubjectQ)) q: z.infer<typeof SubjectQ>) {
    return this.svc.listSubjects(q);
  }

  @Get("/subjects/:id") @Operation("getSubject")
  getSubject(@Param("id", new ZodPipe(Uuid)) id: string) { return this.svc.getSubject(id); }

  @Get("/study-sites/:id/funnel") @Operation("getSiteFunnel")
  funnel(@Param("id", new ZodPipe(Uuid)) id: string) { return this.svc.funnel(id); }

  @Get("/subject-visits") @Operation("listSubjectVisits")
  listVisits(@Query(new ZodPipe(VisitQ)) q: z.infer<typeof VisitQ>) {
    return this.svc.listVisits(q);
  }

  @Get("/subject-visits/:id") @Operation("getSubjectVisit")
  getVisit(@Param("id", new ZodPipe(Uuid)) id: string) { return this.svc.visit(id); }

  @Get("/quality-events") @Operation("listQualityEvents")
  listQuality(@Query(new ZodPipe(QualityQ)) q: z.infer<typeof QualityQ>) {
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
  listPayments(@Query(new ZodPipe(PaymentQ)) q: z.infer<typeof PaymentQ>) {
    return this.svc.listPayments(q);
  }

  /* ── 受试者生命周期 ─────────────────────────────────────────────── */

  /* 幂等键在这里是**可选**的：带了就走幂等那条路（重放返回首次结果），
     没带就照旧。断网时这些创建请求要能排进发件箱，而重放意味着同一个
     请求可能发两次 —— 没有键的话，那就是实实在在的两笔。 */
  @Post("/subjects") @Operation("createSubject") @HttpCode(201)
  createSubject(
    @Body(new ZodPipe(CreateSubject)) b: z.infer<typeof CreateSubject>,
    @Headers("idempotency-key") key?: string
  ) {
    return idempotent(this.idem, key, b, () => this.svc.createSubject(b));
  }

  @Post("/subjects/:id\\:sign-icf") @Operation("signIcf")
  signIcf(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(SignIcf)) b: z.infer<typeof SignIcf>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.signIcf(id, b)); }

  @Post("/subjects/:id\\:enroll") @Operation("enrollSubject")
  enroll(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(Enroll)) b: z.infer<typeof Enroll>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.enroll(id, b)); }

  @Post("/subjects/:id\\:screen-fail") @Operation("screenFailSubject")
  screenFail(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(ScreenFail)) b: z.infer<typeof ScreenFail>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.screenFail(id, b)); }

  @Post("/subjects/:id\\:withdraw") @Operation("withdrawSubject")
  withdraw(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(Withdraw)) b: z.infer<typeof Withdraw>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.withdraw(id, b)); }

  /* ── 访视 ───────────────────────────────────────────────────────── */

  @Post("/subject-visits/:id/tasks/:seq\\:done") @Operation("completeVisitTask")
  completeTask(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Param("seq", new ZodPipe(z.coerce.number().int().min(0))) seq: number,
    @Body(new ZodPipe(Empty)) b: unknown,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, { id, seq }, () => this.svc.completeTask(id, seq)); }

  @Post("/subject-visits/:id\\:complete") @Operation("completeSubjectVisit")
  completeVisit(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(CompleteVisit)) b: z.infer<typeof CompleteVisit>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.completeVisit(id, b)); }

  @Post("/subject-visits/:id\\:confirm") @Operation("confirmSubjectVisit")
  confirmVisit(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(Empty)) b: unknown,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, { id }, () => this.svc.confirmVisit(id)); }

  @Post("/subject-visits/:id\\:edc-entered") @Operation("enterVisitToEdc")
  edcEntered(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(Empty)) b: unknown,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, { id }, () => this.svc.markEdcEntered(id)); }

  /* ── 质量事件与补偿 ─────────────────────────────────────────────── */

  @Post("/study-sites/:id/sae") @Operation("reportSae") @HttpCode(201)
  reportSae(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(ReportSae)) b: z.infer<typeof ReportSae>,
    @Headers("idempotency-key") key?: string
  ) { return idempotent(this.idem, key, b, () => this.svc.reportSae(id, b)); }

  @Post("/studies/:id/visit-template\\:replace") @Operation("replaceSoa")
  replaceSoa(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(ReplaceSoa)) b: z.infer<typeof ReplaceSoa>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.replaceSoa(id, b)); }

  @Post("/quality-events/:id\\:sae-reported") @Operation("reportSaeSubmitted")
  saeReported(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(SaeReported)) b: z.infer<typeof SaeReported>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.markSaeReported(id, b)); }

  @Post("/quality-events/:id\\:close") @Operation("closeQualityEvent")
  closeQuality(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(WithReason)) b: z.infer<typeof WithReason>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.closeQualityEvent(id, b)); }

  @Post("/subject-payments/:id\\:pay") @Operation("paySubjectPayment")
  pay(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(Pay)) b: z.infer<typeof Pay>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.payPayment(id, b)); }
}
