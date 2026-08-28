import { Body, Controller, Get, Param, Patch, Post, Query, Headers, HttpCode } from "@nestjs/common";
import { z } from "zod";
import { PageQuery, Uuid, WithReason, RowRule, ActionKey, FieldKey, QueryBool } from "@sitedesk/contracts";
import { IdentityService } from "./identity.service.js";
import { IdempotencyService } from "../../infra/idempotency.service.js";
import { ZodPipe } from "../../infra/zod.pipe.js";
import { Operation } from "../../auth/guards.js";
import { ProblemException } from "../../infra/problem.js";
import { idempotent } from "../../infra/command.js";

const ListQ = PageQuery.extend({
  status: z.enum(["active", "disabled"]).optional(),
  roleCode: z.string().optional(),
  q: z.string().max(64).optional()
});
const CreateBody = z.object({
  login: z.string().regex(/^[a-z][a-z0-9_]{2,31}$/),
  displayName: z.string().min(1).max(64),
  roleId: Uuid,
  teamId: Uuid.nullable().optional(),
  orgRef: z.string().max(128).nullable().optional()
});
const RoleBody = z.object({
  rowRule: RowRule.optional(),
  visibleFields: z.array(FieldKey).optional(),
  allowedActions: z.array(ActionKey).optional(),
  modules: z.array(z.string()).optional()
}).extend(WithReason.shape);
const UpdateBody = z.object({
  roleId: Uuid.optional(),
  teamId: Uuid.nullable().optional(),
  orgRef: z.string().max(128).nullable().optional()
}).extend(WithReason.shape);
const TeamBody = z.object({
  code: z.string().regex(/^[A-Za-z0-9-]{2,16}$/),
  name: z.string().min(1).max(64),
  leadAccountId: Uuid.nullable().optional()
});
const SetPasswordBody = z.object({
  password: z.string().min(8).max(200)
}).extend(WithReason.shape);
const AuditQ = PageQuery.extend({
  studySiteId: Uuid.optional(), actorLogin: z.string().optional(),
  targetType: z.string().optional(), targetId: z.string().optional(),
  sensitiveOnly: QueryBool.optional(),
  since: z.iso.datetime({ offset: true }).optional()
});

@Controller("/v1")
export class IdentityController {
  constructor(
    private readonly svc: IdentityService,
    private readonly idem: IdempotencyService
  ) {}

  @Get("/me") @Operation("getMe")
  me() { return this.svc.me(); }

  @Get("/accounts") @Operation("listAccounts")
  list(@Query(new ZodPipe(ListQ)) q: z.infer<typeof ListQ>) { return this.svc.listAccounts(q); }

  /* 幂等键在这里是**可选**的：带了就走幂等那条路（重放返回首次结果），
     没带就照旧。断网时这些创建请求要能排进发件箱，而重放意味着同一个
     请求可能发两次 —— 没有键的话，那就是实实在在的两笔。 */
  @Post("/accounts") @Operation("createAccount") @HttpCode(201)
  create(
    @Body(new ZodPipe(CreateBody)) b: z.infer<typeof CreateBody>,
    @Headers("idempotency-key") key?: string
  ) {
    return idempotent(this.idem, key, b, () => this.svc.createAccount(b));
  }

  @Post("/accounts/:id\\:disable") @Operation("disableAccount")
  async disable(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(WithReason)) b: { reason: string },
    @Headers("idempotency-key") key?: string
  ) {
    if (!key) throw new ProblemException("validation-failed", {
      detail: "L2 命令必须携带 Idempotency-Key 请求头",
      issues: [{ path: "/headers/idempotency-key", message: "必填" }] });
    const replay = await this.idem.begin(key, { id, ...b });
    if (replay) return replay.body;
    const out = await this.svc.disableAccount(id, b.reason);
    await this.idem.complete(key, 200, out);
    return out;
  }

  @Patch("/accounts/:id") @Operation("updateAccount")
  updateAccount(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(UpdateBody)) b: z.infer<typeof UpdateBody>
  ) { return this.svc.updateAccount(id, b); }

  @Post("/accounts/:id\\:enable") @Operation("enableAccount")
  async enable(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(WithReason)) b: { reason: string },
    @Headers("idempotency-key") key?: string
  ) {
    if (!key) throw new ProblemException("validation-failed", {
      detail: "L2 命令必须携带 Idempotency-Key 请求头",
      issues: [{ path: "/headers/idempotency-key", message: "必填" }] });
    const replay = await this.idem.begin(key, { id, ...b });
    if (replay) return replay.body;
    const out = await this.svc.enableAccount(id, b.reason);
    await this.idem.complete(key, 200, out);
    return out;
  }

  @Post("/accounts/:id\\:set-password") @Operation("setAccountPassword") @HttpCode(204)
  async setPassword(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(SetPasswordBody)) b: z.infer<typeof SetPasswordBody>
  ) { await this.svc.setAccountPassword(id, b.password, b.reason); }

  @Get("/teams") @Operation("listTeams")
  teams() { return this.svc.listTeams(); }

  @Post("/teams") @Operation("createTeam") @HttpCode(201)
  createTeam(@Body(new ZodPipe(TeamBody)) b: z.infer<typeof TeamBody>) {
    return this.svc.createTeam(b);
  }

  @Get("/roles") @Operation("listRoles")
  roles() { return this.svc.listRoles(); }

  @Patch("/roles/:id") @Operation("updateRolePermissions")
  updateRole(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(RoleBody)) b: z.infer<typeof RoleBody>
  ) { return this.svc.updateRole(id, b); }

  @Get("/audit-entries") @Operation("listAuditEntries")
  audit(@Query(new ZodPipe(AuditQ)) q: z.infer<typeof AuditQ>) { return this.svc.listAudit(q); }
}
