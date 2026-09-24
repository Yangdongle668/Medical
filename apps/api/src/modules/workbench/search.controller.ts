import { Controller, Get, Query } from "@nestjs/common";
import { z } from "zod";
import { SearchQuery } from "@sitedesk/contracts";
import { Operation } from "../../auth/guards.js";
import { ZodPipe } from "../../infra/zod.pipe.js";
import { SearchService } from "./search.service.js";

@Controller("/v1")
export class SearchController {
  constructor(private readonly svc: SearchService) {}

  @Get("/search") @Operation("search")
  search(@Query(new ZodPipe(SearchQuery)) q: z.infer<typeof SearchQuery>) {
    return this.svc.search(q.q);
  }
}
