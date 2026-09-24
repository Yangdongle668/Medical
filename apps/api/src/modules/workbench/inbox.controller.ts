import { Body, Controller, Get, Headers, Patch } from "@nestjs/common";
import { z } from "zod";
import { SetNotifyPrefsBody } from "@sitedesk/contracts";
import { Operation } from "../../auth/guards.js";
import { ZodPipe } from "../../infra/zod.pipe.js";
import { IdempotencyService } from "../../infra/idempotency.service.js";
import { idempotent } from "../../infra/command.js";
import { InboxService } from "./inbox.service.js";
import { RemindService } from "./remind.service.js";

@Controller("/v1")
export class InboxController {
  constructor(
    private readonly svc: InboxService,
    private readonly remind: RemindService,
    private readonly idem: IdempotencyService
  ) {}

  @Get("/me/inbox") @Operation("getMyInbox")
  mine() {
    return this.svc.mine();
  }

  @Get("/me/notify-prefs") @Operation("getNotifyPrefs")
  prefs() {
    return this.remind.prefs();
  }

  @Patch("/me/notify-prefs") @Operation("setNotifyPrefs")
  setPrefs(
    @Body(new ZodPipe(SetNotifyPrefsBody)) b: z.infer<typeof SetNotifyPrefsBody>,
    @Headers("idempotency-key") key?: string
  ) {
    return idempotent(this.idem, key, b, () => this.remind.setPrefs(b));
  }
}
