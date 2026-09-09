/* 依赖图断言 —— 架构约束不能只写在文档里。
   packages/calc 与 packages/policy 一旦 import 了 IO，
   就再也不能被前端复用、也不能被穷举测试，而这正是它们存在的理由。 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

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
    forbid: [/modules\/identity\//, /modules\/site\/site\./, /modules\/site\/staffing\./,
             /modules\/cost\//],
    why: "ClinicalOps 不直接引用别的上下文的服务 —— 记工时走 ports.ts 里的接口，" +
         "装配在 app.module 完成。直接 import 是最省事的写法，也是最贵的"
  },
  {
    scope: "apps/api/src/modules/cost",
    forbid: [/modules\/identity\//, /modules\/clinical\//, /modules\/site\//],
    why: "同上，方向反过来也一样"
  },
  {
    scope: "apps/api/src/modules/bizdev",
    forbid: [/modules\/identity\//, /modules\/clinical\//, /modules\/site\//,
             /modules\/cost\//],
    why: "商务上下文（可行性 · 投标 · 变更）同样不直接引用别的上下文的服务。" +
         "它要项目与中心的信息时走 SQL 读同一个库，而不是 import 对方的 Service —— " +
         "后者是最省事的写法，也是最贵的"
  },
  {
    scope: "apps/api/src/modules/oversight",
    forbid: [/modules\/identity\//, /modules\/clinical\//, /modules\/site\//,
             /modules\/cost\//, /modules\/bizdev\//, /modules\/finance\//],
    why: "监查与稽查读别的上下文的**表**（质量事件、中心），但不引用它们的服务 —— " +
         "省事的那条路会让「监查怎么算风险」的答案散在两个上下文里"
  },
  {
    scope: "apps/api/src/modules/finance",
    forbid: [/modules\/identity\//, /modules\/clinical\//, /modules\/site\//,
             /modules\/cost\//, /modules\/bizdev\//],
    why: "钱那一层（里程碑 · 客户 · 现金流）同样不 import 别的上下文的服务。" +
         "它要项目、中心、人员的数就读同一个库 —— 那是有意的：" +
         "跨上下文的耦合一旦从 SQL 变成 import，就再也拆不开了"
  },
  {
    scope: "packages/calc",
    forbid: [/^node:/, /^pg$/, /^fs$/, /^express$/, /^@nestjs\//, /^\.\.\/\.\.\/apps\//],
    why: "计算引擎必须是纯函数 —— 前后端共用同一份口径，且能被穷举测试"
  },
  {
    scope: "apps/web/src",
    /* 注意别把前端自己的 src/api（契约 client）也禁掉了：
       从 features/ 看过去它就是 "../../api/client.js"。
       要禁的是 apps/api 那个后端，所以按包名与 apps/api 路径来判。 */
    forbid: [/^pg$/, /^@nestjs\//, /@sitedesk\/api/, /apps\/api\//],
    why: "前端不得依赖后端实现 —— 它只认契约（@sitedesk/contracts）。" +
         "一旦引用了后端的类型或工具，前后端就没法再各自独立部署"
  },
  {
    scope: "apps/web/src/features",
    forbid: [/\/mocks\//],
    why: "业务代码不得 import mock —— mock 只在入口按构建期开关加载。" +
         "特性代码里一旦引用，msw 就会跟着上生产，而没有任何警告"
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

/* ── mock 身份的动作权限必须与库里的授予一致 ────────────────────────
   这条是被咬出来的：迁移 0039 给 crc / cra 加了 `isfWrite`、
   给 inst 加了 `accept`，而 `apps/web/src/mocks/roles.ts` 没跟上。
   症状**不是报错**：`me.permissions.actions.includes("isfWrite")` 返回 false，
   于是那一页在 mock 模式下**少了「核对」按钮** ——
   页面照常渲染，接口照常返回，只是按钮不见了。
   我是靠 e2e 干等 30 秒一个不存在的按钮才发现的。

   真相在库里（provision_tenant_roles 的 catalogue）。这里逐角色比对。 */
const provisionFiles = fs.readdirSync(path.join(ROOT, "db/migrations"))
  .filter(f => fs.readFileSync(path.join(ROOT, "db/migrations", f), "utf8")
    .includes("CREATE OR REPLACE FUNCTION app.provision_tenant_roles")).sort();
const latestProvision = provisionFiles.at(-1);
if (!latestProvision)
  violations.push("db/migrations\n    找不到 provision_tenant_roles —— 角色授予的真相没了");
else {
  const sql = fs.readFileSync(path.join(ROOT, "db/migrations", latestProvision), "utf8");
  /* 按行首的 `    ('code',` 切开 —— 一行里夹着注释、跨着好几行，
     用一条大正则去啃它比切开脆得多（第一版就是那么写的，一条都没匹配上，
     而它照样是绿的 —— 一个红不起来的门禁比没有门禁更糟）。 */
  const rows = sql.split(/\n    \('/).slice(1);
  const granted = new Map();
  for (const row of rows) {
    const code = row.match(/^(\w+)'/)?.[1];
    /* 三个 ARRAY 依次是 fields / actions / modules —— 取第二个。 */
    const arrays = [...row.matchAll(/ARRAY\[([\s\S]*?)\]::text\[\]/g)];
    if (!code || arrays.length < 3) continue;
    granted.set(code, [...arrays[1][1].matchAll(/'([^']+)'/g)].map(x => x[1]).sort());
  }
  if (granted.size < 8)
    violations.push(`db/migrations/${latestProvision}\n` +
      `    只解析出 ${granted.size} 个角色的授予 —— catalogue 的写法变了，这条规则已经形同虚设`);

  const rolesSrc = fs.readFileSync(
    path.join(ROOT, "apps/web/src/mocks/roles.ts"), "utf8");
  const identities = rolesSrc.slice(rolesSrc.indexOf("export const IDENTITIES"));
  let checked = 0;
  for (const m of identities.matchAll(/\n  (\w+): \{[\s\S]*?actions: \[([\s\S]*?)\]/g)) {
    const role = m[1];
    const want = granted.get(role);
    if (!want) continue;
    checked++;
    const got = [...m[2].matchAll(/"([^"]+)"/g)].map(x => x[1]).sort();
    const missing = want.filter(a => !got.includes(a));
    const extra = got.filter(a => !want.includes(a));
    if (missing.length || extra.length)
      violations.push(`apps/web/src/mocks/roles.ts\n` +
        `    身份 ${role} 的动作权限与 db/migrations/${latestProvision} 里的授予不一致\n` +
        (missing.length ? `    少了：${missing.join("、")}\n` : "") +
        (extra.length ? `    多了：${extra.join("、")}\n` : "") +
        `    症状不会报错 —— 只是 mock 模式下那一页少了几个按钮`);
  }
  /* 一条比对不到任何身份的规则，会一直绿着。 */
  if (checked !== 9)
    violations.push(`apps/web/src/mocks/roles.ts\n` +
      `    只比对到 ${checked} 个身份（应为 9）—— IDENTITIES 的写法变了，这条规则已经失效`);
}

/* ── 控制器不得自己重声明请求体 ──────────────────────────────────────
   这是 guards.ts 里那条规矩的另一半。动作权限那一维早就立好了：
   「两处各写一份的后果不是不一致告警，而是**静默失守**。」
   请求体这一维一直没有，于是 14 个控制器里长出了 86 处 z.object。

   已经付过一次代价：契约里 createAccount 的登录名写着

       .regex(/^[a-z][a-z0-9_]{2,31}$/, "3–32 位小写字母 / 数字 / 下划线…")

   控制器抄的那份漏了第二个参数。**校验逻辑一模一样**，两边拒同样的输入，
   差的只是那句话 —— 于是把登录名填成「周敏」的管理员收到的是一串正则，
   而那几乎必然被读成"这功能坏了"。任何比对"是否拒绝"的测试都照样绿。

   下面这张表只许变短。清空一个控制器，就把它那一行删掉。 */
const SCHEMA_DEBT = {
  "bizdev.controller.ts": 10, "intake.controller.ts": 3,
  "accountability.controller.ts": 6, "clinical.controller.ts": 18,
  "query.controller.ts": 4, "cost.controller.ts": 5,
  "finance.controller.ts": 6, "audit.controller.ts": 5,
  "monitor.controller.ts": 5, "acceptance.controller.ts": 4,
  "site.controller.ts": 5, "staffing.controller.ts": 5,
  /* auth 的三个是**登录流程自己的**输入（口令、令牌、投递地址），
     不对应任何业务契约端点的 body —— 留着，且不计入待还清单。 */
  "auth.controller.ts": 3
};
for (const file of walk(path.join(ROOT, "apps/api/src"))) {
  if (!file.endsWith(".controller.ts")) continue;
  const base = path.basename(file);
  const src = fs.readFileSync(file, "utf8");
  const n = [...src.matchAll(/^const [A-Za-z]+ = (?:z\.object\(|PageQuery\.extend\()/gm)].length;
  const owed = SCHEMA_DEBT[base] ?? 0;
  if (n > owed)
    violations.push(`${path.relative(ROOT, file)}\n` +
      `    自己声明了 ${n} 处请求 schema，而待还清单上记的是 ${owed}\n` +
      `    请求体的定义源是契约：在 contracts 的 model.ts 里命名并导出，两边 import 同一个`);
  if (n < owed)
    violations.push(`tools/arch-check.mjs\n` +
      `    ${base} 只剩 ${n} 处 schema，待还清单上还记着 ${owed} —— 把那一行改小或删掉\n` +
      `    留着一个还不清的数，下一个人会以为这活还没干`);
}

/* ── 敏感动作清单里的每个名字都得是真的 operationId ──────────────────
   `SENSITIVE_ACTIONS` 是一张手抄的 operationId 表，而 `needsReason()`
   拿 operationId 去里面查 —— **查不到就返回 false，不报错**。

   八条里曾经有三条对不上任何端点：`changeAccountRole`（真名 updateAccount）、
   `overrideFeasibility`（真名 decideFeasibility，且它是条件敏感）、
   `updateVisitTargetDate`（这个端点从来没建过）。
   于是「谁把谁调成了什么角色」写进了轨迹却没标成敏感，
   而审计页默认只看敏感那一档 —— 核查员打开的第一屏里没有它。

   仓库对每一张同类名单都有守卫（ACTION_KEYS、FIELD_KEYS、模块表、
   mock 身份、schema 待还清单），唯独这张没有。补上。 */
{
  const src = fs.readFileSync(
    path.join(ROOT, "packages/policy/src/action.ts"), "utf8");
  const block = src.match(/SENSITIVE_ACTIONS\s*=\s*new Set<string>\(\[([\s\S]*?)\]\)/);
  if (!block)
    violations.push("tools/arch-check.mjs\n    没解析出 SENSITIVE_ACTIONS —— 它的写法变了，这条规则已经形同虚设");
  else {
    /* 先剥注释再取引号里的词 —— 注释里本来就会出现引号
       （"标成敏感"、"改了吗"），把它们当成 operationId 会得到一串假阳性，
       而假阳性多了之后真的那条就没人看了。 */
    const names = [...block[1]
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "")
      .matchAll(/"([^"]+)"/g)].map(m => m[1]);
    if (names.length === 0)
      violations.push("packages/policy/src/action.ts\n    SENSITIVE_ACTIONS 是空的？");
    for (const n of names)
      if (!declared.has(n))
        violations.push(`packages/policy/src/action.ts\n` +
          `    SENSITIVE_ACTIONS 里的 "${n}" 不是任何一个 operationId\n` +
          `    needsReason() 查不到它只会返回 false —— 那条动作会静默地不算敏感`);
  }
}

/* ── 部署脚本：变量名必须是 ASCII，而且 --help 得真的能跑 ─────────────
   `deploy/update.sh` 从写出来那天起**一次都没跑通过**：

       ./deploy/update.sh: line 33: 现标签=local: command not found

   bash 允许中文**函数名**（`读取` / `设置` / `死` 一直好好的），
   但不允许中文**变量名** —— `现标签=local` 不是一条赋值，
   整个词被当成命令名去找。那是脚本的第 33 行，也就是说
   `--rollback` 在内的每一条路径都走不过第三步。

   **没有任何东西会发现这件事**：仓库里 580+ 条 api 测试、304 条 e2e、
   164 条库测试，没有一条会去执行一个 .sh。`bash -n` 也查不出来 ——
   `现标签=local` 在语法上是合法的（它是一条命令）。

   所以这里做两件事：静态扫非 ASCII 变量名，以及**真的把 --help 跑一遍**
   （那条路不碰 docker，CI 上跑得起）。 */
{
  const deployDir = path.join(ROOT, "deploy");
  const scripts = fs.existsSync(deployDir)
    ? fs.readdirSync(deployDir).filter(f => f.endsWith(".sh")).sort() : [];
  if (scripts.length === 0)
    violations.push("tools/arch-check.mjs\n    deploy/ 下一个 .sh 都没扫到 —— 这条规则已经形同虚设");

  /* 查的是**取值**（`$名` / `${名}`）和 `for 名 in`，不查赋值。
     赋值那一侧没法只靠正则分清 —— `死 "口令=错的"` 里也有个等号，
     而剥 shell 的引号比这条规则本身还容易出错。
     取值这一侧则是精确的：判据是 `$` 或 `${` **紧跟着**一个非 ASCII 字符。
     `$code，应为 401` 里 `$` 后面是 `c`，不算；`$现标签` 才算。

     漏不掉：赋了值总要取，不取的话那条赋值本来也没用。
     update.sh 那四个（现标签 / 上一个 / 镜像 / 新标签）全都被取过，
     `${现标签:-local}` 就在出事的那一行上。 */
  const BAD = [
    [/\$\{?[^\x00-\x7F]\S*/g, "取值"],
    [/\bfor\s+[^\x00-\x7F]\S*\s+in\b/g, "for 循环变量"]
  ];
  for (const f of scripts) {
    const src = fs.readFileSync(path.join(deployDir, f), "utf8")
      /* 注释里正是在讲这个坑，别把讲解本身当成犯规。 */
      .split("\n").filter(l => !/^\s*#/.test(l)).join("\n");
    for (const [re, what] of BAD)
      for (const m of src.matchAll(re))
        violations.push(`deploy/${f}\n` +
          `    ${what}用了非 ASCII 变量名：\`${m[0]}\`\n` +
          `    bash 只认 [A-Za-z_][A-Za-z0-9_]* 作变量名：这一行会变成 "command not found"\n` +
          `    （函数名可以是中文，变量名不行）`);
  }

  /* --help 要退出 0，而且**不许把代码打出来**。
     原来每个脚本各写一句 `sed -n '2,20p' "$0"`，行号照着当时的文件头数的；
     文件头一改就开始连 `source …` 和 `while [ $# -gt 0 ]; do` 一起打。 */
  for (const f of scripts) {
    const p = path.join(deployDir, f);
    /* 只查自己声明了 --help 的那些。login-link / login-address 收的是
       位置参数，没有这一条路；lib.sh 是被 source 的，根本不单独跑。 */
    if (!/--help\)/.test(fs.readFileSync(p, "utf8"))) continue;
    const r = spawnSync("bash", [p, "--help"], { encoding: "utf8", timeout: 20_000 });
    if (r.status !== 0)
      violations.push(`deploy/${f}\n` +
        `    --help 退出码 ${r.status}${r.signal ? `（信号 ${r.signal}）` : ""}\n` +
        `    ${(r.stderr || r.stdout || "").trim().split("\n").slice(0, 3).join("\n    ")}`);
    else if (/^\s*(source|while|for|if|PULL=|DEMO=)/m.test(r.stdout))
      violations.push(`deploy/${f}\n` +
        `    --help 把脚本正文也打出来了 —— 用法那一段的范围取过头了`);
  }
}

if (violations.length) {
  console.error(`✗ 依赖图违规 ${violations.length} 处：\n\n` +
    violations.map(v => "  " + v).join("\n\n"));
  process.exit(1);
}
console.log(`✓ 依赖图断言通过（${RULES.length} 条规则）` +
  `｜端点与契约一一对应（${declared.size} 个）`);
