import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { boot, resetDb, as, type Caller } from "./harness.js";
import { parseCsv, readTable } from "../src/infra/csv.js";
import { todayLocal, plusDays } from "../src/infra/clock.js";

/* ════════════════════════════════════════════════════════════════════
   导出留痕与批量导入（W16 / W17）。

   导入最要紧的三句话：试运行**什么都不写**；执行时**每行各自成败**；
   每一行走的是单条登记 / 单个建号那一套校验 —— 不另起一套判定。
   ════════════════════════════════════════════════════════════════════ */

let app: INestApplication;
let crc: Caller, admin: Caller;
const K = () => ({ "Idempotency-Key": randomUUID() });

beforeAll(async () => {
  resetDb(); app = await boot();
  crc = await as(app, "wutong");            // SS-01 的 CRC
  admin = await as(app, "admin");
}, 180_000);
afterAll(async () => { await app?.close(); });

const siteByCode = async (c: Caller, code: string) =>
  (await c.get(`/v1/study-sites?limit=200&q=${code}`)).body.items
    .find((s: { code: string }) => s.code === code);

describe("CSV", () => {
  it("BOM、引号、引号里的逗号与换行、CRLF", () => {
    expect(parseCsv('﻿筛选号,知情签署日\r\n"A,1","x""y"\r\n"多\n行",\r\n'))
      .toEqual([["筛选号", "知情签署日"], ["A,1", 'x"y'], ["多\n行", ""]]);
  });

  it("按表头取列（括号里的提示不算），全空行跳过，缺必需列整体拒绝", () => {
    const rows = readTable("姓名（必填）,登录名\n张三,zhangsan\n,\n李四,lisi\n",
      [{ key: "login", label: "登录名", required: true }, { key: "name", label: "姓名" }]);
    expect(rows).toEqual([
      { line: 2, cells: { login: "zhangsan", name: "张三" } },
      { line: 4, cells: { login: "lisi", name: "李四" } }]);
    expect(() => readTable("姓名\n张三\n", [{ key: "login", label: "登录名", required: true }]))
      .toThrow(/缺少这几列：登录名/);
  });
});

describe("导出留痕", () => {
  it("记一条审计：哪张表、多少行、什么条件", async () => {
    const s = await siteByCode(crc, "SS-01");
    const r = await crc.post("/v1/exports:record",
      { list: "subjects", rows: 42, studySiteId: s.id, filters: { state: "enrolled" } }, K());
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ data: { recorded: true }, sideEffects: [] });

    const a = await admin.get(`/v1/audit-entries?targetType=export&actorLogin=wutong&limit=5`);
    expect(a.body.items[0]).toMatchObject({ action: "导出受试者列表", targetId: "subjects" });
  });

  it("看不到的中心 404；不带幂等键 422", async () => {
    expect((await crc.post("/v1/exports:record",
      { list: "visits", rows: 1, studySiteId: randomUUID() }, K())).status).toBe(404);
    expect((await crc.post("/v1/exports:record", { list: "visits", rows: 1 })).status).toBe(422);
  });
});

