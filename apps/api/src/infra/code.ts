import { ctx } from "./ctx.js";

/* ════════════════════════════════════════════════════════════════════
   发号。**服务层唯一被允许拿到编号的地方。**

   规则不在这里 —— 在 `code_rule` 表里（迁移 0043）。这里只是把它取出来。
   在此之前，编号在十二处各自拼字符串，拼出了三套互不兼容的格式，
   其中四处还用 `count(*) + 1` 取号（行数不是序号，撞号就是 500）。

   `kind` 必须是 code_rule 里登记过的一种，写错会得到一个说明白的异常
   而不是一个奇怪的编号。`parent` 只有 shape=child 的编号要给
   （目前只有受试者筛选号，挂在中心编号下面）。
   ════════════════════════════════════════════════════════════════════ */
export async function nextCode(kind: string, parent?: string): Promise<string> {
  const c = ctx();
  const { rows } = await c.client.query<{ code: string }>(
    `SELECT app.next_code($1, $2) AS code`, [kind, parent ?? null]);
  return rows[0]!.code;
}
