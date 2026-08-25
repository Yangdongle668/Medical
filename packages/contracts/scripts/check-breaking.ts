/* 破坏性变更门禁。
   基线 = 某个 git ref 里的 openapi.yaml；当前 = 工作区（由 npm run openapi 刚生成）。
   要故意破坏契约，必须显式加 --allow-breaking 并在评审里说明。

   ── 基线取哪一个 ref，是这个门禁成不成立的全部 ───────────────────
   本地默认 HEAD：比的是"工作区相对上一次提交"，正是本地想知道的。

   **但在 CI 上 HEAD 是错的，而且错得不响。**
   `actions/checkout` 在 pull_request 事件里检出的是**合并提交**，
   于是 `git show HEAD:openapi.yaml` 拿到的就是这个 PR 自己提议的那份；
   工作区里刚生成的也是同一份 —— 门禁在拿文件跟它自己比，
   **永远输出「契约无变化」**。它一直是绿的，因为它什么都没比。

   所以 CI 上必须显式传 --baseline-ref（PR 传 base.sha，push 传 HEAD^），
   而这里在 CI 环境下**拒绝**回退到 HEAD：
   一个不成立的门禁比没有门禁更糟 —— 没有门禁的时候人还知道要自己看。 */
import * as yaml from "js-yaml";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const REPO = path.resolve(ROOT, "../..");
const REL  = path.relative(REPO, path.join(ROOT, "openapi.yaml")).replace(/\\/g, "/");

type Schema = Record<string, unknown> & {
  properties?: Record<string, Schema>; required?: string[];
  enum?: unknown[]; type?: string; $ref?: string; "x-extensible"?: boolean;
};
type Param = { name: string; in: string; required?: boolean };
type Op = { operationId?: string; responses?: Record<string, unknown>;
            parameters?: Param[]; requestBody?: unknown };
type Doc = { paths: Record<string, Record<string, Op>>;
             components: { schemas: Record<string, Schema> } };

const METHODS = ["get", "post", "patch", "delete"] as const;
const breaking: string[] = [], warn: string[] = [], added: string[] = [];

/** 基线来源：--baseline 直接给文件（测试与本地对拍用），
 *  否则从 --baseline-ref 指定的 git ref 里取；本地缺省 HEAD。 */
const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const CI = !!process.env["CI"];

function baseline(): Doc | null {
  const f = arg("--baseline");
  if (f) return yaml.load(fs.readFileSync(f, "utf8")) as Doc;

  const ref = arg("--baseline-ref");
  if (!ref) {
    if (CI) die("CI 上必须显式指定 --baseline-ref。\n" +
      "  pull_request 事件检出的是合并提交，HEAD 里的 openapi.yaml\n" +
      "  就是本 PR 提议的那一份 —— 拿它当基线等于文件跟自己比，门禁永远是绿的。\n" +
      "  PR 传 base.sha，push 传 HEAD^。");
    return fromRef("HEAD");
  }
  return fromRef(ref);
}

function die(msg: string): never {
  console.error(`✗ 破坏性变更门禁无法建立基线：\n  ${msg}`);
  process.exit(2);
}

function fromRef(ref: string): Doc | null {
  let raw: string;
  try {
    raw = execSync(`git show ${ref}:${REL}`,
      { cwd: REPO, encoding: "utf8", stdio: "pipe" });
  } catch {
    /* 分两种：ref 本身取不到（浅克隆、写错），和 ref 里还没有这个文件。
       前者在 CI 上必须是硬错误 —— 原来这里一律 return null 然后 exit 0，
       于是**任何 git 失败都会让门禁悄悄放行**。 */
    const known = (() => {
      try {
        execSync(`git rev-parse --verify ${ref}^{commit}`,
          { cwd: REPO, stdio: "pipe" });
        return true;
      } catch { return false; }
    })();
    if (!known)
      die(`取不到 ref \`${ref}\`。\n` +
        "  浅克隆常见：CI 里请把 actions/checkout 的 fetch-depth 设为 0。");
    return null;                      // ref 在，但那时还没有 openapi.yaml
  }
  return yaml.load(raw) as Doc;
}

