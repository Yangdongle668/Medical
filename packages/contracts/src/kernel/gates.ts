import { z } from "zod";
import type { FieldKey } from "./fields.js";

/* ════════════════════════════════════════════════════════════════════
   字段 → 所需权限 的映射。
   **由 zod 定义反推，不在后端另抄一份** —— 抄一份就迟早有一份忘了更新，
   而那一份忘更新的地方就是泄漏点。
   ════════════════════════════════════════════════════════════════════ */

export type FieldGates = Readonly<Record<string, FieldKey>>;

let cache: FieldGates | null = null;

/** 遍历全局注册表，收集所有标了 x-gated-by 的属性名 */
export function fieldGates(): FieldGates {
  if (cache) return cache;
  const out: Record<string, FieldKey> = {};
  const idmap = (z.globalRegistry as unknown as { _idmap?: Map<string, z.ZodType> })._idmap;
  const seen = new Set<z.ZodType>();

  const walk = (s: z.ZodType | undefined): void => {
    if (!s || seen.has(s)) return;
    seen.add(s);
    const def = (s as unknown as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
    if (!def) return;

    if (def["type"] === "object") {
      for (const [k, v] of Object.entries(def["shape"] as Record<string, z.ZodType>)) {
        const meta = z.globalRegistry.get(v) as Record<string, unknown> | undefined;
        const gate = meta?.["x-gated-by"] as FieldKey | undefined;
        if (gate) {
          const prev = out[k];
          if (prev && prev !== gate)
            throw new Error(`字段 ${k} 在不同 schema 里被标了两种权限：${prev} / ${gate}`);
          out[k] = gate;
        }
        walk(v);
      }
    }
    for (const key of ["innerType", "element", "valueType", "keyType"])
      walk(def[key] as z.ZodType | undefined);
    for (const key of ["options", "items"])
      for (const x of (def[key] as z.ZodType[] | undefined) ?? []) walk(x);
  };

  for (const s of idmap?.values() ?? []) walk(s);
  return (cache = Object.freeze(out));
}
