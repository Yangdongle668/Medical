/* 依赖图断言 —— 架构约束不能只写在文档里。
   packages/calc 与 packages/policy 一旦 import 了 IO，
   就再也不能被前端复用、也不能被穷举测试，而这正是它们存在的理由。 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const violations = [];

const RULES = [
  {
    scope: "packages/policy",
    forbid: [/^node:/, /^pg$/, /^fs$/, /^express$/, /^@nestjs\//, /^\.\.\/\.\.\/apps\//],
    why: "纯函数包不得依赖 IO —— 否则前后端无法共用同一份实现"
  },
  {
    scope: "packages/contracts",
    forbid: [/^pg$/, /^@nestjs\//, /^\.\.\/\.\.\/apps\//],
    why: "契约是所有人的上游，不能反过来依赖实现"
  },
  {
    scope: "apps/api/src/modules/identity",
    forbid: [/modules\/site\//],
    why: "限界上下文之间只能通过领域事件或明确的只读接口交互，不得直接引用对方实体"
  },
  {
    scope: "apps/api/src/modules/site",
    forbid: [/modules\/identity\//],
    why: "同上"
  },
  {
    scope: "apps/api/src/modules/clinical",
    forbid: [/modules\/identity\//, /modules\/site\/site\./, /modules\/site\/staffing\./],
    why: "ClinicalOps 不直接引用别的上下文的服务；跨界只走领域事件或只读查询"
  }
];

const walk = dir => fs.existsSync(dir)
  ? fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === "node_modules" || e.name === "test" ? [] : walk(p);
      return /\.(ts|mjs|js)$/.test(e.name) ? [p] : [];
    })
  : [];

for (const rule of RULES) {
  for (const file of walk(path.join(ROOT, rule.scope))) {
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/^\s*import\s[^"']*["']([^"']+)["']/gm)) {
      const spec = m[1];
      for (const bad of rule.forbid)
        if (bad.test(spec))
          violations.push(
            `${path.relative(ROOT, file)}\n    import "${spec}"\n    ${rule.why}`);
    }
  }
}

/* ── 端点与契约必须一一对应 ─────────────────────────────────────────
   守卫按 operationId 去契约里查所需动作权限。因此：
     · 控制器上有 @Operation 而契约里没有这个 id → **该端点没有任何权限声明**，
       且不会有任何提示 —— 它就是敞开的；
     · 契约里有端点而没人实现 → 前端照着 mock 写完，联调时才发现是空的。
   两种都不是风格问题，是能上线的漏洞。 */
const spec = fs.readFileSync(path.join(ROOT, "packages/contracts/openapi.yaml"), "utf8");
const declared = new Set([...spec.matchAll(/^\s+operationId:\s*(\S+)/gm)].map(m => m[1]));

const implemented = new Map();
for (const file of walk(path.join(ROOT, "apps/api/src"))) {
  const src = fs.readFileSync(file, "utf8");
  for (const m of src.matchAll(/@Operation\(["']([^"']+)["']\)/g))
    implemented.set(m[1], path.relative(ROOT, file));
}

/* 唯一的例外，且必须逐个写明理由。
   devSession 只在 SITEDESK_DEV_LOGIN=1 时挂载，生产环境返回 404 ——
   把一个后门写进公开契约，等于告诉别人有这么个后门。
   它没有动作权限声明是**刻意的**，因为它本身就不该存在于生产。 */
const OFF_CONTRACT = new Set(["devSession"]);

for (const [id, file] of implemented)
  if (!declared.has(id) && !OFF_CONTRACT.has(id))
    violations.push(`${file}\n    @Operation("${id}") 在契约里没有对应端点\n` +
      `    守卫按 operationId 查动作权限 —— 契约里没有它，就等于没有任何权限声明`);

/* dev-session 刻意不进公开契约（只在 SITEDESK_DEV_LOGIN=1 时存在），
   planned 的端点是契约先行、实现在后。两者都不算违规。 */
const PLANNED = new Set([...spec.matchAll(/^\s+x-planned:\s*true[\s\S]{0,400}?operationId:\s*(\S+)/gm)]
  .map(m => m[1]));
for (const id of declared)
  if (!implemented.has(id) && !PLANNED.has(id))
    violations.push(`packages/contracts/openapi.yaml\n    端点 ${id} 已进契约但无人实现\n` +
      `    前端会照着它写 mock，联调时才发现是空的`);

if (violations.length) {
  console.error(`✗ 依赖图违规 ${violations.length} 处：\n\n` +
    violations.map(v => "  " + v).join("\n\n"));
  process.exit(1);
}
console.log(`✓ 依赖图断言通过（${RULES.length} 条规则）` +
  `｜端点与契约一一对应（${declared.size} 个）`);
