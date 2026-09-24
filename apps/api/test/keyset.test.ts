import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { boot, resetDb, as, type Caller } from "./harness.js";
import pg from "pg";
import { keysetCond, keysetCol, keysetNext, type Keyset } from "../src/infra/keyset.js";
import { ProblemException } from "../src/infra/problem.js";

/* ════════════════════════════════════════════════════════════════════
   翻页游标（infra/keyset.ts）。

   十一个列表端点曾经按「日期 + id」排序、却拿 `id < 末行 id` 翻页 ——
   第二页漏行又重复，而只取一页的调用方永远看不出来。
   下面先钉住那个小函数，再把十一个端点逐一翻一遍：
   **逐页翻出来的，必须和一次取出来的一模一样。**
   ════════════════════════════════════════════════════════════════════ */

describe("keysetCond", () => {
  const params: unknown[] = [];
  const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const K = (dir: "asc" | "desc", idDir: "asc" | "desc", type: Keyset["type"] = "date"): Keyset =>
    ({ key: "x.d", type, dir, idDir, id: "x.id" });
  const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

  it("同向：一个行比较", () => {
    params.length = 0;
    expect(keysetCond(K("desc", "desc"), `2026-09-01|${ID}`, add))
      .toBe("(x.d, x.id) < ($1::date, $2::uuid)");
    expect(params).toEqual(["2026-09-01", ID]);
    expect(keysetCond(K("asc", "asc"), `2026-09-01|${ID}`, add))
      .toBe("(x.d, x.id) > ($3::date, $4::uuid)");
  });

  it("反向：拼不成行比较，拆成「范围 + 同键时比 id」", () => {
    params.length = 0;
    expect(keysetCond(K("asc", "desc"), `2026-09-01|${ID}`, add))
      .toBe("(x.d >= $1::date AND (x.d > $1::date OR x.id < $2::uuid))");
  });

  it("认不出来的游标是 422 —— 旧格式（裸 id）也在内", () => {
    for (const bad of [ID, "2026-09-01", `2026-9-1|${ID}`, `2026-09-01|nope`,
                       `2026-09-24 05:00:00+00|${ID}`]) {
      expect(() => keysetCond(K("desc", "desc"), bad, add), bad).toThrow(ProblemException);
    }
    expect(() => keysetCond(K("desc", "desc", "timestamptz"),
      `2026-09-24T05:00:00.000000Z|${ID}`, add)).not.toThrow();
    expect(() => keysetCond(K("desc", "desc", "timestamptz"),
      `2026-09-24 05:00:00+00|${ID}`, add), "带 + 的形式进了 URL 会变成空格").toThrow();
  });

  it("时间戳取固定的 UTC 形式，微秒都在", () => {
    expect(keysetCol(K("desc", "desc", "timestamptz"))).toContain(`HH24:MI:SS.US"Z"`);
    expect(keysetCol(K("desc", "desc"))).toBe("(x.d)::text AS cursor_key");
  });

  it("下一页游标取第 limit 行，不是第 limit + 1 行", () => {
    const rows = [1, 2, 3].map(n => ({ cursor_key: `2026-09-0${n}`, id: `id${n}` }));
    expect(keysetNext(rows, 2)).toBe("2026-09-02|id2");
    expect(keysetNext(rows, 3)).toBeNull();
  });
});

let app: INestApplication;
let boss: Caller;

/* 种子里这几张表大多只有 0～2 行，翻不出第二页。补到每张十几行，而且
   **同一天的补一批** —— 排序键相同、只靠 id 定序，正是旧游标出错的地方。
   从已有的行复制必填列，枚举与约束都现成是对的。
   按中心取的三本台账从 SS-01 自己的行复制 —— 下面翻的就是 SS-01。 */
