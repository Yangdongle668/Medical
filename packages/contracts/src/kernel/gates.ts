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
  /** 出现过但**没标门**的键名。见下面那条同名冲突断言。 */
  const ungated = new Map<string, string>();

  const walk = (s: z.ZodType | undefined): void => {
    if (!s || seen.has(s)) return;
    seen.add(s);
    const def = (s as unknown as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
    if (!def) return;

    if (def["type"] === "object") {
      const owner = (z.globalRegistry.get(s) as { id?: string } | undefined)?.id
        ?? "（匿名 schema）";
      for (const [k, v] of Object.entries(def["shape"] as Record<string, z.ZodType>)) {
        const meta = z.globalRegistry.get(v) as Record<string, unknown> | undefined;
        const gate = meta?.["x-gated-by"] as FieldKey | undefined;
        if (gate) {
          const prev = out[k];
          if (prev && prev !== gate)
            throw new Error(`字段 ${k} 在不同 schema 里被标了两种权限：${prev} / ${gate}`);
          out[k] = gate;
        } else if (!ungated.has(k)) {
          ungated.set(k, owner);
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

  /* ── 同名冲突：一个键名一旦被标了门，它在**全站**都会被删 ──────────
     `maskFields` 是按**叶子键名递归删除**的（那是它能不认识 schema
     也能工作的原因）。所以给 `ContractChange.amountCents` 标一个
     price 门，会连带把 `SideEffect.amountCents` 一起删掉 ——
     补偿单的金额、成本归集的金额，全都从副作用里消失。

     这个失败极难查：没有报错，只是某几个字段在某些角色下不见了，
     而且只在**跑到那条命令**时才看得见。第一次撞上它花了半小时。

     所以在这里把它变成一次**构建期失败**，并直接说出该怎么改：
     换一个不重名的键名。 */
  for (const [k, gate] of Object.entries(out)) {
    const owner = ungated.get(k);
    if (owner) throw new Error(
      `字段名冲突：\`${k}\` 在某个 schema 里被标了【${gate}】列权限，` +
      `但 ${owner} 里同名字段没有标门。\n` +
      `maskFields 按叶子键名递归删除，所以无权限时**两处都会被删** ——` +
      `包括那个本不该受管辖的。\n` +
      `改法：给受管辖的那个换一个不重名的键（例如 settledCents / quoteCents）。`);
  }
  return (cache = Object.freeze(out));
}
