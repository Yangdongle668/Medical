import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as yaml from "js-yaml";
import { allEndpoints, COMMON_ERRORS } from "../src/kernel/registry.js";
import { ERRORS } from "../src/kernel/errors.js";
import "../src/index.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const SPEC = path.join(ROOT, "openapi.yaml");
const doc = yaml.load(fs.readFileSync(SPEC, "utf8")) as any;

describe("契约约定（不是风格偏好，每条对应一次事故）", () => {
  it("L2 命令一律 POST，且路径形如 /v1/xxx/{id}:action", () => {
    for (const e of allEndpoints().filter(e => e.layer === "L2")) {
      expect(e.method, e.id).toBe("post");
      expect(e.path, e.id).toMatch(/:\w+$/);
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

  it("openapi.yaml 与 zod 定义一致 —— 产物不得手改", () => {
    execFileSync("npx", ["tsx", "scripts/gen-openapi.ts"], { cwd: ROOT, stdio: "pipe" });
    const now = fs.readFileSync(SPEC, "utf8");
    expect(yaml.load(now)).toEqual(doc);
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
