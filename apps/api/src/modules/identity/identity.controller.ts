import { Body, Controller, Get, Param, Patch, Post, Query, Headers, HttpCode } from "@nestjs/common";
import { z } from "zod";
import { PageQuery, Uuid, WithReason, RowRule, ActionKey, FieldKey } from "@sitedesk/contracts";
import { IdentityService } from "./identity.service.js";
import { IdempotencyService } from "../../infra/idempotency.service.js";
import { ZodPipe } from "../../infra/zod.pipe.js";
import { Operation, RequireAction } from "../../auth/guards.js";
import { ProblemException } from "../../infra/problem.js";

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
const AuditQ = PageQuery.extend({
  studySiteId: Uuid.optional(), actorLogin: z.string().optional(),
  targetType: z.string().optional(), targetId: z.string().optional(),
  sensitiveOnly: z.coerce.boolean().optional(),
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

  @Post("/accounts") @Operation("createAccount") @RequireAction("manage") @HttpCode(201)
  create(@Body(new ZodPipe(CreateBody)) b: z.infer<typeof CreateBody>) {
    return this.svc.createAccount(b);
  }

  @Post("/accounts/:id\\:disable") @Operation("disableAccount") @RequireAction("manage")
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

  @Get("/roles") @Operation("listRoles")
  roles() { return this.svc.listRoles(); }

  @Patch("/roles/:id") @Operation("updateRolePermissions") @RequireAction("manage")
  updateRole(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(RoleBody)) b: z.infer<typeof RoleBody>
  ) { return this.svc.updateRole(id, b); }

  @Get("/audit-entries") @Operation("listAuditEntries")
  audit(@Query(new ZodPipe(AuditQ)) q: z.infer<typeof AuditQ>) { return this.svc.listAudit(q); }
}
