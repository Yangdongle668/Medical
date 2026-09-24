import { Body, Controller, Headers, Post } from "@nestjs/common";
import { z } from "zod";
import { RecordExportBody, ImportCsvBody, ImportPrescreenBody } from "@sitedesk/contracts";
import { Operation } from "../../auth/guards.js";
import { ZodPipe } from "../../infra/zod.pipe.js";
import { IdempotencyService } from "../../infra/idempotency.service.js";
import { command } from "../../infra/command.js";
import { IoService } from "./io.service.js";

@Controller("/v1")
export class IoController {
  constructor(private readonly svc: IoService, private readonly idem: IdempotencyService) {}

  @Post("/exports\\:record") @Operation("recordExport")
  recordExport(
    @Body(new ZodPipe(RecordExportBody)) b: z.infer<typeof RecordExportBody>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.recordExport(b)); }

  @Post("/imports/prescreen\\:preview") @Operation("previewPrescreenImport")
  previewPrescreen(
    @Body(new ZodPipe(ImportPrescreenBody)) b: z.infer<typeof ImportPrescreenBody>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.prescreen(b, true)); }

  @Post("/imports/prescreen\\:commit") @Operation("commitPrescreenImport")
  commitPrescreen(
    @Body(new ZodPipe(ImportPrescreenBody)) b: z.infer<typeof ImportPrescreenBody>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.prescreen(b, false)); }

  @Post("/imports/accounts\\:preview") @Operation("previewAccountImport")
  previewAccounts(
    @Body(new ZodPipe(ImportCsvBody)) b: z.infer<typeof ImportCsvBody>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.accounts(b, true)); }

  @Post("/imports/accounts\\:commit") @Operation("commitAccountImport")
  commitAccounts(
    @Body(new ZodPipe(ImportCsvBody)) b: z.infer<typeof ImportCsvBody>,
    @Headers("idempotency-key") key?: string
  ) { return command(this.idem, key, b, () => this.svc.accounts(b, false)); }
}