const B = baseline();
const C = yaml.load(fs.readFileSync(
  arg("--current") ?? path.join(ROOT, "openapi.yaml"), "utf8")) as Doc;
if (!B) { console.log("首次生成：基线 ref 中尚无 openapi.yaml，跳过比对。"); process.exit(0); }

const ops = (d: Doc) => {
  const m = new Map<string, { path: string; method: string; op: Op }>();
  for (const [p, item] of Object.entries(d.paths ?? {}))
    for (const method of METHODS) {
      const op = item[method];
      if (op) m.set(op.operationId ?? `${method} ${p}`, { path: p, method, op });
    }
  return m;
};
const bo = ops(B), co = ops(C);

for (const [id, v] of bo)
  if (!co.has(id)) breaking.push(`删除端点 ${v.method.toUpperCase()} ${v.path}（operationId: ${id}）`);
for (const [id, v] of co)
  if (!bo.has(id)) added.push(`新增端点 ${v.method.toUpperCase()} ${v.path}（${id}）`);

for (const [id, cur] of co) {
  const old = bo.get(id); if (!old) continue;
  if (old.path !== cur.path) breaking.push(`端点 ${id} 路径变更：${old.path} → ${cur.path}`);
  const ok = (o: Op) => Object.keys(o.responses ?? {}).filter(s => s.startsWith("2"));
  for (const s of ok(old.op))
    if (!ok(cur.op).includes(s)) breaking.push(`端点 ${id} 移除了成功响应 ${s}`);
  const req = (o: Op) =>
    new Set((o.parameters ?? []).filter(x => x.required).map(x => `${x.in}:${x.name}`));
  for (const k of req(cur.op))
    if (!req(old.op).has(k)) breaking.push(`端点 ${id} 新增必填参数 ${k}`);
  if (!old.op.requestBody && cur.op.requestBody) breaking.push(`端点 ${id} 新增了必填请求体`);
}

const bs = B.components?.schemas ?? {}, cs = C.components?.schemas ?? {};
for (const n of Object.keys(bs)) if (!(n in cs)) breaking.push(`删除 schema ${n}`);
for (const n of Object.keys(cs)) if (!(n in bs)) added.push(`新增 schema ${n}`);

/* ── schema 的用途分类 ────────────────────────────────────────────
   请求与响应的兼容性规则是**相反的**：
     响应加一个字段，客户端多收到一点，无害；
     请求加一个必填字段，所有旧客户端立刻失败。
   一视同仁会产生假阳性，而假阳性会让人养成随手 --allow-breaking 的习惯 ——
   那等于废掉门禁本身。所以先按用途分类。 */
type Role = "request" | "response" | "both";
function classify(d: Doc): Map<string, Role> {
  const req = new Set<string>(), res = new Set<string>();
  const walk = (node: unknown, into: Set<string>, seen = new Set<string>()) => {
    if (Array.isArray(node)) return node.forEach(n => walk(n, into, seen));
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    if (typeof o.$ref === "string") {
      const id = o.$ref.split("/").pop()!;
      if (seen.has(id)) return;
      seen.add(id); into.add(id);
      const s = d.components?.schemas?.[id];
      if (s) walk(s, into, seen);
      return;
    }
    for (const v of Object.values(o)) walk(v, into, seen);
  };
  for (const item of Object.values(d.paths ?? {}))
    for (const m of METHODS) {
      const op = item[m]; if (!op) continue;
      walk(op.requestBody, req);
      walk(op.responses, res);
    }
  const roles = new Map<string, Role>();
  for (const n of Object.keys(d.components?.schemas ?? {}))
    roles.set(n, req.has(n) && res.has(n) ? "both" : req.has(n) ? "request" : "response");
  return roles;
}
const ROLE = classify(C);

