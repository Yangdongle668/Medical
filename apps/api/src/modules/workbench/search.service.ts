import { Injectable } from "@nestjs/common";
import { principal } from "../../infra/ctx.js";
import { SiteService } from "../site/site.service.js";
import { ClinicalService } from "../clinical/clinical.service.js";

/* 全局搜索（契约见 contracts/src/workbench/api.ts）。
   与「我的待办」同一个做法：不写新 SQL，调所属模块自己的列表方法 ——
   中心按代号 / 医院名、受试者按筛选号，这两条匹配规则各只有一份。 */

const PER_TYPE = 5;

@Injectable()
export class SearchService {
  constructor(
    private readonly sites: SiteService,
    private readonly clinical: ClinicalService
  ) {}

  async search(q: string) {
    const p = principal();
    const items: {
      type: "site" | "subject"; id: string; label: string; sub: string;
      studySiteId: string; screeningNo?: string;
    }[] = [];

    const s = await this.sites.list({ limit: PER_TYPE, q });
    for (const x of s.items)
      items.push({ type: "site", id: x.id, label: `${x.code} ${x.hospital}`,
        sub: x.study.shortName, studySiteId: x.id });

    /* 受试者：要 subjRead，**还要**受试者列权限 —— 否则命中数本身就在说
       「有这个筛选号」，而那正是列权限不让他知道的事。 */
    if ((p.actions as readonly string[]).includes("subjRead")
        && (p.fields as readonly string[]).includes("subject")) {
      const r = await this.clinical.listSubjects({ limit: PER_TYPE, q });
      for (const x of r.items)
        items.push({ type: "subject", id: x.id, label: x.siteCode,
          sub: x.nextVisit ? `下一次：${x.nextVisit.visitLabel}` : "",
          studySiteId: x.studySiteId, screeningNo: x.screeningNo });
    }
    return { items };
  }
}
