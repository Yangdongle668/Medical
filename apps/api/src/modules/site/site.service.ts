import { Injectable } from "@nestjs/common";
import { siteScopeSql } from "@sitedesk/policy";
import { ctx, principal } from "../../infra/ctx.js";
import { ProblemException, notFound } from "../../infra/problem.js";
import { AuditService } from "../../infra/audit.service.js";
import { evaluateGate, nextState } from "./gate.js";

/** 「事后失效」的判定式：已过 SIV，却还挂着未完成的阻塞项。
 *
 *  **算出来，不存**。存一个布尔位就要在两个地方维护它
 *  （撤销时置位、补做完时清位），而漏掉任何一处，台账上就是一个假账 ——
 *  假的"没问题"比没有这一栏更糟。这里多一次 EXISTS 子查询，
 *  换的是"它永远等于事实"。
 *
 *  注意 `EXISTS` 不受列权限影响，也不需要额外的 RLS：
 *  startup_item 的策略跟着 study_site 走，看不见中心就看不见它的清单项。 */
const INVALIDATED = `(
  s.state IN ('siv','enrolling','enrolled','followup','closed')
  AND EXISTS (SELECT 1 FROM startup_item i
               WHERE i.study_site_id = s.id AND i.is_blocking AND i.done_at IS NULL)
)`;

const SITE_COLS = `
  s.id, s.code, s.hospital, s.dept, s.city, s.pi_name, s.pi_account_id, s.state,
  s.contracted, s.unit_price_cents, s.startup_fee_cents,
  s.irb_approved_on, s.siv_on, s.siv_planned_on, s.fpi_on,
  ${INVALIDATED} AS startup_invalidated, s.startup_template_version,
  st.id AS study_uid, st.code AS study_code, st.short_name AS study_short`;

interface SiteRow {
  id: string; code: string; hospital: string; dept: string; city: string;
  pi_name: string; pi_account_id: string | null; state: string; contracted: number;
  unit_price_cents: number; startup_fee_cents: number;
  irb_approved_on: Date | null; siv_on: Date | null;
  siv_planned_on: Date | null; fpi_on: Date | null;
  startup_invalidated: boolean; startup_template_version: number | null;
  study_uid: string; study_code: string; study_short: string;
}
const d = (v: Date | null) => v ? v.toISOString().slice(0, 10) : null;
const toSite = (r: SiteRow) => ({
  id: r.id, code: r.code,
  study: { id: r.study_uid, code: r.study_code, shortName: r.study_short },
  hospital: r.hospital, dept: r.dept, city: r.city,
  piName: r.pi_name, piAccountId: r.pi_account_id,
  state: r.state, contracted: r.contracted,
  unitPriceCents: r.unit_price_cents, startupFeeCents: r.startup_fee_cents,
  irbApprovedOn: d(r.irb_approved_on), sivOn: d(r.siv_on),
  sivPlannedOn: d(r.siv_planned_on), fpiOn: d(r.fpi_on),
  startupInvalidated: r.startup_invalidated,
  startupTemplateVersion: r.startup_template_version
});

@Injectable()
export class SiteService {
  constructor(private readonly audit: AuditService) {}

  /** 范围注入走 policy —— RLS 是兜底，不是唯一防线。
   *  两处都在，才能同时防住「应用层忘了加条件」和「有人写了裸 SQL」。 */
  private scope(start = 1) { return siteScopeSql(principal(), "s", start); }