function cmp(name: string, o: Schema, c: Schema, at = "") {
  const where = `${name}${at}`;
  const role = ROLE.get(name) ?? "both";
  const isReq = role === "request" || role === "both";
  const isRes = role === "response" || role === "both";

  if (o.type && c.type && o.type !== c.type)
    breaking.push(`${where} 类型变更：${o.type} → ${c.type}`);
  if (o.$ref && c.$ref && o.$ref !== c.$ref)
    breaking.push(`${where} 引用变更：${o.$ref} → ${c.$ref}`);

  if (o.enum && c.enum) {
    const gone = o.enum.filter(v => !c.enum!.includes(v));
    const plus = c.enum.filter(v => !o.enum!.includes(v));
    /* 请求端少接受一个取值 = 旧客户端被拒；响应端少发一个取值只是收窄 */
    if (gone.length) {
      if (isReq) breaking.push(`${where} 枚举移除取值：${gone.join(", ")}（请求端不再接受）`);
      else warn.push(`${where} 枚举移除取值：${gone.join(", ")}（仅响应端收窄）`);
    }
    if (plus.length) {
      if (c["x-extensible"] || o["x-extensible"])
        added.push(`${where} 枚举新增取值（已声明可扩展）：${plus.join(", ")}`);
      else if (isRes)
        warn.push(`${where} 枚举新增取值：${plus.join(", ")} —— 穷举分支的客户端会漏掉它们`);
      else added.push(`${where} 枚举新增取值：${plus.join(", ")}`);
    }
  }

  const op = o.properties ?? {}, cp = c.properties ?? {};
  for (const k of Object.keys(op)) {
    const cv = cp[k];
    /* additionalProperties:false 之下，请求端删字段也会让仍在发送它的旧客户端被拒 */
    if (!cv) { breaking.push(`${where} 删除字段 ${k}`); continue; }
    cmp(name, op[k]!, cv, `${at}.${k}`);
  }
  for (const k of Object.keys(cp)) if (!(k in op)) {
    if (isReq && (c.required ?? []).includes(k))
      breaking.push(`${where} 新增必填字段 ${k}（请求端：旧客户端不会发送它）`);
    else added.push(`${where} 新增${(c.required ?? []).includes(k) ? "" : "可选"}字段 ${k}`);
  }
  const oreq = new Set(o.required ?? []), creq = new Set(c.required ?? []);
  for (const k of creq) if (!oreq.has(k) && k in op && isReq)
    breaking.push(`${where} 字段 ${k} 由可选变为必填（请求端）`);
  /* 响应端字段由必填变可选 = 客户端原本可以假定它存在，现在不能了 */
  for (const k of oreq) if (!creq.has(k) && k in cp && isRes)
    breaking.push(`${where} 字段 ${k} 由必填变为可选（响应端：客户端原本可假定它存在）`);
}
for (const n of Object.keys(cs)) { const b = bs[n], c = cs[n]; if (b && c) cmp(n, b, c); }

const allow = process.argv.includes("--allow-breaking");
const list = (t: string, xs: string[]) =>
  xs.length ? `\n${t}（${xs.length}）\n` + xs.map(x => `  · ${x}`).join("\n") : "";
console.log((list("破坏性变更", breaking) + list("需要留意", warn) + list("新增（兼容）", added))
  || "契约无变化。");

if (breaking.length && !allow) {
  console.error(
    `\n✗ 存在 ${breaking.length} 项破坏性变更。\n` +
    `  破坏性变更不是不能做，是不能悄悄做：\n` +
    `  · 优先开 /v2 并让 /v1 并行至少 6 个月；\n` +
    `  · 确需就地破坏时加 --allow-breaking，并在评审里说明影响范围与迁移方案。`);
  process.exit(1);
}
if (breaking.length) console.warn(`\n⚠ 已用 --allow-breaking 放行 ${breaking.length} 项破坏性变更。`);
