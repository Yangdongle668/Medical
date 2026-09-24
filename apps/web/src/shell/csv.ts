import { call, type OperationId } from "../api/client.js";

/* ════════════════════════════════════════════════════════════════════
   导出（W16）与导入模板用到的 CSV。

   · **UTF-8 带 BOM**：没有 BOM，Excel 按系统编码（GBK）打开，中文全是乱码 ——
     导出这件事在一线那里就等于没做。
   · **公式注入**：单元格以 = + - @ 开头时 Excel 会当公式算。受试者备注、
     质疑内容这些都是人填的字，前面垫一个 ' 让它老老实实当文本。
     数字不垫（-3 天就是 -3）。
   ════════════════════════════════════════════════════════════════════ */

export type Cell = string | number | boolean | null | undefined;
export interface CsvColumn<T> { label: string; value: (row: T) => Cell }

const esc = (v: Cell): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "是" : "否";
  let s = v;
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv<T>(columns: readonly CsvColumn<T>[], rows: readonly T[]): string {
  const lines = [columns.map(c => esc(c.label)).join(",")];
  for (const r of rows) lines.push(columns.map(c => esc(c.value(r))).join(","));
  return "﻿" + lines.join("\r\n") + "\r\n";
}

export function downloadText(filename: string, text: string, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a); a.click();
  /* 当场移除或回收的话，Chromium 会丢掉 download 属性给的文件名（落成一个叫 download 的文件） */
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
}

/** 一次导出至多拉这么多行。再多就该去找数据经理要数据库导出了，不是在浏览器里拼。 */
export const EXPORT_CAP = 5000;

/** 按当前筛选条件把列表翻页拉完。返回拉到的行，以及是不是因为到了上限才停。 */
export async function fetchAll<T>(
  op: OperationId, query: Record<string, unknown>, onProgress?: (n: number) => void
): Promise<{ items: T[]; capped: boolean }> {
  const items: T[] = [];
  let cursor: string | null = null;
  do {
    const r: { items: T[]; nextCursor?: string | null } = await call(op,
      { query: { ...query, limit: 200, ...(cursor ? { cursor } : {}) } });
    items.push(...r.items);
    onProgress?.(items.length);
    /* 游标原地不动就停：服务端的缺陷不该变成浏览器里的死循环 */
    const next: string | null = r.nextCursor ?? null;
    cursor = next === cursor ? null : next;
  } while (cursor && items.length < EXPORT_CAP);
  return { items: items.slice(0, EXPORT_CAP), capped: !!cursor || items.length > EXPORT_CAP };
}

/** 文件名里的日期：本地的今天。 */
export const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
};

/** 读上传的 CSV。Excel 的「CSV（逗号分隔）」在中文 Windows 上存的是 GBK，
 *  只有「CSV UTF-8」才是 UTF-8 —— 两种都认，而不是让人去猜该选哪个。 */
export async function readCsvFile(f: File): Promise<string> {
  const buf = await f.arrayBuffer();
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); }
  catch { return new TextDecoder("gb18030").decode(buf); }
}