const FILL = [
  `INSERT INTO specimen (tenant_id, study_site_id, subject_ref, kind, collected_on)
   SELECT tenant_id, study_site_id, subject_ref, kind, collected_on
     FROM specimen, generate_series(1, 12) WHERE id = (SELECT min(x.id::text)::uuid FROM specimen x
                    JOIN study_site ss ON ss.id = x.study_site_id WHERE ss.code = 'SS-01')`,
  `INSERT INTO ip_movement (tenant_id, study_site_id, kind, quantity, moved_on)
   SELECT tenant_id, study_site_id, kind, quantity, moved_on
     FROM ip_movement, generate_series(1, 12) WHERE id = (SELECT min(x.id::text)::uuid FROM ip_movement x
                    JOIN study_site ss ON ss.id = x.study_site_id WHERE ss.code = 'SS-01')`,
  `INSERT INTO regulatory_submission (tenant_id, study_site_id, kind, submitted_on)
   SELECT tenant_id, study_site_id, kind, submitted_on
     FROM regulatory_submission, generate_series(1, 12)
    WHERE id = (SELECT min(x.id::text)::uuid FROM regulatory_submission x
                    JOIN study_site ss ON ss.id = x.study_site_id WHERE ss.code = 'SS-01')`,
  /* 交接单看不看得见取决于它挂在哪些中心上（handover_site），连同那几行一起复制 */
  `WITH src AS (SELECT * FROM handover WHERE id = (SELECT min(id::text)::uuid FROM handover)),
        ins AS (INSERT INTO handover (tenant_id, from_account_id, to_account_id, reason, planned_on)
                SELECT tenant_id, from_account_id, to_account_id, reason, planned_on
                  FROM src, generate_series(1, 12) RETURNING id)
   INSERT INTO handover_site (handover_id, study_site_id)
   SELECT ins.id, hs.study_site_id FROM ins, handover_site hs
    WHERE hs.handover_id = (SELECT id FROM src)`,
  `INSERT INTO site_acceptance (tenant_id, code, study_id, hospital, study_code, drug,
                                sponsor_name, phase, submitted_by, submitted_on)
   SELECT tenant_id, code || '-K' || g, study_id, hospital || ' 分院 ' || g, study_code, drug,
          sponsor_name, phase, submitted_by, submitted_on
     FROM site_acceptance, generate_series(1, 12) g
    WHERE id = (SELECT min(id::text)::uuid FROM site_acceptance)`,
  `INSERT INTO intake_application (tenant_id, code, drug, sponsor_name, phase, indication,
     planned_sites, planned_subjects, enroll_months, contract_cents, estimated_cost_cents,
     submitted_by, submitted_on)
   SELECT tenant_id, code || '-K' || g, drug, sponsor_name, phase, indication,
     planned_sites, planned_subjects, enroll_months, contract_cents, estimated_cost_cents,
     submitted_by, submitted_on
     FROM intake_application, generate_series(1, 12) g
    WHERE id = (SELECT min(id::text)::uuid FROM intake_application)`,
  `INSERT INTO subject_payment (tenant_id, study_site_id, subject_id, amount_cents, due_on)
   SELECT su.tenant_id, su.study_site_id, su.id, 10000, CURRENT_DATE - (g % 3)
     FROM (SELECT * FROM subject ORDER BY id LIMIT 5) su, generate_series(1, 3) g`,
  /* 一条语句里的 now() 是同一个时刻 —— 十二行全部并列，只靠 id 定序 */
  `INSERT INTO audit_entry (tenant_id, actor_login, actor_role_code, action, target_type, target_id)
   SELECT id, 'lingyuan', 'boss', '翻页测试', 'probe', 'K-' || g
     FROM tenant, generate_series(1, 12) g WHERE code = (SELECT code FROM tenant ORDER BY code LIMIT 1)`
];

beforeAll(async () => {
  resetDb();
  const db = new pg.Client({ connectionString: process.env["TEST_DATABASE_URL"] });
  await db.connect();
  try { for (const sql of FILL) await db.query(sql); } finally { await db.end(); }
  app = await boot();
  boss = await as(app, "lingyuan");
}, 180_000);
afterAll(async () => { await app?.close(); });

/** 翻到至多 60 行，与一次取 200 行的前缀逐个比对。
 *  `sameSet`：那一页在自己**页内**又重排了一次（立项申请把越线的排最前），
 *  逐页的顺序与一次取的顺序本来就不同 —— 只比翻完之后是不是同一批、没有重复。 */
async function pagesMatch(base: string, sameSet = false) {
  const sep = base.includes("?") ? "&" : "?";
  const all = await boss.get(`${base}${sep}limit=200`);
  expect(all.status, `${base} 一次取`).toBe(200);
  const want = (all.body.items as { id: string }[]).map(r => r.id);
  expect(want.length, `${base}：种子里不足 3 行，翻不出第二页，这条测不到东西`)
    .toBeGreaterThanOrEqual(3);
  const limit = Math.max(1, Math.min(7, Math.floor(want.length / 3)));

  const got: string[] = [];
  let cursor: string | null = null;
  while (got.length < 60) {
    const r = await boss.get(`${base}${sep}limit=${limit}` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""));
    expect(r.status, `${base} 翻页`).toBe(200);
    got.push(...(r.body.items as { id: string }[]).map(x => x.id));
    cursor = r.body.nextCursor;
    if (!cursor) break;
  }
  expect(new Set(got).size, `${base}：翻出了重复的行`).toBe(got.length);
  if (sameSet) {
    expect(cursor, `${base}：sameSet 要求翻到底`).toBeNull();
    expect([...got].sort(), `${base}：逐页翻完与一次取的不是同一批`).toEqual([...want].sort());
  } else {
    expect(got, `${base}：逐页与一次取的不一致`).toEqual(want.slice(0, got.length));
  }
}

describe("逐页翻完 = 一次取完", () => {
  let site = "";
  beforeAll(async () => {
    const r = await boss.get(`/v1/study-sites?limit=200&q=SS-01`);
    site = r.body.items.find((s: { code: string }) => s.code === "SS-01").id;
  });

  for (const path of [
    "/v1/subject-visits", "/v1/quality-events", "/v1/subject-payments",
    "/v1/handovers", "/v1/site-acceptances", "/v1/audit-entries", "/v1/timesheets"
  ]) it(path, () => pagesMatch(path));

  it("/v1/intake-applications（页内重排）", () => pagesMatch("/v1/intake-applications", true));

  for (const sub of ["ip-movements", "specimens", "regulatory-submissions"])
    it(`/v1/study-sites/SS-01/${sub}`, () => pagesMatch(`/v1/study-sites/${site}/${sub}`));
});