  async listStudies(limit: number, cursor?: string) {
    const c = ctx();
    const sc = this.scope(1);
    const params: unknown[] = [...sc.params];
    let where = `EXISTS (SELECT 1 FROM study_site s WHERE s.study_id = st.id AND ${sc.sql})`;
    if (cursor) { params.push(cursor); where += ` AND st.code > $${params.length}`; }
    params.push(limit + 1);
    const { rows } = await c.client.query<Record<string, never> & {
      id: string; code: string; short_name: string; sponsor_name: string; phase: string;
      indication: string; planned_subjects: number; contract_amount_cents: number;
      started_on: Date | null; ends_on: Date | null;
      /* sponsorName 从 client join 出来 —— 0031 把 study.sponsor_name
         换成了 client_id（0004 的注释预告过这一步）。
         契约里那一栏没变：它是**显示名**，只是现在只有一个来源了。 */
    }>(`SELECT st.*, cl.name AS sponsor_name
          FROM study st JOIN client cl ON cl.id = st.client_id
         WHERE ${where} ORDER BY st.code LIMIT $${params.length}`, params);
    const items = rows.slice(0, limit).map(r => ({
      id: r.id, code: r.code, shortName: r.short_name, sponsorName: r.sponsor_name,
      phase: r.phase, indication: r.indication, plannedSubjects: r.planned_subjects,
      contractAmountCents: r.contract_amount_cents,
      startedOn: d(r.started_on), endsOn: d(r.ends_on)
    }));
    return { items, nextCursor: rows.length > limit ? items.at(-1)!.code : null };
  }

  async list(q: { limit: number; cursor?: string; studyId?: string; state?: string[];
                  hospital?: string; q?: string; startupInvalidated?: boolean }) {
    const c = ctx();
    const sc = this.scope(1);
    const params: unknown[] = [...sc.params];
    const conds = [sc.sql];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    if (q.studyId)  conds.push(`s.study_id = ${add(q.studyId)}`);
    if (q.state?.length) conds.push(`s.state = ANY(${add(q.state)})`);
    if (q.hospital) conds.push(`s.hospital = ${add(q.hospital)}`);
    if (q.q)        conds.push(`(s.hospital ILIKE ${add("%" + q.q + "%")} OR s.code ILIKE $${params.length})`);
    /* 只在**显式传了**的时候加条件：传 false 是"只看正常的"，
       不传是"两种都要" —— 三态，不是布尔。 */
    if (q.startupInvalidated !== undefined)
      conds.push(q.startupInvalidated ? INVALIDATED : `NOT ${INVALIDATED}`);
    if (q.cursor)   conds.push(`s.code > ${add(q.cursor)}`);
    const { rows } = await c.client.query<SiteRow>(
      `SELECT ${SITE_COLS} FROM study_site s JOIN study st ON st.id = s.study_id
        WHERE ${conds.join(" AND ")} ORDER BY s.code LIMIT ${add(q.limit + 1)}`, params);
    const items = rows.slice(0, q.limit).map(toSite);
    return { items, nextCursor: rows.length > q.limit ? items.at(-1)!.code : null };
  }

  async get(id: string) {
    const c = ctx();
    const sc = this.scope(2);
    const { rows } = await c.client.query<SiteRow>(
      `SELECT ${SITE_COLS} FROM study_site s JOIN study st ON st.id = s.study_id
        WHERE s.id = $1 AND ${sc.sql}`, [id, ...sc.params]);
    /* 范围外与不存在返回同一个 404 —— 区分开就是在确认「它存在」 */
    if (!rows[0]) throw notFound("中心");
    return toSite(rows[0]);
  }

