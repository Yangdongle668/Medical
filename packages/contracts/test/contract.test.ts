import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as yaml from "js-yaml";
import { allEndpoints, COMMON_ERRORS } from "../src/kernel/registry.js";
import { ERRORS } from "../src/kernel/errors.js";
import { QueryBool } from "../src/kernel/primitives.js";
import "../src/index.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const SPEC = path.join(ROOT, "openapi.yaml");
const doc = yaml.load(fs.readFileSync(SPEC, "utf8")) as any;

describe("契约约定（不是风格偏好，每条对应一次事故）", () => {
  it("L2 命令一律 POST，且路径形如 /v1/xxx/{id}:action", () => {
    /* 动作名收紧为小写 kebab —— 原来的 \w+ 会放过 :Foo_BAR，
       而路径其余部分全是小写。多词动作用连字符（:sign-icf），不用驼峰。 */
    for (const e of allEndpoints().filter(e => e.layer === "L2")) {
      expect(e.method, e.id).toBe("post");
      expect(e.path, e.id).toMatch(/:[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
    }
  });

  it("L2 命令的响应必须带 sideEffects —— 它是契约的一部分，不是调试信息", () => {
    for (const e of allEndpoints().filter(e => e.layer === "L2")) {
      const op = doc.paths[e.path][e.method];
      const ref = op.responses["200"].content["application/json"].schema.$ref;
      const s = doc.components.schemas[ref.split("/").pop()];
      expect(Object.keys(s.properties), e.id).toContain("sideEffects");
    }
  });

  it("L2 命令必须要求 Idempotency-Key —— CRC 离线重放的生命线", () => {
    for (const e of allEndpoints().filter(e => e.layer === "L2")) {
      const op = doc.paths[e.path][e.method];
      const hs = (op.parameters ?? []).filter((p: any) => p.in === "header").map((p: any) => p.name);
      expect(hs, e.id).toContain("Idempotency-Key");
    }
  });

  it("每个端点都声明 401/403/404 —— 范围外返回 404 而非 403", () => {
    for (const [p, item] of Object.entries<any>(doc.paths))
      for (const [m, op] of Object.entries<any>(item)) {
        const codes = Object.keys(op.responses);
        for (const s of ["401", "403", "404"])
          expect(codes, `${m.toUpperCase()} ${p}`).toContain(s);
      }
  });

  it("所有错误响应都是 application/problem+json（RFC 9457）", () => {
    for (const item of Object.values<any>(doc.paths))
      for (const op of Object.values<any>(item))
        for (const [status, r] of Object.entries<any>(op.responses))
          if (!status.startsWith("2"))
            expect(Object.keys(r.content)).toEqual(["application/problem+json"]);
  });

  it("受列权限管辖的字段一律 optional —— 无权限时消失，不是 null", () => {
    const gated: string[] = [];
    for (const [name, s] of Object.entries<any>(doc.components.schemas))
      for (const [k, p] of Object.entries<any>(s.properties ?? {}))
        if (p["x-gated-by"]) {
          gated.push(`${name}.${k}`);
          expect(s.required ?? [], `${name}.${k}`).not.toContain(k);
          expect(p.nullable, `${name}.${k} 不应可空`).not.toBe(true);
        }
    expect(gated.length, "应存在受列权限管辖的字段").toBeGreaterThan(0);
  });

  it("operationId 全局唯一且稳定（前端方法名由它决定）", () => {
    const ids = allEndpoints().map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("fieldGates() 与 openapi 的 x-gated-by 完全一致 —— 脱敏只有一个来源", async () => {
    const { fieldGates } = await import("../src/kernel/gates.js");
    const fromCode = fieldGates();
    const fromSpec: Record<string, string> = {};
    for (const s of Object.values<any>(doc.components.schemas))
      for (const [k, p] of Object.entries<any>(s.properties ?? {}))
        if (p["x-gated-by"]) fromSpec[k] = p["x-gated-by"];
    expect(fromCode).toEqual(fromSpec);
    expect(Object.keys(fromCode).length).toBeGreaterThan(0);
  });

  it("**受管辖的键名不能和别处的普通字段重名** —— 重名会连带被删", async () => {
    /* `maskFields` 按叶子键名递归删除（那是它不认识 schema 也能工作的原因）。
       所以给 `ContractChange.amountCents` 标一个 price 门，会连带把
       `SideEffect.amountCents`（补偿单金额、成本归集金额）一起删掉。

       这个失败极难查：没有报错，只是某几个字段在某些角色下不见了，
       而且只在**跑到那条命令**时才看得见。第一次撞上它花了半小时 ——
       现在 fieldGates() 里那条断言把它变成一次构建期失败。
       这条测试钉的是"那条断言还在，而且现在是干净的"。 */
    const { fieldGates } = await import("../src/kernel/gates.js");
    expect(() => fieldGates()).not.toThrow();

    const gated = new Set(Object.keys(fieldGates()));
    for (const [name, sc] of Object.entries<any>(doc.components.schemas)) {
      /* **只查响应侧。** 脱敏是出口上的事（MaskInterceptor），
         请求体不过那道门 —— 一个受管辖的键名出现在 `XxxRequest` 里
         是正常的：`createBid` 的请求带 ourQuoteCents，
         而它的响应 `Bid` 里那一栏是标了门的。 */
      if (name.endsWith("Request")) continue;
      for (const [k, p] of Object.entries<any>(sc.properties ?? {}))
        if (gated.has(k))
          expect(p["x-gated-by"],
            `${name}.${k} 没标门，但 ${k} 在别处被标了 —— 它会被一起删掉`)
            .toBeTruthy();
    }
  });

  it("openapi.yaml 与 zod 定义一致 —— 产物不得手改", () => {
    execFileSync("npx", ["tsx", "scripts/gen-openapi.ts"], { cwd: ROOT, stdio: "pipe" });
    const now = fs.readFileSync(SPEC, "utf8");
    expect(yaml.load(now)).toEqual(doc);
  });
});

describe("路径是原样写的，不能带转义", () => {
  /* 这条是被咬了两次才加的。NestJS 的路由里 `:` 要写成 `\\:`
     （否则被当成路径参数），而顺手把那个反斜杠也抄进**契约**的话：

       契约说 /v1/timesheets/{id}\:approve
       服务器实际服务 /v1/timesheets/{id}:approve

     两边永远对不上，而 arch:check 只比 operationId，测试用的是自己写死的
     路径字符串 —— 于是整条链路全绿，只有真正走契约生成客户端的前端会 404。
     那个 404 在界面上表现成"上游不可用"，指不到任何地方。 */
  it("没有一条路径带反斜杠", () => {
    const bad = allEndpoints().filter(e => e.path.includes("\\"));
    expect(bad.map(e => `${e.id}: ${e.path}`),
      "契约里的路径是**原样**的 URL；NestJS 装饰器里的转义不该抄进来").toEqual([]);
  });

  it("每条路径都长得像一个 URL", () => {
    /* 只放行真实出现过的字符：段、路径参数、以及 L2 命令的 `:动词`。 */
    const shape = /^\/v1\/[A-Za-z0-9/{}:_-]*$/;
    const bad = allEndpoints().filter(e => !shape.test(e.path));
    expect(bad.map(e => `${e.id}: ${e.path}`)).toEqual([]);
  });
});

describe("查询串里的布尔：?flag=false 必须真的是 false", () => {
  /* 这条曾经在整个仓库里错着。`z.coerce.boolean()` 走 `Boolean(v)`，
     而 `Boolean("false") === true` —— 于是 `?includeVoided=false`
     和 `?includeVoided=true` 是一个意思。
     只传 true 的地方看不出问题，所以它安静地待了很多个阶段。 */
  it("认 true/1/yes 和 false/0/no，两边都对", () => {
    for (const v of ["true", "1", "yes", "on", true])
      expect(QueryBool.parse(v), `${String(v)} 应当是 true`).toBe(true);
    for (const v of ["false", "0", "no", "off", false])
      expect(QueryBool.parse(v), `${String(v)} 应当是 false`).toBe(false);
  });

  it("拼错的值报错，而不是猜一个", () => {
    /* 把 ?flag=ture 当成 false 也是在猜；猜错时同样是安静的。 */
    for (const v of ["ture", "", "2", "y"])
      expect(() => QueryBool.parse(v), `${v} 应当被拒`).toThrow();
  });

  it("契约里所有布尔查询参数都用它 —— 不能再有 z.coerce.boolean()", () => {
    /* 光修一处没有意义：下一个人照着旁边那行写，就又回去了。 */
    const src = path.join(import.meta.dirname, "..", "src");
    const bad: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) walk(f);
        /* primitives.ts 是定义 QueryBool 的地方，它的注释里写着这个反例 */
        else if (e.name.endsWith(".ts") && e.name !== "primitives.ts"
                 && fs.readFileSync(f, "utf8").includes("coerce.boolean"))
          bad.push(path.relative(src, f));
      }
    };
    walk(src);
    expect(bad, "这些文件还在用 z.coerce.boolean()，?flag=false 会被读成 true").toEqual([]);
  });
});

describe("破坏性变更门禁真的会响", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "contract-"));
  const run = (baseFile: string) => {
    try {
      return { code: 0, out: execFileSync("npx",
        ["tsx", "scripts/check-breaking.ts", "--baseline", baseFile],
        { cwd: ROOT, encoding: "utf8", stdio: "pipe" }) };
    } catch (e: any) {
      return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
    }
  };
  const mutate = (fn: (d: any) => void) => {
    const d = yaml.load(fs.readFileSync(SPEC, "utf8"));
    fn(d);
    const f = path.join(tmp(), "base.yaml");
    fs.writeFileSync(f, yaml.dump(d));
    return f;
  };

  it("无变化时通过", () => {
    const r = run(mutate(() => {}));
    expect(r.code).toBe(0);
    expect(r.out).toContain("契约无变化");
  });

  it("删除端点 → 拦截", () => {
    /* 基线里有、当前没有 = 当前删除了它 */
    const r = run(mutate(d => { d.paths["/v1/ghost"] = { get: { operationId: "ghost", responses: { "200": {} } } }; }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("删除端点");
  });

  it("删除响应字段 → 拦截", () => {
    const r = run(mutate(d => { d.components.schemas.StudySite.properties.ghostField = { type: "string" }; }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("删除字段 ghostField");
  });

  it("字段类型变更 → 拦截", () => {
    const r = run(mutate(d => { d.components.schemas.StudySite.properties.contracted.type = "string"; }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("类型变更");
  });

  it("请求端：可选字段变必填 → 拦截", () => {
    const r = run(mutate(d => {
      d.components.schemas.CreateStudySiteRequest.required =
        d.components.schemas.CreateStudySiteRequest.required.filter((x: string) => x !== "city");
    }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("由可选变为必填（请求端）");
  });

  it("请求端：新增必填字段 → 拦截（旧客户端不会发送它）", () => {
    const r = run(mutate(d => {
      delete d.components.schemas.CreateStudySiteRequest.properties.city;
      d.components.schemas.CreateStudySiteRequest.required =
        d.components.schemas.CreateStudySiteRequest.required.filter((x: string) => x !== "city");
    }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("新增必填字段 city（请求端");
  });

  it("响应端：新增字段 → 放行（客户端只是多收到一点）", () => {
    const r = run(mutate(d => { delete d.components.schemas.StudySite.properties.city; }));
    expect(r.code).toBe(0);
    expect(r.out).toContain("新增");
  });

  it("响应端：必填变可选 → 拦截（客户端原本可假定它存在）", () => {
    /* unitPriceCents 受列权限管辖，因而在当前契约里是 optional。
       若基线曾把它列为必填，说明它从"一定有"退化成了"可能没有"。 */
    const r = run(mutate(d => {
      d.components.schemas.StudySite.required.push("unitPriceCents");
    }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("由必填变为可选（响应端");
  });

  it("请求端枚举移除取值 → 拦截", () => {
    const r = run(mutate(d => { d.components.schemas.SiteState.enum.push("ghost_state"); }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("枚举移除取值");
  });

  it("SideEffectType 新增取值 → 放行（已声明 x-extensible）", () => {
    const r = run(mutate(d => { d.components.schemas.SideEffectType.enum.pop(); }));
    expect(r.code).toBe(0);
    expect(r.out).toContain("已声明可扩展");
  });

  it("普通枚举新增取值 → 放行但告警（穷举分支的客户端会漏）", () => {
    const r = run(mutate(d => { d.components.schemas.SiteState.enum.pop(); }));
    expect(r.code).toBe(0);
    expect(r.out).toContain("需要留意");
  });
});

/* ════════════════════════════════════════════════════════════════════
   基线取哪一个 ref —— 门禁成不成立的全部。

   上面那一组验的是**比对逻辑**，用 `--baseline <文件>` 喂进去，一直是绿的。
   而门禁在 CI 上其实什么也没验：`actions/checkout` 在 pull_request 事件里
   检出的是**合并提交**，`git show HEAD:openapi.yaml` 拿到的就是本 PR 提议的
   那一份，工作区里刚生成的也是同一份 —— **文件在跟自己比**。

   逻辑有测试、取基线没有，于是坏掉的恰好是没被测的那一半。
   这一组补的就是它。
   ════════════════════════════════════════════════════════════════════ */
describe("破坏性变更门禁：基线是怎么选的", () => {
  const REPO = path.resolve(ROOT, "../..");
  const REL = path.relative(REPO, SPEC).replace(/\\/g, "/");
  const run = (args: string[], env: Record<string, string> = {}) => {
    try {
      return { code: 0, out: execFileSync("npx", ["tsx", "scripts/check-breaking.ts", ...args],
        { cwd: ROOT, encoding: "utf8", stdio: "pipe", env: { ...process.env, ...env } }) };
    } catch (e: any) {
      return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
    }
  };

  it("CI 上不给基线 → 硬失败，而不是拿 HEAD 跟自己比", () => {
    const r = run([], { CI: "1" });
    expect(r.code).toBe(2);
    expect(r.out).toContain("必须显式给出基线");
    expect(r.out).toContain("SITEDESK_BASELINE_REF");
  });

  it("ref 取不到（浅克隆写错）→ 硬失败，而不是悄悄放行", () => {
    /* 原来这里一律 `catch { return null }` 然后 exit 0 ——
       任何 git 失败都会让门禁绿着过去。那是最坏的一种绿。 */
    const r = run(["--baseline-ref", "deadbeef".repeat(5)], { CI: "1" });
    expect(r.code).toBe(2);
    expect(r.out).toContain("取不到 ref");
  });

  it("环境变量 SITEDESK_BASELINE_REF 能定基线 —— CI 走的是这条路", () => {
    /* 为什么是环境变量而不是 `-- --baseline-ref`：
       npm 会把参数**名字**吃掉只透传值（根脚本外面还套了一层 `npm run … -w`，
       每过一层都可能被重新解析）。CI 上就是这么红的一次。 */
    const r = run([], { CI: "1", SITEDESK_BASELINE_REF: "HEAD" });
    /* 断言的是**它真的拿这个基线比了一次**，不是"比出来是干净的"。
       原来这里写的是 `toBe(0)` —— 那把"机制对不对"和"工作区恰好没有
       破坏性变更"绑在了一起：某次评审里真的做了一次故意的破坏，
       这条测试就跟着红，而红的原因跟被测代码毫无关系。
       2（没给基线 / 取不到 ref）才是这条要排除的失败。 */
    expect(r.code).not.toBe(2);
    expect(r.out).not.toContain("必须显式给出基线");
  });

  it("只收到一个没有名字的裸 sha → 点破是 npm 把参数名吃了", () => {
    const r = run(["deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"], { CI: "1" });
    expect(r.code).toBe(2);
    expect(r.out).toContain("npm 把");
    expect(r.out).toContain("SITEDESK_BASELINE_REF");
  });

  it("本地不带参数 → 仍然默认 HEAD（比的是工作区相对上一次提交）", () => {
    /* 必须显式把 CI 清掉：GitHub Actions 会**全局**设 CI=true，
       而这条验的恰恰是"不在 CI 时的行为"。
       不清的话它在本地绿、在 CI 红 —— 而红的原因跟被测代码毫无关系。 */
    const r = run([], { CI: "" });
    /* 同上：验的是"没给参数时它退回 HEAD 并且真的比了"，
       而不是"这一刻的工作区是干净的"。 */
    expect(r.code).not.toBe(2);
    expect(r.out).not.toContain("必须显式给出基线");
  });

  it("给一个契约确实不同的 ref → 真的比出了差异", () => {
    /* 这一条才是 CI 那个 bug 的反面：拿历史上**另一个版本**的 openapi.yaml
       当基线，必须比出东西来。比不出来，就说明它又在跟自己比。

       挑基线要按**结构**挑，不能按字节挑。门禁比的是端点、schema、字段、
       枚举 —— 说明文字的改动它看不见，而且**本来就该看不见**（改一句
       描述不是破坏性变更）。按字节挑的话，一次纯文案改动就会挑中上一个
       提交，然后门禁如实回答"契约无变化"，这条测试当场红 ——
       红的是测试的挑法，不是被测的门禁。 */
    const shapeOf = (text: string): string => {
      const d = yaml.load(text) as any;
      const paths = Object.entries(d.paths ?? {}).flatMap(([p, ms]: [string, any]) =>
        Object.entries(ms).map(([m, op]: [string, any]) => `${m} ${p} ${op.operationId ?? ""}`));
      const schemas = Object.entries(d.components?.schemas ?? {}).map(([n, sc]: [string, any]) =>
        `${n}(${Object.keys(sc.properties ?? {}).sort().join(",")})` +
        `[${(sc.required ?? []).slice().sort().join(",")}]`);
      return JSON.stringify([paths.sort(), schemas.sort()]);
    };

    const here = shapeOf(fs.readFileSync(SPEC, "utf8"));
    const revs = execFileSync("git", ["log", "-n", "50", "--format=%H", "--", REL],
      { cwd: REPO, encoding: "utf8" }).trim().split("\n").filter(Boolean);
    const older = revs.find(rev =>
      shapeOf(execFileSync("git", ["show", `${rev}:${REL}`], { cwd: REPO, encoding: "utf8" }))
        !== here);
    expect(older, "历史里应当存在一个结构不同的 openapi.yaml").toBeTruthy();

    const r = run(["--baseline-ref", older!, "--allow-breaking"]);
    expect(r.out).not.toContain("契约无变化");
  });
});
