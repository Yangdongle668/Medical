/* 由 zod 契约生成 openapi.yaml。
   openapi.yaml 是**产物**，进 git 只为可评审与可比对破坏性变更；
   任何时候都以 src/ 下的 zod 定义为准。 */
import { z } from "zod";
import * as yaml from "js-yaml";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { allEndpoints, COMMON_ERRORS, type Endpoint } from "../src/kernel/registry.js";
import { Problem, ERRORS, ERROR_BASE, type ErrorCode } from "../src/kernel/errors.js";
import "../src/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reg = z.registry<{ id: string }>();
const named = new Map<z.ZodType, string>();

/** 已有 meta id 的复用它；否则按端点生成一个稳定 id */
function ref(schema: z.ZodType, fallbackId: string): string {
  const existing = named.get(schema);
  if (existing) return existing;
  const metaId = (z.globalRegistry.get(schema) as { id?: string } | undefined)?.id;
  const id = metaId ?? fallbackId;
  named.set(schema, id);
  reg.add(schema, { id });
  return id;
}

/* 先把所有具名模型登记进来，保证它们成为 $ref 而不是被内联。
   globalRegistry._idmap 是 id → schema 的映射（.meta({id}) 写入）。 */
const idmap = (z.globalRegistry as unknown as { _idmap?: Map<string, z.ZodType> })._idmap;
for (const [id, schema] of idmap ?? new Map<string, z.ZodType>()) ref(schema, id);
ref(Problem, "Problem");

const eps = [...allEndpoints()].sort((a, b) =>
  a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path));

/* 登记端点上的匿名 schema */
const bodyId  = (e: Endpoint) => ref(e.body!,     `${cap(e.id)}Request`);
const respId  = (e: Endpoint) => e.response ? ref(e.response, `${cap(e.id)}Response`) : null;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
for (const e of eps) { if (e.body) bodyId(e); respId(e); }

/* 一次性导出全部 schema —— 交叉引用由 zod 自动变成 $ref */
const exported = z.toJSONSchema(reg, {
  target: "openapi-3.0", io: "output",
  uri: (id: string) => `#/components/schemas/${id}`
}) as { schemas: Record<string, Record<string, unknown>> };
const schemas = Object.fromEntries(
  Object.entries(exported.schemas).map(([k, v]) => {
    const { $id, $schema, ...rest } = v;                 // $id 在 components 里是噪声
    void $id; void $schema;
    return [k, rest];
  }));

/** query / path 参数：逐属性展开为 OpenAPI parameter */
function params(schema: z.ZodType | undefined, where: "query" | "path") {
  if (!schema) return [];
  const js = z.toJSONSchema(schema, { target: "openapi-3.0", io: "input" }) as {
    properties?: Record<string, Record<string, unknown>>; required?: string[];
  };
  return Object.entries(js.properties ?? {}).map(([name, s]) => {
    const { description, ...rest } = s;
    return {
      name, in: where,
      required: where === "path" ? true : (js.required ?? []).includes(name),
      ...(description ? { description } : {}),
      schema: rest
    };
  });
}

const problemResponse = (code: ErrorCode) => ({
  description: ERRORS[code].title,
  content: { "application/problem+json": {
    schema: { $ref: "#/components/schemas/Problem" },
    example: { type: ERROR_BASE + code, title: ERRORS[code].title,
               status: ERRORS[code].status, code }
  } }
});

const paths: Record<string, Record<string, unknown>> = {};
for (const e of eps) {
  /* OpenAPI 的路径模板不允许裸冒号做动作分隔，转义为 %3A 保持可路由 */
  const p = e.path.replace(/\{id\}:(\w+)/, "{id}:$1");
  paths[p] ??= {};
  const errs = [...new Set([...COMMON_ERRORS, ...(e.errors ?? [])])]
    .sort((a, b) => ERRORS[a].status - ERRORS[b].status);
  const byStatus: Record<string, unknown> = {};
  for (const c of errs) byStatus[String(ERRORS[c].status)] ??= problemResponse(c);

  paths[p][e.method] = {
    operationId: e.id,
    tags: [e.context],
    summary: e.summary,
    ...(e.description ? { description: e.description } : {}),
    ...(e.planned ? { "x-planned": true } : {}),
    "x-layer": e.layer,
    ...(e.action ? { "x-required-action": e.action } : {}),
    parameters: [
      ...params(e.params, "path"),
      ...params(e.query, "query"),
      /* L2 命令**必须**带幂等键；L1 的写入可以带。
         为什么 L1 也要能带：断网时人做的活要能排进发件箱，
         而重放意味着同一个请求可能发两次 —— 没有幂等键的话，
         那就是实实在在的两笔。带上它，重放才是安全的。
         保持可选，是因为它不该成为一次破坏性变更（旧客户端不带也照发）。 */
      ...(e.layer === "L2" ? [{
        name: "Idempotency-Key", in: "header", required: true,
        description: "幂等键（uuid）。24 小时内重放同一键返回首次结果。",
        schema: { type: "string", format: "uuid" }
      }] : e.method !== "get" && e.context !== "auth" ? [{
        name: "Idempotency-Key", in: "header", required: false,
        description: "幂等键（uuid）。可选；带上之后 24 小时内重放同一键返回首次结果，"
          + "离线重放因此不会写两笔。",
        schema: { type: "string", format: "uuid" }
      }] : [])
    ],
    ...(e.body ? { requestBody: { required: true, content: {
      "application/json": { schema: { $ref: `#/components/schemas/${named.get(e.body)}` } } } } } : {}),
    responses: {
      [String(e.status ?? 200)]: e.response
        ? { description: e.summary,
            content: { "application/json": {
              schema: { $ref: `#/components/schemas/${named.get(e.response)}` } } } }
        : { description: e.summary },
      ...byStatus
    }
  };
}