  async create(body: {
    studyId: string; code: string; hospital: string; dept: string; city: string;
    piName: string; piAccountId?: string | null; contracted: number;
    unitPriceCents: number; startupFeeCents?: number; sivPlannedOn?: string | null;
  }) {
    const c = ctx();
    const { rows } = await c.client.query<{ id: string }>(
      `INSERT INTO study_site (study_id, code, hospital, dept, city, pi_name, pi_account_id,
         contracted, unit_price_cents, startup_fee_cents, siv_planned_on)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [body.studyId, body.code, body.hospital, body.dept, body.city, body.piName,
       body.piAccountId ?? null, body.contracted, body.unitPriceCents,
       body.startupFeeCents ?? 0, body.sivPlannedOn ?? null]);
    const id = rows[0]!.id;

    /* 建档即铺开标准启动清单。不铺开的话，SIV 闸门查的「阻塞项清零」
       对每一个新中心天然成立 —— 闸门看着在把关，实际全部放行。

       清单**在这一刻从模板铺开成行**，此后与模板再无关系（欠账 D1）：
       模板改版不回溯在途中心。一个已经做到第 12 项的中心，模板改一次
       就多出三项从来没人见过的阻塞 —— 没有人会认为那是"配置生效了"。
       盖一个版本号的戳，答"它是照着哪一版来的"。 */
    const tpl = await c.client.query<{ n: string; version: number }>(
      `WITH v AS (SELECT app.startup_template_version() AS version),
       ins AS (
         INSERT INTO startup_item (study_site_id, category, item, is_blocking, sort_order, due_on)
         SELECT $1, t.category, t.item, t.is_blocking, t.sort_order,
                CASE WHEN $2::date IS NULL THEN NULL ELSE $2::date + t.due_offset END
           FROM startup_template_item t, v
          WHERE t.version = v.version
          RETURNING 1)
       SELECT (SELECT count(*) FROM ins) AS n, (SELECT version FROM v) AS version`,
      [id, body.sivPlannedOn ?? null]);
    const { n, version } = tpl.rows[0]!;

    /* 模板是空的 = 每个新中心都直接过闸门。这不是"没配置"，是闸门失效，
       而它的表现是"一切正常"—— 所以在这里拦下，不留给运行时去发现。 */
    if (Number(n) === 0)
      throw new ProblemException("invariant-violated", {
        invariant: "startup-template-empty",
        detail: "启动清单模板是空的 —— 这样建出来的中心会直接通过 SIV 闸门。" +
          "先发布一版模板（POST /v1/startup-template:replace）再建档。" });

    await c.client.query(
      "UPDATE study_site SET startup_template_version = $2 WHERE id = $1", [id, version]);

    await this.audit.write({ action: "中心建档", targetType: "study_site", targetId: body.code,
      after: { code: body.code, hospital: body.hospital,
               startupItems: Number(n), startupTemplateVersion: version },
      studySiteId: id });
    return this.get(id);
  }

  /* ── 启动清单模板（欠账 D1） ──────────────────────────────────────
     它决定每个**新**中心怎么启动。三个当初拦住这件事的问题，
     答案分别落在：`manage` 动作 + 必填原因（谁能改）、
     建档时铺开成行（在途中心不受影响）、版本号只增不改（追溯）。 */

  async startupTemplate() {
    const c = ctx();
    const { rows } = await c.client.query<{
      version: number; sort_order: number; category: string; item: string;
      is_blocking: boolean; due_offset: number;
      created_at: Date; created_by_name: string | null; reason: string | null;
    }>(`SELECT t.version, t.sort_order, t.category, t.item, t.is_blocking, t.due_offset,
               t.created_at, a.display_name AS created_by_name, t.reason
          FROM startup_template_item t
          LEFT JOIN account a ON a.id = t.created_by
         WHERE t.version = app.startup_template_version()
         ORDER BY t.sort_order`);
    const head = rows[0];
    return {
      version: head?.version ?? 0,
      items: rows.map(r => ({
        sortOrder: r.sort_order, category: r.category, item: r.item,
        isBlocking: r.is_blocking, dueOffset: r.due_offset
      })),
      updatedAt: head ? head.created_at.toISOString() : null,
      updatedByName: head?.created_by_name ?? null,
      reason: head?.reason ?? null
    };
  }

  async replaceStartupTemplate(b: {
    items: { sortOrder: number; category: string; item: string;
             isBlocking: boolean; dueOffset: number }[];
    reason: string;
  }) {
    const c = ctx(), p = principal();

    /* 一份没有任何阻塞项的清单，等于把 SIV 闸门关掉 ——
       而它的表现是"闸门一直放行"，没有人会去查模板。 */
    if (!b.items.some(i => i.isBlocking))
      throw new ProblemException("validation-failed", {
        detail: "模板里一个阻塞项都没有 —— 那样 SIV 闸门对每个新中心都天然成立，" +
          "闸门看着在把关，实际全部放行" });

    /* sortOrder 是主键的一部分：重复会插不进去，而那条报错指不到这里。 */
    const dup = b.items.map(i => i.sortOrder)
      .find((v, i, all) => all.indexOf(v) !== i);
    if (dup !== undefined)
      throw new ProblemException("validation-failed", {
        detail: `sortOrder ${dup} 出现了两次 —— 它决定清单的显示顺序，不能重复` });

    const { rows: cur } = await c.client.query<{ version: number }>(
      "SELECT app.startup_template_version() AS version");
    const next = (cur[0]?.version ?? 0) + 1;

    await c.client.query(
      `INSERT INTO startup_template_item
         (version, sort_order, category, item, is_blocking, due_offset, created_by, reason)
       SELECT $1, t.sort_order, t.category, t.item, t.is_blocking, t.due_offset, $2, $3
         FROM unnest($4::int[], $5::text[], $6::text[], $7::boolean[], $8::int[])
              AS t(sort_order, category, item, is_blocking, due_offset)`,
      [next, p.accountId, b.reason,
       b.items.map(i => i.sortOrder), b.items.map(i => i.category),
       b.items.map(i => i.item), b.items.map(i => i.isBlocking),
       b.items.map(i => i.dueOffset)]);

    await this.audit.write({
      action: "发布启动清单模板", targetType: "startup_template", targetId: `v${next}`,
      before: { version: cur[0]?.version ?? 0 },
      after: { version: next, items: b.items.length,
               blocking: b.items.filter(i => i.isBlocking).length },
      reason: b.reason });

    return {
      data: await this.startupTemplate(),
      sideEffects: [{
        type: "StartupTemplateReplaced",
        summary: `已发布第 ${next} 版启动清单模板（${b.items.length} 项，` +
          `${b.items.filter(i => i.isBlocking).length} 项阻塞）——` +
          "**只对此后建档的中心生效**，在途中心的清单不变"
      }]
    };
  }

  async gate(id: string, to?: string) {
    const c = ctx();
    const site = await this.get(id);
    const target = to ?? await nextState(c.client, site.state);
    if (!target) throw new ProblemException("validation-failed", {
      detail: `「${site.state}」已是状态机的最后一个节点` });
    const g = await evaluateGate(c.client, id, target);
    return {
      from: site.state, to: target, satisfied: g.satisfied,
      unmet: g.items.filter(i => i.status !== "ok")
        .map(i => ({ code: i.code, message: i.message, ...(i.module ? { module: i.module } : {}) }))
    };
  }

  async advance(id: string, to: string, reason?: string) {
    const c = ctx();
    const before = await this.get(id);
    const expected = await nextState(c.client, before.state);
    if (to !== expected) throw new ProblemException("validation-failed", {
      detail: `只能推进到状态机的下一节点：${before.state} → ${expected ?? "（无）"}` });

    const g = await evaluateGate(c.client, id, to);
    if (!g.satisfied) throw new ProblemException("gate-not-satisfied", {
      detail: `不能推进到「${to}」：还有 ${g.items.filter(i => i.status !== "ok").length} 项前置条件未满足`,
      unmet: g.items.filter(i => i.status !== "ok").map(i => ({
        code: i.code, message: i.message, ...(i.module ? { module: i.module } : {}) })) });

    await c.client.query(
      `UPDATE study_site SET state = $2${to === "siv" ? ", siv_on = coalesce(siv_on, CURRENT_DATE)" : ""}${
        to === "enrolling" ? ", fpi_on = coalesce(fpi_on, CURRENT_DATE)" : ""} WHERE id = $1`,
      [id, to]);
    await this.audit.write({
      action: "推进中心阶段", targetType: "study_site", targetId: before.code,
      before: { state: before.state }, after: { state: to },
      studySiteId: id, reason: reason ?? null });

    const after = await this.get(id);
    return {
      data: after,
      sideEffects: [{
        type: "SiteStateChanged" as const,
        summary: `${after.hospital} 状态由「${before.state}」推进至「${to}」`,
        ref: id, studySiteId: id
      }]
    };
  }
}
