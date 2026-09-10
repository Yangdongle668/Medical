import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import {
  canSeeSite, visibleSites, siteScopeSql, canSeeStudy, studyScopeSql,
  type Principal, type ScopeContext, type SiteFacts, type StudyFacts,
  type RowRule, type ActionKey
} from "../src/index.js";
import type { FieldKey } from "@sitedesk/contracts";

/* ════════════════════════════════════════════════════════════════════
   等价性测试 —— 本包最重要的一个测试。

   行范围有两处实现：
     · 数据库 app.site_visible()  —— 兜底，防的是绕过应用层的裸 SQL
     · TypeScript canSeeSite()    —— 主路径，查询层注入 + 前端收敛
   **两者不一致就是数据泄漏。** 所以这里用真实数据穷举比对全部组合，
   而不是各自写各自的用例。
   ════════════════════════════════════════════════════════════════════ */

const ROOT = path.resolve(import.meta.dirname, "../../..");
for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
}

interface AccountRow {
  id: string; login: string; tenant_id: string; team_id: string | null;
  org_ref: string | null; is_external: boolean; status: string;
  role_code: string; row_rule: string;
  fields: string[]; actions: string[]; modules: string[];
}
interface AssignRow { account_id: string; study_site_id: string }
interface TeamStudyRow { team_id: string; study_id: string }
interface SiteRow {
  id: string; tenant_id: string; study_id: string;
  hospital: string; pi_account_id: string | null; code: string;
}

let owner: pg.Client, app: pg.Client;
interface Loaded { key: string; p: Principal; ctx: ScopeContext }
let loaded: Loaded[];
let sites: SiteFacts[];
let studies: StudyFacts[];

/** 按登录名取一个演示租户里的账号。撞名的（admin）不走这里，走 loaded。 */
function who(login: string): Loaded {
  const hits = loaded.filter(x => x.p.login === login);
  if (hits.length !== 1)
    throw new Error(`登录名 ${login} 在测试库里有 ${hits.length} 个账号 —— 这个辅助只认唯一的那种`);
  return hits[0]!;
}

/** 一个账号所在租户里的中心。`all` 的意思是"本租户全部"，不是"表里全部"。 */
const tenantSites = (p: Principal) => sites.filter(s => s.tenantId === p.tenantId);