const doc = {
  openapi: "3.0.3",
  info: {
    title: "临床中心台 SiteDesk API",
    version: "0.2.0",
    description:
      "**本文件是产物。** 契约的唯一定义源是 `packages/contracts/src` 下的 zod schema。\n\n" +
      "分层：L1 资源层（CRUD 与列表）· L2 命令层（领域动作，返回 sideEffects）· " +
      "L3 投影层（只读聚合，永不返回明细）。\n\n" +
      "带 `x-gated-by` 的字段受列维度权限管辖：**无权限时该字段从响应中消失，不是返回 null**。\n\n" +
      "行范围之外的资源一律返回 404 而非 403 —— 403 等于确认「它存在，只是你不能碰」，" +
      "这个确认本身就是泄漏。"
  },
  servers: [{ url: "https://api.sitedesk.example", description: "生产" }],
  tags: [
    { name: "auth", description: "认证：内部 OIDC / 外部一次性链接" },
    { name: "identity", description: "身份与权限：行 × 列 × 动作" },
    { name: "site", description: "项目与中心：StudySite 是最小作业单元" }
  ],
  paths,
  components: {
    schemas,
    securitySchemes: {
      oidc: { type: "openIdConnect",
        openIdConnectUrl: "https://sso.example/.well-known/openid-configuration",
        description: "内部员工：企业微信 / 飞书 OIDC" },
      magicLink: { type: "http", scheme: "bearer",
        description: "外部方（机构办 / 研究者）：一次性魔法链接换取的短期会话令牌" }
    }
  },
  security: [{ oidc: [] }, { magicLink: [] }]
};

/* ── 归一化与自检 ───────────────────────────────────────────────
   独立转换 query / path 参数时，zod 会把具名子 schema 提升到 #/definitions/。
   那些 id 已经在 components.schemas 里，重写指向即可；
   随后逐个校验引用目标真实存在 —— 这道自检本该先于第一次生成就有。 */
function normalize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalize);
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (typeof o.$ref === "string" && o.$ref.startsWith("#/definitions/"))
      o.$ref = o.$ref.replace("#/definitions/", "#/components/schemas/");
    delete o.definitions;
    delete o.$defs;
    for (const k of Object.keys(o)) o[k] = normalize(o[k]);
  }
  return node;
}
normalize(doc);

const dangling: string[] = [];
(function check(node: unknown, at: string) {
  if (Array.isArray(node)) return node.forEach((n, i) => check(n, `${at}[${i}]`));
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (typeof o.$ref === "string") {
      const id = o.$ref.replace("#/components/schemas/", "");
      if (!(id in schemas)) dangling.push(`${at} → ${o.$ref}`);
    }
    for (const [k, v] of Object.entries(o)) check(v, `${at}.${k}`);
  }
})(doc, "$");
if (dangling.length) {
  console.error("✗ 存在悬空引用：\n" + dangling.map(d => "  " + d).join("\n"));
  process.exit(1);
}

const out = path.join(ROOT, "openapi.yaml");
fs.writeFileSync(out, yaml.dump(doc, { lineWidth: 110, noRefs: true, sortKeys: false }));
const l2 = eps.filter(e => e.layer === "L2").length;
console.log(`openapi.yaml 已生成：${eps.length} 个端点（L2 命令 ${l2} 个）· ` +
  `${Object.keys(schemas).length} 个 schema · ${Object.keys(paths).length} 条路径`);
