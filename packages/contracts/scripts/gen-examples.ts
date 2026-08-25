/* 由 openapi.yaml 生成每个端点的示例响应，供前端在 Phase 5/6 直接做 MSW mock。
   同时是契约完备性的自检：走不出示例的 schema，说明它没定义清楚。

   受列权限管辖的端点会生成两份：
     full   —— 有权限（gated 字段出现）
     masked —— 无权限（gated 字段**消失**，不是 null）
   前端两份都要能渲染，这正是 P2 想让客户端提前适应的事。 */
import * as yaml from "js-yaml";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const doc = yaml.load(fs.readFileSync(path.join(ROOT, "openapi.yaml"), "utf8")) as any;
const S = doc.components.schemas as Record<string, any>;

/* 确定性伪随机：产物要能进 git 且逐次一致 */
let seed = 20260824;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const uuid = () => "0123456789abcdef".split("").length &&
  [8, 4, 4, 4, 12].map(n => Array.from({ length: n },
    () => "0123456789abcdef"[Math.floor(rnd() * 16)]).join("")).join("-");

const HOSP  = ["北京协和医院", "复旦大学附属中山医院", "天津医科大学肿瘤医院"];
const PERSON = ["吴桐", "林敏", "廖梦然", "韩雪"];
const LOGIN  = ["wutong", "linmin", "liaomeng", "hanxue"];
const DEPT   = ["肝胆外科", "肿瘤内科", "内分泌科", "心内科"];
const CITY   = ["北京", "上海", "天津", "广州"];
const STUDY  = ["艾瑞替尼 III", "HT-118 II", "恒糖宁 III", "CoroFlex 器械"];

/** 按**路径**取值而非只看叶子键名：`study.code` 与顶层 `code` 是两回事，
 *  `shortName` 更不是人名。前端拿到语义错乱的 mock 会被误导。 */
function strFor(path: string[], s: any): string {
  const k = path.at(-1) ?? "";
  const parent = path.at(-2) ?? "";
  const under = (seg: string) => path.slice(0, -1).includes(seg);

  if (/hospital|orgRef/i.test(k))                       return pick(HOSP);
  if (/^dept$/i.test(k))                                return pick(DEPT);
  if (/^city$/i.test(k))                                return pick(CITY);
  if (/login/i.test(k))                                 return pick(LOGIN);
  if (/^(piName|displayName|actorLogin|lead)$/i.test(k)) return pick(PERSON);
  if (/^shortName$/i.test(k))                           return pick(STUDY);
  if (/^sponsorName$/i.test(k))                         return "华拓生物";
  if (/^phase$/i.test(k))                               return "III期";
  if (/^indication$/i.test(k))                          return "肝细胞癌";
  if (/^code$/i.test(k)) {
    if (under("study") || parent === "study")           return "HJ-2024-017";
    if (under("role"))                                  return "crc";
    if (under("team"))                                  return "G-01";
    return "SS-" + String(Math.floor(rnd() * 15) + 1).padStart(2, "0");
  }
  if (/^name$/i.test(k)) {
    if (under("role"))                                  return "临床协调员 CRC";
    if (under("team"))                                  return "华东华南组";
    return pick(PERSON);
  }
  if (/^(action|targetType|module|scopeLabel)$/i.test(k)) return "示例标识";
  if (/summary|message|reason|detail|label|description|title/i.test(k))
    return "示例文本（由契约生成，非真实数据）";
  void s;
  return "示例";
}

function sample(s: any, path: string[], opts: { masked: boolean }, depth = 0): unknown {
  if (!s || depth > 8) return null;
  if (s.$ref) return sample(S[s.$ref.split("/").pop()!], path, opts, depth + 1);
  if (s.allOf) return sample(s.allOf[0], path, opts, depth + 1);
  if (s.enum) return s.enum[0];

  switch (s.type) {
    case "object": {
      const out: Record<string, unknown> = {};
      const req: string[] = s.required ?? [];
      for (const [k, v] of Object.entries<any>(s.properties ?? {})) {
        /* 无权限时 gated 字段整个消失 —— 这是契约，不是实现细节 */
        if (opts.masked && v["x-gated-by"]) continue;
        if (!req.includes(k) && !v["x-gated-by"] && rnd() < 0.15) continue;
        out[k] = sample(v, [...path, k], opts, depth + 1);
      }
      return out;
    }
    case "array":
      return Array.from({ length: 2 }, () => sample(s.items, path, opts, depth + 1));
    case "integer": {
      const k = path.at(-1) ?? "";
      if (/Cents$/.test(k))   return Math.floor(rnd() * 900 + 100) * 10000;
      if (/^status$/.test(k)) return 200;
      return Math.floor(rnd() * 40) + 1;
    }
    case "number":  return Math.round(rnd() * 100) / 100;
    case "boolean": return rnd() > 0.5;
    case "string": {
      if (s.nullable && rnd() < 0.25) return null;
      if (s.format === "uuid")      return uuid();
      if (s.format === "date")      return "2026-08-" + String(10 + Math.floor(rnd() * 18)).padStart(2, "0");
      if (s.format === "date-time") return "2026-08-22T09:15:00+08:00";
      return strFor(path, s);
    }
    default:
      return s.nullable ? null : "示例";
  }
}

const hasGated = (s: any, depth = 0): boolean => {
  if (!s || depth > 8) return false;
  if (s.$ref) return hasGated(S[s.$ref.split("/").pop()!], depth + 1);
  if (s.items) return hasGated(s.items, depth + 1);
  return Object.values<any>(s.properties ?? {})
    .some(v => v["x-gated-by"] || hasGated(v, depth + 1));
};

const out: Record<string, unknown> = {};
let n = 0, gatedOps = 0;
for (const [p, item] of Object.entries<any>(doc.paths))
  for (const [method, op] of Object.entries<any>(item)) {
    const ok = Object.entries<any>(op.responses).find(([s]) => s.startsWith("2"))!;
    const schema = ok[1].content?.["application/json"]?.schema;
    if (!schema) continue;
    seed = 20260824 + n * 7919;
    const entry: Record<string, unknown> = {
      method: method.toUpperCase(), path: p, status: Number(ok[0]),
      body: sample(schema, [], { masked: false })
    };
    if (hasGated(schema)) {
      seed = 20260824 + n * 7919;
      entry.bodyWithoutFieldPermission = sample(schema, [], { masked: true });
      gatedOps++;
    }
    out[op.operationId] = entry;
    n++;
  }

fs.mkdirSync(path.join(ROOT, "mocks"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "mocks/examples.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`mocks/examples.json 已生成：${n} 个端点，其中 ${gatedOps} 个含受列权限管辖的字段（各出两份）`);