beforeAll(async () => {
  owner = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  app   = new pg.Client({ connectionString: process.env.APP_TEST_DATABASE_URL });
  await owner.connect(); await app.connect();

  const accounts = await owner.query<AccountRow>(`
    SELECT a.id, a.login, a.tenant_id, a.team_id, a.org_ref, a.is_external, a.status,
           r.code AS role_code, r.row_rule,
           coalesce((SELECT array_agg(rf.field_key) FROM role_field rf
                      WHERE rf.role_id = r.id AND rf.visible), '{}') AS fields,
           coalesce((SELECT array_agg(ra.action_key) FROM role_action ra
                      WHERE ra.role_id = r.id AND ra.allowed), '{}') AS actions,
           coalesce((SELECT array_agg(rm.module_key) FROM role_module rm
                      WHERE rm.role_id = r.id), '{}') AS modules
      FROM account a JOIN role r ON r.id = a.role_id ORDER BY a.login`);

  const assigns = await owner.query<AssignRow>(`
    SELECT account_id, study_site_id FROM site_assignment WHERE effective @> CURRENT_DATE`);
  /* 交接进行中，接手人提前看得到（迁移 0021）。装进 ctx 才谈得上等价：
     漏掉它，TS 判定会说"看不见"，而数据库说"看得见"—— 那正是这套测试
     要抓的那种分歧，只不过分歧出在测试自己身上。 */
  const handovers = await owner.query<AssignRow>(`
    SELECT h.to_account_id AS account_id, hs.study_site_id
      FROM handover h JOIN handover_site hs ON hs.handover_id = h.id
     WHERE h.status = 'pending'`);
  const teamStudies = await owner.query<TeamStudyRow>(`SELECT team_id, study_id FROM team_study`);

  /* **不能按 login 建索引。** 出厂管理员每个租户各有一个，都叫 admin
     （迁移 0026）—— 撞了的话 Map 里只剩最后一个，
     下面那些"每个账号 × 每个中心"的穷举就此少掉几个人。
     一个安静缩小了覆盖面的测试比没有测试更糟，而且它永远是绿的。 */
  loaded = [];
  for (const a of accounts.rows) {
    loaded.push({
      key: `${a.tenant_id.slice(0, 8)}/${a.login}`,
      p: {
        accountId: a.id, tenantId: a.tenant_id, login: a.login,
        roleCode: a.role_code, rowRule: a.row_rule as RowRule,
        isExternal: a.is_external, active: a.status === "active",
        teamId: a.team_id, orgRef: a.org_ref,
        fields: a.fields as FieldKey[], actions: a.actions as unknown as ActionKey[], modules: a.modules
      },
      ctx: {
        assignedSiteIds: new Set(
          assigns.rows.filter(x => x.account_id === a.id).map(x => x.study_site_id)),
        teamStudyIds: new Set(
          teamStudies.rows.filter(x => x.team_id === a.team_id).map(x => x.study_id)),
        handoverSiteIds: new Set(
          handovers.rows.filter(x => x.account_id === a.id).map(x => x.study_site_id))
      }
    });
  }

  const s = await owner.query<SiteRow>(
    `SELECT id, tenant_id, study_id, hospital, pi_account_id, code FROM study_site ORDER BY code`);
  sites = s.rows.map(r => ({
    id: r.id, tenantId: r.tenant_id, studyId: r.study_id,
    hospital: r.hospital, piAccountId: r.pi_account_id
  }));

  /* 项目范围要单独比 —— 它不是"有没有一个可见的中心"的同义词。
     而且这里**故意造一个没有中心的项目**：项目范围出过的那个 bug
     只在这种项目上显形，用现有 seed（每个项目都有中心）比一万遍都是绿的。 */
  await owner.query(`
    INSERT INTO study (code, short_name, client_id, phase, indication,
                       planned_subjects, planned_sites, contract_amount_cents, started_on)
    SELECT 'ZZ-NOSITE-001', '没有中心的项目', cl.id, 'II', '等价性测试',
           10, 1, 100000, CURRENT_DATE
      FROM client cl ORDER BY cl.id LIMIT 1
    ON CONFLICT (tenant_id, code) DO NOTHING`);
  /* 把它归给一个组 —— team 那一支只有归了组才谈得上比对。 */
  await owner.query(`
    INSERT INTO team_study (team_id, study_id)
    SELECT (SELECT id FROM team ORDER BY id LIMIT 1), st.id
      FROM study st WHERE st.code = 'ZZ-NOSITE-001'
    ON CONFLICT DO NOTHING`);

  const stq = await owner.query<{ id: string; tenant_id: string }>(
    `SELECT id, tenant_id FROM study ORDER BY code`);
  studies = stq.rows.map(r => ({ id: r.id, tenantId: r.tenant_id }));

  /* 上面新插的那一行会改变 teamStudyIds，必须重新装 ctx —— 否则
     TS 那一侧读的是插入前的快照，比出来的"不一致"是测试自己造的。 */
  const teamStudies2 = await owner.query<TeamStudyRow>(
    `SELECT team_id, study_id FROM team_study`);
  for (const l of loaded)
    l.ctx = { ...l.ctx, teamStudyIds: new Set(
      teamStudies2.rows.filter(x => x.team_id === l.p.teamId).map(x => x.study_id)) };
});
afterAll(async () => {
  /* 把造出来的那个项目收走 —— 同一个库还要跑别的测试文件
     （vitest 在本包里是 fileParallelism:false，共用一个库）。 */
  await owner.query(`DELETE FROM team_study WHERE study_id IN
    (SELECT id FROM study WHERE code = 'ZZ-NOSITE-001')`);
  await owner.query(`DELETE FROM study WHERE code = 'ZZ-NOSITE-001'`);
  await owner.end(); await app.end();
});

/** 以某账号身份，问数据库「你看得到哪些中心」—— RLS 真实生效 */
async function dbVisible(accountId: string): Promise<Set<string>> {
  await app.query("BEGIN");
  try {
    await app.query("SELECT set_config('app.account_id', $1, true)", [accountId]);
    const { rows } = await app.query<{ id: string }>("SELECT id FROM study_site");
    return new Set(rows.map(r => r.id));
  } finally { await app.query("ROLLBACK"); }
}

/** 用 siteScopeSql 注入范围（以 owner 连接执行，绕过 RLS）—— 验证第三条路径 */
async function sqlVisible(p: Principal): Promise<Set<string>> {
  const { sql, params } = siteScopeSql(p, "s");
  const { rows } = await owner.query<{ id: string }>(
    `SELECT s.id FROM study_site s WHERE ${sql}`, params);
  return new Set(rows.map(r => r.id));
}

