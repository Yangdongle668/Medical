import { Injectable } from "@nestjs/common";
import { siteScopeSql } from "@sitedesk/policy";
import { ctx, principal } from "../../infra/ctx.js";
import { ProblemException, notFound } from "../../infra/problem.js";
import { AuditService } from "../../infra/audit.service.js";
import { evaluateGate, nextState } from "./gate.js";

const SITE_COLS = `
  s.id, s.code, s.hospital, s.dept, s.city, s.pi_name, s.pi_account_id, s.state,
  s.contracted, s.unit_price_cents, s.startup_fee_cents,
  s.irb_approved_on, s.siv_on, s.siv_planned_on, s.fpi_on,
  st.id AS study_uid, st.code AS study_code, st.short_name AS study_short`;

interface SiteRow {
  id: string; code: string; hospital: string; dept: string; city: string;
  pi_name: string; pi_account_id: string | null; state: string; contracted: number;
  unit_price_cents: number; startup_fee_cents: number;
  irb_approved_on: Date | null; siv_on: Date | null;
  siv_planned_on: Date | null; fpi_on: Date | null;
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
  sivPlannedOn: d(r.siv_planned_on), fpiOn: d(r.fpi_on)
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
    }>(`SELECT st.* FROM study st WHERE ${where} ORDER BY st.code LIMIT $${params.length}`, params);
    const items = rows.slice(0, limit).map(r => ({
      id: r.id, code: r.code, shortName: r.short_name, sponsorName: r.sponsor_name,
      phase: r.phase, indication: r.indication, plannedSubjects: r.planned_subjects,
      contractAmountCents: r.contract_amount_cents,
      startedOn: d(r.started_on), endsOn: d(r.ends_on)
    }));
    return { items, nextCursor: rows.length > limit ? items.at(-1)!.code : null };
  }

  async list(q: { limit: number; cursor?: string; studyId?: string; state?: string[]; hospital?: string; q?: string }) {
    const c = ctx();
    const sc = this.scope(1);
    const params: unknown[] = [...sc.params];
    const conds = [sc.sql];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    if (q.studyId)  conds.push(`s.study_id = ${add(q.studyId)}`);
    if (q.state?.length) conds.push(`s.state = ANY(${add(q.state)})`);
    if (q.hospital) conds.push(`s.hospital = ${add(q.hospital)}`);
    if (q.q)        conds.push(`(s.hospital ILIKE ${add("%" + q.q + "%")} OR s.code ILIKE $${params.length})`);
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
    await this.audit.write({ action: "中心建档", targetType: "study_site", targetId: body.code,
      after: { code: body.code, hospital: body.hospital }, studySiteId: id });
    return this.get(id);
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
