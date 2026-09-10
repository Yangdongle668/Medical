import { Body, Controller, Get, Param, Patch, Post, Query, Headers, HttpCode } from "@nestjs/common";
import { z } from "zod";
/* 请求体与查询串的校验规则**来自契约，不在这里另抄一遍** ——
   与动作权限那一维同一条规矩（见 auth/guards.ts 的 ACTION_OF）。
   抄一遍的代价已经付过一次：`createAccount` 的登录名正则抄对了，
   跟在后面的那句中文提示没抄，于是把登录名填成「周敏」的管理员
   收到的是一串正则，而那几乎必然被读成"这功能坏了"。 */
import { Uuid, WithReason,
  CreateAccountBody, UpdateAccountBody, SetAccountPasswordBody,
  CreateTeamBody, UpdateRolePermissionsBody, ListAccountsQuery,
  ListAuditEntriesQuery, SetLoginAddressBody,
  SetMailTransportBody, TestMailTransportBody } from "@sitedesk/contracts";
import { IdentityService } from "./identity.service.js";
import { IdempotencyService } from "../../infra/idempotency.service.js";
import { ZodPipe } from "../../infra/zod.pipe.js";
import { Operation } from "../../auth/guards.js";
import { command, idempotent } from "../../infra/command.js";
import { MailTransportService } from "../../infra/mail-transport.service.js";
import { AuditService } from "../../infra/audit.service.js";

@Controller("/v1")
export class IdentityController {
  constructor(
    private readonly svc: IdentityService,
    private readonly idem: IdempotencyService,
    private readonly mail: MailTransportService,
    private readonly trail: AuditService
  ) {}

  @Get("/me") @Operation("getMe")
  me() { return this.svc.me(); }

  @Get("/accounts") @Operation("listAccounts")
  list(@Query(new ZodPipe(ListAccountsQuery)) q: z.infer<typeof ListAccountsQuery>) { return this.svc.listAccounts(q); }

  /* 幂等键在这里是**可选**的：带了就走幂等那条路（重放返回首次结果），
     没带就照旧。断网时这些创建请求要能排进发件箱，而重放意味着同一个
     请求可能发两次 —— 没有键的话，那就是实实在在的两笔。 */
  @Post("/accounts") @Operation("createAccount") @HttpCode(201)
  create(
    @Body(new ZodPipe(CreateAccountBody)) b: z.infer<typeof CreateAccountBody>,
    @Headers("idempotency-key") key?: string
  ) {
    return idempotent(this.idem, key, b, () => this.svc.createAccount(b));
  }