/** 以某账号身份，问数据库「你看得到哪些项目」—— study_scope 策略真实生效 */
async function dbStudies(accountId: string): Promise<Set<string>> {
  await app.query("BEGIN");
  try {
    await app.query("SELECT set_config('app.account_id', $1, true)", [accountId]);
    const { rows } = await app.query<{ id: string }>("SELECT id FROM study");
    return new Set(rows.map(r => r.id));
  } finally { await app.query("ROLLBACK"); }
}

/** 用 studyScopeSql 注入范围（owner 连接，绕过 RLS） */
async function sqlStudies(p: Principal): Promise<Set<string>> {
  const { sql, params } = studyScopeSql(p, "st");
  const { rows } = await owner.query<{ id: string }>(
    `SELECT st.id FROM study st WHERE ${sql}`, params);
  return new Set(rows.map(r => r.id));
}

describe("行范围：三处实现必须逐一致", () => {
  it("覆盖了全部六条规则 —— 否则等价性只证明了一部分", async () => {
    const rules = new Set(loaded.map(x => x.p.rowRule));
    expect([...rules].sort()).toEqual(["all", "assigned", "hospital", "pi", "team"]);
    /* none 没有账号使用，单独构造验证 */
    const fake: Principal = { ...loaded[0]!.p, rowRule: "none" };
    expect(visibleSites(fake, {
      assignedSiteIds: new Set(), teamStudyIds: new Set(), handoverSiteIds: new Set()
    }, sites)).toEqual([]);
  });

  it("每个账号 × 每个中心：TS 判定 === 数据库 RLS 判定", async () => {
    const mismatches: string[] = [];
    let checked = 0;
    for (const { key, p, ctx } of loaded) {
      const fromDb = await dbVisible(p.accountId);
      for (const site of sites) {
        const ts = canSeeSite(p, ctx, site);
        const db = fromDb.has(site.id);
        checked++;
        if (ts !== db)
          mismatches.push(`${key}(${p.rowRule}) × ${site.id}：TS=${ts} DB=${db}`);
      }
    }
    expect(checked).toBe(loaded.length * sites.length);
    expect(mismatches, `${mismatches.length} 处不一致 —— 每一处都是潜在泄漏`).toEqual([]);
  });

  it("每个账号：siteScopeSql 注入的范围 === 数据库 RLS 判定", async () => {
    const mismatches: string[] = [];
    for (const { key, p } of loaded) {
      const viaSql = await sqlVisible(p);
      const viaRls = await dbVisible(p.accountId);
      const only = (a: Set<string>, b: Set<string>) => [...a].filter(x => !b.has(x));
      if (only(viaSql, viaRls).length || only(viaRls, viaSql).length)
        mismatches.push(`${key}：SQL ${viaSql.size} 个 vs RLS ${viaRls.size} 个`);
    }
    expect(mismatches).toEqual([]);
  });

  it("停用账号：三处一致地返回空", async () => {
    const zq = who("zhouqi");
    expect(zq.p.active).toBe(false);
    expect(visibleSites(zq.p, zq.ctx, sites)).toEqual([]);
    expect((await dbVisible(zq.p.accountId)).size).toBe(0);
    expect((await sqlVisible(zq.p)).size).toBe(0);
  });

  it("跨租户：即使 rowRule=all 也看不到别家的中心", async () => {
    const boss = who("lingyuan");
    const alien: SiteFacts = {
      id: "00000000-0000-0000-0000-0000000000aa",
      tenantId: "00000000-0000-0000-0000-0000000000ff",
      studyId: "00000000-0000-0000-0000-0000000000bb",
      hospital: "他家医院", piAccountId: null
    };
    expect(canSeeSite(boss.p, boss.ctx, alien)).toBe(false);
  });

  it("每条规则至少有一个账号看到的不是全集，也不是空集 —— 否则等价性可能是巧合", () => {
    /* 比的分母是**本租户**的中心数，不是 study_site 的总行数。
       这两个数曾经相等，纯粹因为所有 all 规则的账号恰好都在演示租户里；
       迁移 0026 给每个租户各开了一个 admin 之后就不再相等了 ——
       而那个新租户一个中心都没有，于是"all 看得到全部"当场变成 0 === 15。

       该改的是这句话的措辞，不是它的严格度：**all 的意思一直是
       「本租户全部」**，上面那条跨租户测试说的就是这件事。 */
    const bySize = new Map<string, number[]>();
    for (const { p, ctx } of loaded) {
      if (!p.active) continue;
      const mine = tenantSites(p);
      /* 空租户对"不是全集也不是空集"这句话没有意义：那里 0 就是全部。
         留着它只会让下面几行变成"除非中心数为 0"的绕口令。 */
      if (!mine.length) continue;
      const n = visibleSites(p, ctx, mine).length;
      bySize.set(p.rowRule, [...(bySize.get(p.rowRule) ?? []), n]);
    }
    const 真子集 = (rule: string) => {
      const ns = bySize.get(rule);
      expect(ns, `没有任何在职账号用 ${rule} 规则 —— 这条规则其实没被测到`).toBeTruthy();
      for (const n of ns!) expect(n > 0 && n < sites.length, `${rule} 看到 ${n} 个`).toBe(true);
    };
    for (const rule of ["team", "assigned", "hospital", "pi"]) 真子集(rule);
    /* all：看到的正是自己租户的全部 */
    for (const { p, ctx } of loaded) {
      if (!p.active || p.rowRule !== "all") continue;
      const mine = tenantSites(p);
      expect(visibleSites(p, ctx, sites).length,
        `${p.login}（all）应当看到本租户的 ${mine.length} 个中心`).toBe(mine.length);
    }
  });
});

