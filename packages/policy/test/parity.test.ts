import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import {
  canSeeSite, visibleSites, siteScopeSql,
  type Principal, type ScopeContext, type SiteFacts, type RowRule, type ActionKey
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
let principals: Map<string, { p: Principal; ctx: ScopeContext }>;
let sites: SiteFacts[];

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

  principals = new Map();
  for (const a of accounts.rows) {
    principals.set(a.login, {
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
});
afterAll(async () => { await owner.end(); await app.end(); });

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

describe("行范围：三处实现必须逐一致", () => {
  it("覆盖了全部六条规则 —— 否则等价性只证明了一部分", async () => {
    const rules = new Set([...principals.values()].map(x => x.p.rowRule));
    expect([...rules].sort()).toEqual(["all", "assigned", "hospital", "pi", "team"]);
    /* none 没有账号使用，单独构造验证 */
    const fake: Principal = { ...[...principals.values()][0]!.p, rowRule: "none" };
    expect(visibleSites(fake, {
      assignedSiteIds: new Set(), teamStudyIds: new Set(), handoverSiteIds: new Set()
    }, sites)).toEqual([]);
  });

  it("每个账号 × 每个中心：TS 判定 === 数据库 RLS 判定", async () => {
    const mismatches: string[] = [];
    let checked = 0;
    for (const [login, { p, ctx }] of principals) {
      const fromDb = await dbVisible(p.accountId);
      for (const site of sites) {
        const ts = canSeeSite(p, ctx, site);
        const db = fromDb.has(site.id);
        checked++;
        if (ts !== db)
          mismatches.push(`${login}(${p.rowRule}) × ${site.id}：TS=${ts} DB=${db}`);
      }
    }
    expect(checked).toBe(principals.size * sites.length);
    expect(mismatches, `${mismatches.length} 处不一致 —— 每一处都是潜在泄漏`).toEqual([]);
  });

  it("每个账号：siteScopeSql 注入的范围 === 数据库 RLS 判定", async () => {
    const mismatches: string[] = [];
    for (const [login, { p }] of principals) {
      const viaSql = await sqlVisible(p);
      const viaRls = await dbVisible(p.accountId);
      const only = (a: Set<string>, b: Set<string>) => [...a].filter(x => !b.has(x));
      if (only(viaSql, viaRls).length || only(viaRls, viaSql).length)
        mismatches.push(`${login}：SQL ${viaSql.size} 个 vs RLS ${viaRls.size} 个`);
    }
    expect(mismatches).toEqual([]);
  });

  it("停用账号：三处一致地返回空", async () => {
    const zq = principals.get("zhouqi")!;
    expect(zq.p.active).toBe(false);
    expect(visibleSites(zq.p, zq.ctx, sites)).toEqual([]);
    expect((await dbVisible(zq.p.accountId)).size).toBe(0);
    expect((await sqlVisible(zq.p)).size).toBe(0);
  });

  it("跨租户：即使 rowRule=all 也看不到别家的中心", async () => {
    const boss = principals.get("lingyuan")!;
    const alien: SiteFacts = {
      id: "00000000-0000-0000-0000-0000000000aa",
      tenantId: "00000000-0000-0000-0000-0000000000ff",
      studyId: "00000000-0000-0000-0000-0000000000bb",
      hospital: "他家医院", piAccountId: null
    };
    expect(canSeeSite(boss.p, boss.ctx, alien)).toBe(false);
  });

  it("每条规则至少有一个账号看到的不是全集，也不是空集 —— 否则等价性可能是巧合", () => {
    const bySize = new Map<string, number[]>();
    for (const { p, ctx } of principals.values()) {
      if (!p.active) continue;
      const n = visibleSites(p, ctx, sites).length;
      bySize.set(p.rowRule, [...(bySize.get(p.rowRule) ?? []), n]);
    }
    expect(bySize.get("team")!.every(n => n > 0 && n < sites.length)).toBe(true);
    expect(bySize.get("assigned")!.every(n => n > 0 && n < sites.length)).toBe(true);
    expect(bySize.get("hospital")!.every(n => n > 0 && n < sites.length)).toBe(true);
    expect(bySize.get("pi")!.every(n => n > 0 && n < sites.length)).toBe(true);
    expect(bySize.get("all")!.every(n => n === sites.length)).toBe(true);
  });
});
