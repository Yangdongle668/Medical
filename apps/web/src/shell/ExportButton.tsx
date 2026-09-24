import { useState } from "react";
import { useToast } from "@sitedesk/ui/react";
import type { EXPORT_LISTS } from "@sitedesk/contracts";
import { call, ApiError, type OperationId } from "../api/client.js";
import { toCsv, downloadText, fetchAll, stamp, EXPORT_CAP, type CsvColumn } from "./csv.js";

/* ════════════════════════════════════════════════════════════════════
   「导出」按钮（W16）。

   导出的是**当前筛选条件下的全部行**，不是屏幕上这一页：翻页拉完再拼。
   数据走列表接口，所以行范围、列权限自动生效 —— 没有筛选号权限的人
   导出来的表里就没有筛选号那一列的值（字段本来就不在）。
   拉完之后记一条导出审计（`recordExport`），不传数据本身。
   ════════════════════════════════════════════════════════════════════ */

export function ExportButton<T>({ op, query, columns, list, name, studySiteId, filter, testid }: {
  op: OperationId;
  /** 与页面上列表用的同一组筛选条件（不含 limit / cursor） */
  query: Record<string, unknown>;
  columns: readonly CsvColumn<T>[];
  list: (typeof EXPORT_LISTS)[number];
  /** 给人看的表名，如「受试者」（审计与提示用） */
  name: string;
  studySiteId?: string | null;
  /** 拉回来之后再按页面上的前端筛选过一遍（页面有接口之外的筛选时给） */
  filter?: (row: T) => boolean;
  testid?: string;
}) {
  const [n, setN] = useState<number | null>(null);
  const say = useToast();

  const run = async () => {
    setN(0);
    try {
      const got = await fetchAll<T>(op, query, setN);
      const rows = filter ? got.items.filter(filter) : got.items;
      const filters: Record<string, string> = {};
      for (const [k, v] of Object.entries(query))
        if (v !== undefined && v !== null && v !== "") filters[k] = String(v).slice(0, 128);
      await call("recordExport", {
        body: { list, rows: rows.length, ...(studySiteId ? { studySiteId } : {}), filters },
        label: `导出${name}` });
      /* 文件名用英文键（subjects-20260924.csv）：中文文件名在一部分 Chromium 里会被丢掉，
         落成一个叫 download、没有扩展名的文件 —— 双击打不开，比英文名糟得多 */
      downloadText(`${list}-${stamp()}.csv`, toCsv(columns, rows));
      say(got.capped
        ? `已导出前 ${EXPORT_CAP} 行 —— 超过上限了，请加筛选条件分几次导`
        : `已导出 ${rows.length} 行`);
    } catch (e) {
      say(e instanceof ApiError ? `导出没成：${e.message}` : "导出没成，请稍后再试");
    } finally { setN(null); }
  };

  return (
    <button className="btn" onClick={() => void run()} disabled={n !== null}
      data-testid={testid ?? "export"} title="按当前筛选条件导出全部行（CSV，Excel 直接打开）">
      {n === null ? "导出" : `正在导出… ${n} 行`}
    </button>
  );
}
