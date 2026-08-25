import { z } from "zod";
import { Cursor } from "./primitives.js";

/** 游标分页。offset 分页在数据持续变动时会重复或漏掉记录。 */
export const PageQuery = z.object({
  cursor: Cursor.optional(),
  limit:  z.coerce.number().int().min(1).max(200).default(50)
});

export const page = <T extends z.ZodType>(item: T) =>
  z.object({
    items:      z.array(item),
    nextCursor: Cursor.nullable().describe("null 表示已到末页"),
    /** 故意不返回 total：范围过滤 + RLS 之下算总数代价高，且几乎无人真的需要。
     *  确实需要时走独立的 count 接口。 */
  });
