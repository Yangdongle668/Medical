import { ProblemException } from "./problem.js";

/* ════════════════════════════════════════════════════════════════════
   CSV 读取 —— 批量导入用（W17）。

   只认 RFC 4180 那一套：逗号分隔、双引号包裹、引号里 "" 表示一个引号、
   CRLF 或 LF 换行。Excel「另存为 CSV UTF-8」给的就是这个，外加一个 BOM。
   不引第三方库：几十行能说清的事，不值得多一个要跟安全公告的依赖。
   ════════════════════════════════════════════════════════════════════ */

export function parseCsv(text: string): string[][] {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const out: string[][] = [];
  let row: string[] = [], cell = "", quoted = false, i = 0;
  const endCell = () => { row.push(cell); cell = ""; };
  const endRow = () => { endCell(); out.push(row); row = []; };
  while (i < s.length) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      cell += ch; i++; continue;
    }
    if (ch === '"' && cell === "") { quoted = true; i++; continue; }
    if (ch === ",") { endCell(); i++; continue; }
    if (ch === "\r" && s[i + 1] === "\n") { endRow(); i += 2; continue; }
    if (ch === "\n" || ch === "\r") { endRow(); i++; continue; }
    cell += ch; i++;
  }
  if (quoted)
    throw new ProblemException("validation-failed", {
      detail: "文件里有一个没配对的双引号 —— 请用 Excel「另存为 CSV UTF-8」重新导出" });
  if (cell !== "" || row.length) endRow();
  return out;
}

export interface Column<K extends string> { key: K; label: string; required?: boolean }
export interface TableRow<K extends string> { line: number; cells: Record<K, string> }

/** 表头名的比较口径：去掉首尾空白与括号里的提示（模板写的是「筛选号（空着=自动发号）」）。 */
const norm = (h: string) => h.trim().replace(/[（(].*[)）]\s*$/, "").trim();

/** 按表头取列，去掉全空的行。缺必需列、没有数据、超过上限都整体拒绝（422）。 */
export function readTable<K extends string>(
  text: string, columns: readonly Column<K>[], maxRows = 500
): TableRow<K>[] {
  const all = parseCsv(text);
  const header = (all[0] ?? []).map(norm);
  const missing = columns.filter(c => c.required && !header.includes(c.label)).map(c => c.label);
  if (missing.length)
    throw new ProblemException("validation-failed", {
      detail: `第 1 行（表头）缺少这几列：${missing.join("、")}。请从页面上下载模板填写` });

  const idx = columns.map(c => header.indexOf(c.label));
  const rows: TableRow<K>[] = [];
  for (let r = 1; r < all.length; r++) {
    const raw = all[r]!;
    if (raw.every(v => v.trim() === "")) continue;
    const cells = {} as Record<K, string>;
    columns.forEach((c, j) => { cells[c.key] = idx[j]! >= 0 ? (raw[idx[j]!] ?? "").trim() : ""; });
    rows.push({ line: r + 1, cells });
  }
  if (!rows.length)
    throw new ProblemException("validation-failed", { detail: "文件里除了表头没有数据" });
  if (rows.length > maxRows)
    throw new ProblemException("validation-failed", {
      detail: `一次至多 ${maxRows} 行，这个文件有 ${rows.length} 行 —— 请拆成几份` });
  return rows;
}