describe("预筛登记批量导入", () => {
  let siteId: string;
  let existing: string;
  const tag = `IMP-${Date.now() % 100000}`;
  const csv = () => [
    "筛选号（空着=自动发号）,知情签署日",
    `${tag}-1,`,
    `,${plusDays(todayLocal(), -1)}`,                 // 自动发号 + 签知情
    `${tag}-1,`,                                     // 文件内重复
    `${tag}-3,2026-13-01`,                           // 日期不对
    `${tag}-4,${plusDays(todayLocal(), 3)}`,          // 签署日在将来：signIcf 那一道拒绝
    `${existing},`                                   // 库里已有
  ].join("\r\n");

  beforeAll(async () => {
    siteId = (await siteByCode(crc, "SS-01")).id;
    existing = (await crc.get(`/v1/subjects?studySiteId=${siteId}&limit=1`)).body.items[0].screeningNo;
  });

  const count = async (q: string) =>
    (await crc.get(`/v1/subjects?studySiteId=${siteId}&q=${q}&limit=200`)).body.items.length;

  it("试运行逐行说能不能导，并且什么都不写", async () => {
    const before = await count(tag);
    const r = await crc.post("/v1/imports/prescreen:preview", { csv: csv(), studySiteId: siteId }, K());
    expect(r.status).toBe(201);
    const rows = r.body.data.rows as { line: number; status: string; error: string | null; screeningNo: string | null }[];
    expect(rows.map(x => [x.line, x.status])).toEqual([
      [2, "ok"], [3, "ok"], [4, "error"], [5, "error"], [6, "error"], [7, "error"]]);
    expect(rows[2]!.error).toMatch(/重复/);
    expect(rows[3]!.error).toMatch(/YYYY-MM-DD/);
    expect(rows[4]!.error).toMatch(/不能晚于今天/);
    expect(rows[5]!.error).toMatch(/已经有/);
    expect(rows[1]!.screeningNo, "试运行里自动发的号会作废，不显示").toBeUndefined();
    expect(r.body.data).toMatchObject({ ok: 2, bad: 4 });
    expect(await count(tag)).toBe(before);
  });

  it("执行：能导的建出来，不能导的各自失败，不连累别的行", async () => {
    const r = await crc.post("/v1/imports/prescreen:commit", { csv: csv(), studySiteId: siteId }, K());
    expect(r.status).toBe(201);
    const rows = r.body.data.rows as { status: string; ref: string | null; screeningNo: string | null }[];
    expect(rows.map(x => x.status)).toEqual(["done", "done", "failed", "failed", "failed", "failed"]);
    expect(rows[0]!.screeningNo).toBe(`${tag}-1`);
    expect(rows[1]!.screeningNo).toMatch(/^SS-01-/);

    const signed = (await crc.get(`/v1/subjects/${rows[1]!.ref}`)).body;
    expect(signed.state).toBe("screening");
    expect(await count(`${tag}-1`)).toBe(1);

    /* 同一份文件再试一次：刚建的那一行现在是「已存在」 */
    const again = await crc.post("/v1/imports/prescreen:preview", { csv: csv(), studySiteId: siteId }, K());
    expect(again.body.data.rows[0].status).toBe("error");
  });

  it("同一把幂等键重发，不会建两遍", async () => {
    const key = K();
    const body = { csv: `筛选号\n${tag}-R\n`, studySiteId: siteId };
    const a = await crc.post("/v1/imports/prescreen:commit", body, key);
    const b = await crc.post("/v1/imports/prescreen:commit", body, key);
    expect(b.body).toEqual(a.body);
    expect(await count(`${tag}-R`)).toBe(1);
  });

  it("表头不对整体 422；看不到的中心 404", async () => {
    expect((await crc.post("/v1/imports/prescreen:preview",
      { csv: "筛选号\n", studySiteId: siteId }, K())).status).toBe(422);
    expect((await crc.post("/v1/imports/prescreen:preview",
      { csv: "筛选号\nA\n", studySiteId: randomUUID() }, K())).status).toBe(404);
  });
});

describe("人员账号批量创建", () => {
  const n = Date.now() % 100000;
  const csv = [
    "登录名,姓名,角色,级别,城市,GCP证书到期日,分组",
    `imp_a${n},导入甲,crc,中级,北京,2027-06-30,`,
    `imp_b${n},导入乙,临床协调员,初级,上海,,`,
    `imp_c${n},导入丙,inst,中级,北京,,`,            // 外部方
    `imp_d${n},导入丁,crc,特级,北京,,`,             // 级别不对
    `wutong,重名,crc,中级,北京,,`,                   // 登录名已存在
    `Bad-Login,坏名字,crc,中级,北京,,`,              // 登录名格式
    `imp_a${n},又一个甲,crc,中级,北京,,`             // 文件内重复
  ].join("\n");

  it("只有管理员能用", async () => {
    expect((await crc.post("/v1/imports/accounts:preview", { csv }, K())).status).toBe(403);
  });

  it("试运行不建号；执行建号并登记名册", async () => {
    const p = await admin.post("/v1/imports/accounts:preview", { csv }, K());
    expect(p.status).toBe(201);
    const st = (r: { body: { data: { rows: { status: string }[] } } }) => r.body.data.rows.map(x => x.status);
    expect(st(p)).toEqual(["ok", "ok", "error", "error", "error", "error", "error"]);
    const err = p.body.data.rows.map((x: { error: string | null }) => x.error);
    expect(err[2]).toMatch(/外部方/);
    expect(err[3]).toMatch(/级别/);
    expect(err[4]).toMatch(/已存在/);
    expect(err[5]).toMatch(/登录名/);
    expect(err[6]).toMatch(/重复/);
    expect((await admin.get(`/v1/accounts?q=imp_a${n}`)).body.items).toHaveLength(0);

    const c = await admin.post("/v1/imports/accounts:commit", { csv }, K());
    expect(st(c)).toEqual(["done", "done", "failed", "failed", "failed", "failed", "failed"]);
    const a = (await admin.get(`/v1/accounts?q=imp_a${n}`)).body.items[0];
    expect(a).toMatchObject({ login: `imp_a${n}`, displayName: "导入甲", staffRoleKind: "CRC" });
  });
});
