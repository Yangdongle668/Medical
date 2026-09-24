import { ProblemException } from "./problem.js";

/* ════════════════════════════════════════════════════════════════════
   翻页游标 = **排序键本身**。

   ── 为什么要有这个文件 ────────────────────────────────────────────
   十一个列表端点曾经是同一个写法：

       ORDER BY 某日期 DESC, id DESC          -- 或 ASC
       WHERE … AND id < $游标                 -- 游标 = 末行 id

   id 是 uuid，与那个日期毫无关系。于是第二页会**漏掉**日期更早而 id 更大的行，
   又把日期更晚而 id 更小的行**再给一遍**。只取一页的调用方永远看不出来，
   而界面上几乎所有调用方都只取一页 —— 这正是它能活这么久的原因。

   每个端点各写一遍"正确的"游标，下一个新端点照样会抄错的那份。
   所以收成一处：**游标由排序键和 id 拼成，条件由排序方向推出来。**

   ── 格式 ──────────────────────────────────────────────────────────
   `<排序键的文本>|<uuid>`。排序键在 SQL 里转成文本，不经过 JS 的 Date ——
   那一趟会按进程时区换算，东八区的零点在 UTC 里是前一天。
   date 取 `::text`（`2026-09-24`）；timestamptz 取固定的 UTC 形式
   （`2026-09-24T05:00:00.123456Z`，微秒都在）—— `::text` 会带 `+00`，
   而 `+` 放进 URL 没编码的话会变成空格。
   ════════════════════════════════════════════════════════════════════ */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export interface Keyset {
  /** 排序键的 SQL 表达式，例如 `q.raised_on`、`upper(v.visit_window)` */
  key: string;
  /** 排序键的类型 —— 游标里的文本按它转回来 */
  type: "date" | "timestamptz";
  /** 排序键的方向 */
  dir: "asc" | "desc";
  /** 同键时 id 的方向 */
  idDir: "asc" | "desc";
  /** id 列，例如 `q.id` */
  id: string;
}

/** 由游标生成 WHERE 条件。认不出来的游标是 422，不是 500。 */
export function keysetCond(k: Keyset, cursor: string, add: (v: unknown) => string): string {
  const at = cursor.indexOf("|");
  const keyText = at > 0 ? cursor.slice(0, at) : "";
  const id = at > 0 ? cursor.slice(at + 1) : "";
  const keyOk = (k.type === "date" ? DATE : INSTANT).test(keyText);
  if (!keyOk || !UUID.test(id)) {
    throw new ProblemException("validation-failed", {
      detail: "翻页游标不认得 —— 它应当原样取自上一页的 nextCursor。"
    });
  }
  const d = `${add(keyText)}::${k.type}`;
  const i = `${add(id)}::uuid`;
  const kOp = k.dir === "asc" ? ">" : "<";
  const iOp = k.idDir === "asc" ? ">" : "<";
  /* 同向：一个行比较就够了，而且索引直接可用。 */
  if (k.dir === k.idDir) return `(${k.key}, ${k.id}) ${kOp} (${d}, ${i})`;
  /* 反向拼不成行比较。前半句给索引一个范围边界，后半句只在同键那一小段里起作用。 */
  return `(${k.key} ${kOp}= ${d} AND (${k.key} ${kOp} ${d} OR ${k.id} ${iOp} ${i}))`;
}

/** SELECT 里要多取的那一列：排序键的文本形式。 */
export const keysetCol = (k: Keyset) => k.type === "date"
  ? `(${k.key})::text AS cursor_key`
  : `to_char((${k.key}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_key`;

/** 取了 limit + 1 行时，下一页的游标。 */
export function keysetNext(rows: { cursor_key: string; id: string }[], limit: number): string | null {
  if (rows.length <= limit) return null;
  const last = rows[limit - 1]!;
  return `${last.cursor_key}|${last.id}`;
}