  @Post("/accounts/:id\\:disable") @Operation("disableAccount")
  disable(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(WithReason)) b: { reason: string },
    @Headers("idempotency-key") key?: string
  ) {
    return command(this.idem, key, { id, ...b }, () => this.svc.disableAccount(id, b.reason));
  }

  /* 改角色重放两次不会改出第三种角色，但会**在轨迹里记两条**——
     而这一条正是核查员第一屏上的那种。哈希连 id 一起算：
     同一把键换个账号，那是两次不同的操作，必须被认出来。 */
  @Patch("/accounts/:id") @Operation("updateAccount")
  updateAccount(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(UpdateAccountBody)) b: z.infer<typeof UpdateAccountBody>,
    @Headers("idempotency-key") key?: string
  ) {
    return idempotent(this.idem, key, { id, ...b }, () => this.svc.updateAccount(id, b));
  }

  @Post("/accounts/:id\\:enable") @Operation("enableAccount")
  enable(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(WithReason)) b: { reason: string },
    @Headers("idempotency-key") key?: string
  ) {
    return command(this.idem, key, { id, ...b }, () => this.svc.enableAccount(id, b.reason));
  }

  /* 这两条重放的代价不是"设了两次口令"（设的是同一个），而是
     **撤会话撤两次、轨迹里记两条**。两条都在核查员第一屏上，
     而第一屏里出现两条一模一样的「重设账号口令」，读的人只能自己猜
     是重放还是真的做了两次 —— 那正是审计要消灭的那种含糊。 */
  @Post("/accounts/:id\\:set-password") @Operation("setAccountPassword") @HttpCode(204)
  async setPassword(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(SetAccountPasswordBody)) b: z.infer<typeof SetAccountPasswordBody>,
    @Headers("idempotency-key") key?: string
  ) {
    await idempotent(this.idem, key, { id, ...b },
      () => this.svc.setAccountPassword(id, b.password, b.reason));
  }

  @Post("/accounts/:id\\:set-login-address") @Operation("setLoginAddress") @HttpCode(204)
  async setLoginAddress(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(SetLoginAddressBody)) b: z.infer<typeof SetLoginAddressBody>,
    @Headers("idempotency-key") key?: string
  ) {
    await idempotent(this.idem, key, { id, ...b },
      () => this.svc.setLoginAddress(id, b.address, b.reason));
  }

  /* ── 投递通道 ────────────────────────────────────────────────────
     登录链接靠它送出去。在此之前只能改环境变量、重启进程 ——
     也就是说签发登录链接的权限等同于运维权限（login-delivery.ts
     自己把这条列为「上线前该补掉的一项」）。 */
  @Get("/mail-transport") @Operation("getMailTransport")
  mailTransport() { return this.mail.get(); }

  @Post("/mail-transport\\:set") @Operation("setMailTransport") @HttpCode(201)
  async setMailTransport(
    @Body(new ZodPipe(SetMailTransportBody)) b: z.infer<typeof SetMailTransportBody>,
    @Headers("idempotency-key") key: string
  ) {
    return command(this.idem, key, b, async () => {
      const { before, after } = await this.mail.set(b);
      await this.trail.write({
        action: "改投递通道", targetType: "mail_transport", targetId: after.kind,
        /* **不记口令，也不记密文** —— 只记"动没动过"。
           审计轨迹是给核查员看的，而核查员要问的是"谁在什么时候把
           收信这件事改成了什么"，不是那把口令长什么样。 */
        before: { kind: before.kind, url: before.url, from: before.fromAddr,
                  secretSet: before.secretSet },
        after: { kind: after.kind, url: after.url, from: after.fromAddr,
                 secretSet: after.secretSet },
        reason: b.reason });
      return {
        data: after,
        sideEffects: [{
          type: "MailTransportChanged",
          summary: after.kind === "smtp"
            ? `投递通道已改为 ${after.url}（发件人 ${after.fromAddr}）—— ` +
              "**上一次试发的结果已经作废**，用「试发一封」验一次再走"
            : "投递通道已关闭 —— 登录链接照样签得出来，但没有人收得到"
        }]
      };
    });
  }

  @Post("/mail-transport\\:test") @Operation("testMailTransport") @HttpCode(201)
  async testMailTransport(
    @Body(new ZodPipe(TestMailTransportBody)) _b: z.infer<typeof TestMailTransportBody>,
    @Headers("idempotency-key") key: string
  ) {
    return command(this.idem, key, { at: Date.now() }, async () => {
      const r = await this.mail.test();
      return {
        data: r,
        sideEffects: [{
          type: "MailTransportTested",
          summary: r.ok
            ? `试发成功，已送到 ${r.sentTo}`
            : `试发失败：${r.error ?? "没有原因"}`
        }]
      };
    });
  }

  @Get("/teams") @Operation("listTeams")
  teams() { return this.svc.listTeams(); }

  @Post("/teams") @Operation("createTeam") @HttpCode(201)
  createTeam(
    @Body(new ZodPipe(CreateTeamBody)) b: z.infer<typeof CreateTeamBody>,
    @Headers("idempotency-key") key?: string
  ) {
    return idempotent(this.idem, key, b, () => this.svc.createTeam(b));
  }

  @Get("/roles") @Operation("listRoles")
  roles() { return this.svc.listRoles(); }

  @Patch("/roles/:id") @Operation("updateRolePermissions")
  updateRole(
    @Param("id", new ZodPipe(Uuid)) id: string,
    @Body(new ZodPipe(UpdateRolePermissionsBody)) b: z.infer<typeof UpdateRolePermissionsBody>,
    @Headers("idempotency-key") key?: string
  ) {
    return idempotent(this.idem, key, { id, ...b }, () => this.svc.updateRole(id, b));
  }

  @Get("/audit-entries") @Operation("listAuditEntries")
  audit(@Query(new ZodPipe(ListAuditEntriesQuery)) q: z.infer<typeof ListAuditEntriesQuery>) { return this.svc.listAudit(q); }
}
