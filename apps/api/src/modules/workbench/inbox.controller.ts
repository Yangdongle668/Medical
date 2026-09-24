import { Controller, Get } from "@nestjs/common";
import { Operation } from "../../auth/guards.js";
import { InboxService } from "./inbox.service.js";

@Controller("/v1")
export class InboxController {
  constructor(private readonly svc: InboxService) {}

  @Get("/me/inbox") @Operation("getMyInbox")
  mine() {
    return this.svc.mine();
  }
}
