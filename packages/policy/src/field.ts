import type { FieldKey } from "@sitedesk/contracts";
import type { Principal } from "./principal.js";

/* ════════════════════════════════════════════════════════════════════
   列维度 —— 同一行里哪些字段可见。

   **无权限的字段从响应里删除，不是置 null。**
   null 泄漏了"这个字段存在"这件事：对机构办来说，
   知道我们有「毛利率」这个字段，和知道它的值，是两个不同的泄漏等级。
   ════════════════════════════════════════════════════════════════════ */

/** 参数只要 `active` 与 `fields` —— 判定用不到主体的其余部分。
 *  收窄到这两项，前端 mock 才能诚实地传它真正拥有的东西，
 *  而不是把一个半截对象 `as Principal` 硬塞进来：
 *  那种转换会一直成立，直到 Principal 加了一个判定真的要用的字段。 */
export type FieldSubject = Pick<Principal, "active" | "fields">;

export const canField = (p: FieldSubject, f: FieldKey): boolean =>
  p.active && p.fields.includes(f);

/** 字段路径 → 所需权限。与契约里的 x-gated-by 同源，由 CI 断言两者一致。 */
export type FieldGates = Readonly<Record<string, FieldKey>>;

/**
 * 递归剔除无权限字段。
 *
 * 只认**叶子键名**，不认路径 —— 因为同名字段在任何嵌套层级下的敏感度相同：
 * `unitPriceCents` 无论出现在 StudySite 还是 SiteGate 里，都是报价信息。
 * 这条约定让脱敏无法被"换个嵌套位置"绕过。
 */
export function maskFields<T>(p: FieldSubject, gates: FieldGates, value: T): T {
  const denied = new Set(
    Object.entries(gates).filter(([, f]) => !canField(p, f)).map(([k]) => k));
  if (denied.size === 0) return value;

  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object" && !(v instanceof Date)) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (denied.has(k)) continue;          // 删除，不是置 null
        out[k] = walk(x);
      }
      return out;
    }
    return v;
  };
  return walk(value) as T;
}