/* ════════════════════════════════════════════════════════════════════
   项目范围 —— 与行范围同一套办法，但**不是同一条判定**。

   写成「有没有一个可见的中心」曾经是这里唯一的实现，而它在
   一个还没有中心的项目上恒为假：项目从批下来那一刻起谁也看不见，
   包括 row_rule=all 的管理员（数据库那侧一直有短路，应用层没有）。
   而建中心、登记可行性、递交立项材料、提合同变更这四张表单
   第一栏都是「选项目」—— 于是新项目永远建不出第一个中心。

   所以下面这组测试的分母里**必须有一个没有中心的项目**
   （ZZ-NOSITE-001，在 beforeAll 里造）：
   用现有 seed 比，每个项目都有中心，这个 bug 一次也不会显形。
   ════════════════════════════════════════════════════════════════════ */
describe("项目范围：TS 与 RLS 必须一致", () => {
  it("分母里确实有一个没有中心的项目 —— 否则下面几条测的是别的东西", () => {
    const 无中心 = studies.filter(st => !sites.some(s => s.studyId === st.id));
    expect(无中心.length, "一个没有中心的项目都没有，这组测试证明不了什么").toBeGreaterThan(0);
  });

  it("每个账号 × 每个项目：canSeeStudy === 数据库 study_scope", async () => {
    const mismatches: string[] = [];
    let checked = 0;
    for (const { key, p, ctx } of loaded) {
      const fromDb = await dbStudies(p.accountId);
      for (const st of studies) {
        const ts = canSeeStudy(p, ctx, st, sites);
        const db = fromDb.has(st.id);
        checked++;
        if (ts !== db) mismatches.push(`${key}(${p.rowRule}) × ${st.id}：TS=${ts} DB=${db}`);
      }
    }
    expect(checked).toBe(loaded.length * studies.length);
    expect(mismatches, `${mismatches.length} 处不一致`).toEqual([]);
  });

  it("每个账号：studyScopeSql 注入的范围 === 数据库 study_scope", async () => {
    const mismatches: string[] = [];
    for (const { key, p } of loaded) {
      const viaSql = await sqlStudies(p);
      const viaRls = await dbStudies(p.accountId);
      const only = (a: Set<string>, b: Set<string>) => [...a].filter(x => !b.has(x));
      if (only(viaSql, viaRls).length || only(viaRls, viaSql).length)
        mismatches.push(`${key}：SQL ${viaSql.size} 个 vs RLS ${viaRls.size} 个`);
    }
    expect(mismatches).toEqual([]);
  });

  it("没有中心的项目：all 看得见，承接它的组看得见，其余看不见", async () => {
    const 无中心 = studies.find(st => !sites.some(s => s.studyId === st.id))!;
    const 看得见 = new Set<string>();
    for (const { p } of loaded)
      if ((await dbStudies(p.accountId)).has(无中心.id)) 看得见.add(p.rowRule);

    /* all 必须在里面 —— 这正是原来那句 EXISTS 锁掉的人。 */
    expect([...看得见], "row_rule=all 看不到一个没有中心的项目").toContain("all");
    /* team 也必须在里面：可行性调查是在建中心之前做的，而 feas 授予 pm。 */
    expect([...看得见], "承接项目的组看不到自己还没建中心的项目").toContain("team");
    /* 这三条的范围由中心定义，没有中心就确实还轮不到他们。 */
    for (const r of ["assigned", "hospital", "pi"])
      expect([...看得见], `${r} 不该看到一个没有中心的项目`).not.toContain(r);
  });
});
