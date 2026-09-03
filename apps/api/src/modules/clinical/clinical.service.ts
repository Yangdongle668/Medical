import { Inject, Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";
import { ctx, principal } from "../../infra/ctx.js";
import { siteScopeSql } from "@sitedesk/policy";
import { ProblemException, notFound } from "../../infra/problem.js";
import { AuditService } from "../../infra/audit.service.js";
import { pendingSubscribers } from "./visit-completed.js";
import { VISIT_TIMESHEET_PORT, type VisitTimesheetPort } from "./ports.js";
import { saeReportHours, saeTimeliness, saeStatus, SAE_REPORT_DEADLINE_HOURS, CALC_VERSION }
  from "@sitedesk/calc";

/* ════════════════════════════════════════════════════════════════════
   ClinicalOps —— 受试者与访视。

   这一层要守住的，是三条不能被绕过的不变量：
     I3  访视必须经 PI 确认才锁定；未确认的不计入「已完成」
     I4  超窗**必须**生成方案偏离，且与访视完成在同一个事务里
     I10 返回受试者明细的每一次调用都写审计
   ════════════════════════════════════════════════════════════════════ */

const day = (v: Date | null) => v ? v.toISOString().slice(0, 10) : null;
const iso = (v: Date | null) => v ? v.toISOString() : null;
const between = (a: Date | string, b: Date | string) =>
  Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000);
const todayStr = () => new Date().toISOString().slice(0, 10);

/** 副作用信封。type 是契约的一部分，summary 前端直接展示。 */
interface Effect {
  type: string; summary: string;
  ref?: string; amountCents?: number; studySiteId?: string;
}

interface SubjectRow {
  id: string; study_site_id: string; site_code: string;
  screening_no: string; randomization_no: string | null; state: string;
  icf_signed_on: Date | null; enrolled_on: Date | null; exited_on: Date | null;
  screen_fail_reason: string | null; withdraw_reason: string | null;
  crc_name: string | null;
  visits_done: string; visits_planned: string;
  nv_id: string | null; nv_seq: number | null; nv_code: string | null;
  nv_label: string | null; nv_target: Date | null;
  nv_from: Date | null; nv_to: Date | null;
}

const SUBJECT_COLS = `
  su.id, su.study_site_id, s.code AS site_code, su.screening_no, su.randomization_no,
  su.state, su.icf_signed_on, su.enrolled_on, su.exited_on,
  su.screen_fail_reason, su.withdraw_reason, a.display_name AS crc_name,
  (SELECT count(*) FROM subject_visit v
    WHERE v.subject_id = su.id AND v.status = 'locked')          AS visits_done,
  (SELECT count(*) FROM visit_template t WHERE t.study_id = s.study_id) AS visits_planned,
  nv.id AS nv_id, nv.seq AS nv_seq, nv.visit_code AS nv_code,
  nv.visit_label AS nv_label, nv.target_date AS nv_target,
  lower(nv.visit_window) AS nv_from, upper(nv.visit_window) AS nv_to`;

const SUBJECT_FROM = `
  subject su
  JOIN study_site s ON s.id = su.study_site_id
  LEFT JOIN account a ON a.id = su.crc_account_id
  LEFT JOIN LATERAL (
    SELECT v.* FROM subject_visit v
     WHERE v.subject_id = su.id AND v.status = 'planned'
     ORDER BY v.seq LIMIT 1) nv ON true`;

function toSubject(r: SubjectRow) {
  const today = todayStr();
  return {
    id: r.id, studySiteId: r.study_site_id, siteCode: r.site_code,
    screeningNo: r.screening_no,
    randomized: r.randomization_no !== null,
    ...(r.randomization_no !== null ? { randomizationNo: r.randomization_no } : {}),
    state: r.state,
    icfSignedOn: day(r.icf_signed_on), enrolledOn: day(r.enrolled_on),
    exitedOn: day(r.exited_on),
    screenFailReason: r.screen_fail_reason, withdrawReason: r.withdraw_reason,
    crcName: r.crc_name,
    visitsDone: Number(r.visits_done), visitsPlanned: Number(r.visits_planned),
    nextVisit: r.nv_id ? {
      id: r.nv_id, seq: r.nv_seq!, visitCode: r.nv_code!, visitLabel: r.nv_label!,
      targetDate: day(r.nv_target)!, windowFrom: day(r.nv_from)!, windowTo: day(r.nv_to)!,
      daysLeft: between(today, day(r.nv_to)!),
      outOfWindow: between(today, day(r.nv_to)!) < 0
    } : null
  };
}

interface VisitRow {
  id: string; subject_id: string; screening_no: string;
  study_site_id: string; site_code: string; seq: number;
  visit_code: string; visit_label: string; target_date: Date;
  window_days: number; win_from: Date; win_to: Date;
  actual_date: Date | null; status: string; edc_status: string;
  edc_entered_on: Date | null; out_of_window: boolean;
  pi_confirmed_at: Date | null; pi_name: string | null;
}
const VISIT_COLS = `
  v.id, v.subject_id, su.screening_no, v.study_site_id, s.code AS site_code, v.seq,
  v.visit_code, v.visit_label, v.target_date, v.window_days,
  lower(v.visit_window) AS win_from, upper(v.visit_window) AS win_to,
  v.actual_date, v.status, v.edc_status, v.edc_entered_on, v.out_of_window,
  v.pi_confirmed_at, p.display_name AS pi_name`;
const VISIT_FROM = `
  subject_visit v
  JOIN subject su ON su.id = v.subject_id
  JOIN study_site s ON s.id = v.study_site_id
  LEFT JOIN account p ON p.id = v.pi_confirmed_by`;

/** EDC 录入及时线：访视完成后 5 个工作日。周末不算 —— 现实里没人周末录 EDC。 */
function workdaysBetween(from: string, to: string): number {
  let n = 0;
  const a = new Date(from), b = new Date(to);
  for (const dte = new Date(a); dte < b; dte.setDate(dte.getDate() + 1)) {
    const w = dte.getDay();
    if (w !== 0 && w !== 6) n++;
  }
  return n;
}
const EDC_SLA_WORKDAYS = 5;

function toVisit(r: VisitRow) {
  const today = todayStr();
  const done = r.actual_date !== null;
  const lag = r.edc_status === "entered" || !done ? null
    : workdaysBetween(day(r.actual_date)!, today);
  return {
    id: r.id, subjectId: r.subject_id, screeningNo: r.screening_no,
    studySiteId: r.study_site_id, siteCode: r.site_code, seq: r.seq,
    visitCode: r.visit_code, visitLabel: r.visit_label,
    targetDate: day(r.target_date)!, windowDays: r.window_days,
    windowFrom: day(r.win_from)!, windowTo: day(r.win_to)!,
    actualDate: day(r.actual_date), status: r.status, edcStatus: r.edc_status,
    edcDaysLate: lag !== null && lag > EDC_SLA_WORKDAYS ? lag - EDC_SLA_WORKDAYS : null,
    /* 未完成而窗口已关闭，同样是超窗 —— 只看 out_of_window 会漏掉「还没做」的那一类 */
    outOfWindow: r.out_of_window || (!done && between(today, day(r.win_to)!) < 0),
    daysLeft: done ? null : between(today, day(r.win_to)!),
    piConfirmedAt: iso(r.pi_confirmed_at), piConfirmedByName: r.pi_name,
    tasks: [] as { seq: number; task: string; doneAt: string | null }[]
  };
}

@Injectable()
export class ClinicalService {
  constructor(
    private readonly audit: AuditService,
    /* 只认接口，不认实现 —— 装配在 app.module 里完成，见 ports.ts */
    @Inject(VISIT_TIMESHEET_PORT) private readonly timesheet: VisitTimesheetPort
  ) {}

  /* ── 读 ─────────────────────────────────────────────────────────── */

  async listSubjects(q: {
    limit: number; cursor?: string; studySiteId?: string;
    state?: string[]; outOfWindow?: boolean; q?: string;
  }) {
    const c = ctx();
    const params: unknown[] = [];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const conds = ["true"];
    if (q.studySiteId) conds.push(`su.study_site_id = ${add(q.studySiteId)}`);
    if (q.state?.length) conds.push(`su.state = ANY(${add(q.state)})`);
    if (q.q) conds.push(`su.screening_no ILIKE ${add("%" + q.q + "%")}`);
    if (q.outOfWindow) conds.push(`nv.id IS NOT NULL AND upper(nv.visit_window) < CURRENT_DATE`);
    if (q.cursor) conds.push(`su.id < ${add(q.cursor)}`);

    const { rows } = await c.client.query<SubjectRow>(
      `SELECT ${SUBJECT_COLS} FROM ${SUBJECT_FROM}
        WHERE ${conds.join(" AND ")}
        ORDER BY su.id DESC LIMIT ${add(q.limit + 1)}`, params);

    const items = rows.slice(0, q.limit).map(toSubject);
    /* I10：返回明细就要留痕，且记下这次到底看了多少条、什么范围 */
    await this.audit.write({
      action: "查询受试者明细", targetType: "subject",
      targetId: q.studySiteId ?? "（全部可见中心）",
      after: { count: items.length, state: q.state ?? null, q: q.q ?? null },
      studySiteId: q.studySiteId ?? null
    });
    return { items, nextCursor: rows.length > q.limit ? items.at(-1)?.id ?? null : null };
  }

  async getSubject(id: string) {
    const c = ctx();
    const { rows } = await c.client.query<SubjectRow>(
      `SELECT ${SUBJECT_COLS} FROM ${SUBJECT_FROM} WHERE su.id = $1`, [id]);
    if (!rows[0]) throw notFound("受试者");
    await this.audit.write({
      action: "查看受试者", targetType: "subject", targetId: rows[0].screening_no,
      studySiteId: rows[0].study_site_id
    });
    return toSubject(rows[0]);
  }

  /** 漏斗：**只有计数**，因此不需要 subjRead，也不写明细审计（I10）。 */
  async funnel(siteId: string) {
    const c = ctx();
    const site = await c.client.query<{
      id: string; code: string; hospital: string; contracted: number;
    }>(`SELECT id, code, hospital, contracted FROM study_site WHERE id = $1`, [siteId]);
    if (!site.rows[0]) throw notFound("中心");
    const s = site.rows[0];

    const { rows } = await c.client.query<{
      prescreened: string; icf_signed: string; in_screening: string;
      enrolled: string; screen_failed: string; withdrawn: string; completed: string;
    }>(`
      SELECT count(*)                                                   AS prescreened,
             count(*) FILTER (WHERE icf_signed_on IS NOT NULL)          AS icf_signed,
             count(*) FILTER (WHERE state = 'screening')                AS in_screening,
             count(*) FILTER (WHERE state IN ('enrolled','withdrawn','completed'))
                                                                        AS enrolled,
             count(*) FILTER (WHERE state = 'screen_failed')            AS screen_failed,
             count(*) FILTER (WHERE state = 'withdrawn')                AS withdrawn,
             count(*) FILTER (WHERE state = 'completed')                AS completed
        FROM subject WHERE study_site_id = $1`, [siteId]);
    const n = rows[0]!;
    const num = (v: string) => Number(v);
    const pre = num(n.prescreened), icf = num(n.icf_signed), enr = num(n.enrolled),
          sf = num(n.screen_failed), wd = num(n.withdrawn);

    const sfBreak = await c.client.query<{ reason: string; count: string }>(
      /* 第二排序键不是讲究：只按 count DESC 排的话，计数相同的两个原因
         顺序是**随机**的 —— 同一个请求两次可能给出不同的顺序，
         而这两条口径要和 listEnrollment 逐字段对得上。 */
      `SELECT screen_fail_reason AS reason, count(*) AS count FROM subject
        WHERE study_site_id = $1 AND screen_fail_reason IS NOT NULL
        GROUP BY 1 ORDER BY 2 DESC, 1`, [siteId]);
    const wdBreak = await c.client.query<{ reason: string; count: string }>(
      `SELECT withdraw_reason AS reason, count(*) AS count FROM subject
        WHERE study_site_id = $1 AND withdraw_reason IS NOT NULL
        GROUP BY 1 ORDER BY 2 DESC, 1`, [siteId]);

    const ratio = (a: number, b: number) => b > 0 ? a / b : null;
    return {
      studySiteId: s.id, siteCode: s.code, hospital: s.hospital, contracted: s.contracted,
      prescreened: pre, icfSigned: icf, inScreening: num(n.in_screening),
      enrolled: enr, screenFailed: sf, withdrawn: wd, completed: num(n.completed),
      screenFailRate: ratio(sf, icf), icfRate: ratio(icf, pre), yieldRate: ratio(enr, pre),
      retentionRate: ratio(enr - wd, enr),
      screenFailBreakdown: sfBreak.rows.map(r => ({ reason: r.reason, count: Number(r.count) })),
      withdrawBreakdown: wdBreak.rows.map(r => ({ reason: r.reason, count: Number(r.count) })),
      attainment: ratio(enr, s.contracted)
    };
  }

  /** 全部中心的漏斗。**一条查询，不是每个中心一条** ——
   *  客户端 fan-out 是把 N+1 搬到浏览器上，不是消灭它。
   *
   *  拆解（筛败原因、脱落原因）另走一条聚合查询：
   *  把它们塞进上面那条会让每个中心多出几行，分页游标就没法算了。 */
  async listEnrollment(q: {
    limit: number; cursor?: string; studyId?: string; behindOnly?: boolean;
  }) {
    const c = ctx();
    const sc = siteScopeSql(principal(), "s");
    const params: unknown[] = [...sc.params];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const conds = [sc.sql];
    if (q.studyId) conds.push(`s.study_id = ${add(q.studyId)}`);
    if (q.cursor) conds.push(`s.code > ${add(q.cursor)}`);

    const { rows } = await c.client.query<{
      id: string; code: string; hospital: string; contracted: number;
      prescreened: string; icf_signed: string; in_screening: string;
      enrolled: string; screen_failed: string; withdrawn: string; completed: string;
    }>(`
      SELECT s.id, s.code, s.hospital, s.contracted,
             count(j.id)                                                   AS prescreened,
             count(j.id) FILTER (WHERE j.icf_signed_on IS NOT NULL)        AS icf_signed,
             count(j.id) FILTER (WHERE j.state = 'screening')              AS in_screening,
             count(j.id) FILTER (WHERE j.state IN ('enrolled','withdrawn','completed'))
                                                                           AS enrolled,
             count(j.id) FILTER (WHERE j.state = 'screen_failed')          AS screen_failed,
             count(j.id) FILTER (WHERE j.state = 'withdrawn')              AS withdrawn,
             count(j.id) FILTER (WHERE j.state = 'completed')              AS completed
        FROM study_site s LEFT JOIN subject j ON j.study_site_id = s.id
       WHERE ${conds.join(" AND ")}
       GROUP BY s.id, s.code, s.hospital, s.contracted
       ${q.behindOnly
         ? `HAVING count(j.id) FILTER (WHERE j.state IN ('enrolled','withdrawn','completed'))
                  < s.contracted`
         : ""}
       ORDER BY s.code LIMIT ${add(q.limit + 1)}`, params);

    const page = rows.slice(0, q.limit);
    if (!page.length) return { items: [], nextCursor: null };

    const ids = page.map(r => r.id);
    const breakdown = async (col: string) => {
      const { rows: b } = await c.client.query<{
        study_site_id: string; reason: string; count: string;
      }>(`SELECT study_site_id, ${col} AS reason, count(*) AS count FROM subject
           WHERE study_site_id = ANY($1) AND ${col} IS NOT NULL
           GROUP BY 1, 2 ORDER BY 3 DESC, 2`, [ids]);
      const by = new Map<string, { reason: string; count: number }[]>();
      for (const r of b)
        by.set(r.study_site_id,
          [...(by.get(r.study_site_id) ?? []), { reason: r.reason, count: Number(r.count) }]);
      return by;
    };
    const [sfBy, wdBy] = await Promise.all([
      breakdown("screen_fail_reason"), breakdown("withdraw_reason")]);

    const ratio = (a: number, b: number) => b > 0 ? a / b : null;
    const items = page.map(r => {
      const pre = Number(r.prescreened), icf = Number(r.icf_signed),
            enr = Number(r.enrolled), sf = Number(r.screen_failed), wd = Number(r.withdrawn);
      return {
        studySiteId: r.id, siteCode: r.code, hospital: r.hospital, contracted: r.contracted,
        prescreened: pre, icfSigned: icf, inScreening: Number(r.in_screening),
        enrolled: enr, screenFailed: sf, withdrawn: wd, completed: Number(r.completed),
        screenFailRate: ratio(sf, icf), icfRate: ratio(icf, pre), yieldRate: ratio(enr, pre),
        retentionRate: ratio(enr - wd, enr),
        screenFailBreakdown: sfBy.get(r.id) ?? [],
        withdrawBreakdown: wdBy.get(r.id) ?? [],
        attainment: ratio(enr, r.contracted)
      };
    });
    return { items, nextCursor: rows.length > q.limit ? page.at(-1)!.code : null };
  }

  async listVisits(q: {
    limit: number; cursor?: string; studySiteId?: string; subjectId?: string;
    status?: string[]; outOfWindow?: boolean; pendingPi?: boolean;
  }) {
    const c = ctx();
    const params: unknown[] = [];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const conds = ["true"];
    if (q.studySiteId) conds.push(`v.study_site_id = ${add(q.studySiteId)}`);
    if (q.subjectId) conds.push(`v.subject_id = ${add(q.subjectId)}`);
    if (q.status?.length) conds.push(`v.status = ANY(${add(q.status)})`);
    if (q.pendingPi) conds.push(`v.status = 'done_pending_pi'`);
    /* 走 GiST 索引：未完成而窗口已关，或已完成但落在窗口外 */
    if (q.outOfWindow)
      conds.push(`(v.out_of_window OR (v.status = 'planned' AND upper(v.visit_window) < CURRENT_DATE))`);
    if (q.cursor) conds.push(`v.id < ${add(q.cursor)}`);

    const { rows } = await c.client.query<VisitRow>(
      `SELECT ${VISIT_COLS} FROM ${VISIT_FROM} WHERE ${conds.join(" AND ")}
        ORDER BY upper(v.visit_window), v.id DESC LIMIT ${add(q.limit + 1)}`, params);
    const page = rows.slice(0, q.limit);
    const items = page.map(toVisit);
    if (items.length) await this.attachTasks(c.client, items);
    return { items, nextCursor: rows.length > q.limit ? items.at(-1)?.id ?? null : null };
  }

  private async attachTasks(client: PoolClient, visits: { id: string; tasks: unknown[] }[]) {
    const { rows } = await client.query<{
      visit_id: string; seq: number; task: string; done_at: Date | null;
    }>(`SELECT visit_id, seq, task, done_at FROM subject_visit_task
         WHERE visit_id = ANY($1) ORDER BY visit_id, seq`, [visits.map(v => v.id)]);
    const by = new Map<string, { seq: number; task: string; doneAt: string | null }[]>();
    for (const r of rows) {
      const list = by.get(r.visit_id) ?? [];
      list.push({ seq: r.seq, task: r.task, doneAt: iso(r.done_at) });
      by.set(r.visit_id, list);
    }
    for (const v of visits) v.tasks = by.get(v.id) ?? [];
  }

  async visit(id: string) {
    const c = ctx();
    const { rows } = await c.client.query<VisitRow>(
      `SELECT ${VISIT_COLS} FROM ${VISIT_FROM} WHERE v.id = $1`, [id]);
    if (!rows[0]) throw notFound("访视");
    const v = toVisit(rows[0]);
    await this.attachTasks(c.client, [v]);
    return v;
  }

  /* ── 受试者生命周期 ─────────────────────────────────────────────── */

  /** 取一条受试者的原始行并断言可见；范围外与不存在同样是 404。 */
  private async rawSubject(id: string) {
    const c = ctx();
    const { rows } = await c.client.query<{
      id: string; study_site_id: string; screening_no: string; state: string;
      icf_signed_on: Date | null; enrolled_on: Date | null;
      randomization_no: string | null; study_id: string; irb_approved_on: Date | null;
      site_code: string;
    }>(`SELECT su.id, su.study_site_id, su.screening_no, su.state, su.icf_signed_on,
               su.enrolled_on, su.randomization_no, s.study_id, s.irb_approved_on, s.code AS site_code
          FROM subject su JOIN study_site s ON s.id = su.study_site_id
         WHERE su.id = $1`, [id]);
    if (!rows[0]) throw notFound("受试者");
    return rows[0];
  }

  private invariant(name: string, detail: string): never {
    throw new ProblemException("invariant-violated", { detail, invariant: name });
  }

  async createSubject(b: { studySiteId: string; screeningNo: string }) {
    const c = ctx();
    const site = await c.client.query<{ id: string; state: string; code: string }>(
      `SELECT id, state, code FROM study_site WHERE id = $1`, [b.studySiteId]);
    if (!site.rows[0]) throw notFound("中心");
    /* 中心还没启动就登记受试者 —— 那是在 SIV 之前开展受试者相关工作，是严重违背 */
    if (!["siv", "enrolling", "enrolled", "followup"].includes(site.rows[0].state))
      this.invariant("subject-needs-active-site",
        `中心当前是「${site.rows[0].state}」，尚未启动，不能登记受试者`);

    const { rows } = await c.client.query<{ id: string }>(
      `INSERT INTO subject (study_site_id, screening_no, crc_account_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [b.studySiteId, b.screeningNo, principal().accountId]);
    await this.audit.write({
      action: "登记预筛受试者", targetType: "subject", targetId: b.screeningNo,
      after: { screeningNo: b.screeningNo }, studySiteId: b.studySiteId });
    return this.getSubject(rows[0]!.id);
  }

  /** 签署 ICF = 进入筛选期，同时按 SOA 生成筛选期访视窗口。 */
  async signIcf(id: string, b: { signedOn: string }) {
    const c = ctx();
    const su = await this.rawSubject(id);
    if (su.state !== "prescreen")
      this.invariant("subject-state", `受试者当前是「${su.state}」，只有预筛状态可以登记知情签署`);
    if (b.signedOn > todayStr())
      this.invariant("icf-not-future", "知情同意签署日不能晚于今天");
    /* 伦理批件之前签的知情，是严重违背 —— 不该由系统默默接受 */
    const irb = day(su.irb_approved_on);
    if (irb && b.signedOn < irb)
      this.invariant("icf-after-irb",
        `知情签署日 ${b.signedOn} 早于该中心的伦理批件日 ${irb}`);

    await c.client.query(
      `UPDATE subject SET state = 'screening', icf_signed_on = $2 WHERE id = $1`,
      [id, b.signedOn]);
    const effects: Effect[] = [];
    const v = await this.scheduleVisit(id, 0, b.signedOn);
    if (v) effects.push(v);

    await this.audit.write({
      action: "登记知情同意签署", targetType: "subject", targetId: su.screening_no,
      before: { state: su.state }, after: { state: "screening", icfSignedOn: b.signedOn },
      studySiteId: su.study_site_id });
    return { data: await this.getSubject(id), sideEffects: effects };
  }

  async enroll(id: string, b: { randomizationNo: string; enrolledOn: string }) {
    const c = ctx();
    const su = await this.rawSubject(id);
    if (su.state !== "screening")
      this.invariant("subject-state", `受试者当前是「${su.state}」，只有筛选中可以入组`);

    /* I3 的直接后果：入排标准还没有 PI 签字就随机化，是核查必查的一条 */
    const scr = await c.client.query<{ status: string }>(
      `SELECT status FROM subject_visit WHERE subject_id = $1 AND seq = 0`, [id]);
    if (!scr.rows[0] || scr.rows[0].status !== "locked")
      throw new ProblemException("gate-not-satisfied", {
        detail: "筛选期访视尚未由 PI 确认锁定，不能入组",
        unmet: [{ code: "screening-visit-not-locked", module: "clinical",
          message: scr.rows[0]
            ? `筛选期访视当前是「${scr.rows[0].status}」，需 PI 确认后才能入组`
            : "尚未登记筛选期访视" }] });

    await c.client.query(
      `UPDATE subject SET state = 'enrolled', randomization_no = $2, enrolled_on = $3
        WHERE id = $1`, [id, b.randomizationNo, b.enrolledOn]);

    const effects: Effect[] = [{
      type: "SubjectEnrolled",
      summary: `${su.screening_no} 已入组，随机号 ${b.randomizationNo}`,
      ref: id, studySiteId: su.study_site_id
    }];
    const v = await this.scheduleVisit(id, 1, b.enrolledOn);
    if (v) effects.push(v);

    await this.audit.write({
      action: "受试者入组", targetType: "subject", targetId: su.screening_no,
      before: { state: su.state },
      after: { state: "enrolled", randomizationNo: b.randomizationNo },
      studySiteId: su.study_site_id });
    return { data: await this.getSubject(id), sideEffects: effects };
  }

  async screenFail(id: string, b: { reason: string; failedOn: string; note?: string }) {
    const c = ctx();
    const su = await this.rawSubject(id);
    if (!["prescreen", "screening"].includes(su.state))
      this.invariant("subject-state", `受试者当前是「${su.state}」，只有预筛或筛选中可以登记筛败`);
    if (su.state === "prescreen")
      this.invariant("screen-fail-needs-icf",
        "尚未签署知情，谈不上筛败 —— 未签知情的退出不进筛败统计，否则筛败率会被稀释");

    await c.client.query(
      `UPDATE subject SET state = 'screen_failed', screen_fail_reason = $2,
              exited_on = $3, note = coalesce($4, note) WHERE id = $1`,
      [id, b.reason, b.failedOn, b.note ?? null]);
    /* 未做的访视一并作废，否则这一例会永远刷红超窗 */
    await c.client.query(
      `UPDATE subject_visit SET status = 'cancelled'
        WHERE subject_id = $1 AND status = 'planned'`, [id]);

    await this.audit.write({
      action: "登记筛败", targetType: "subject", targetId: su.screening_no,
      before: { state: su.state }, after: { state: "screen_failed", reason: b.reason },
      studySiteId: su.study_site_id });
    return { data: await this.getSubject(id), sideEffects: [] as Effect[] };
  }

  async withdraw(id: string, b: { reason: string; withdrawnOn: string; note: string }) {
    const c = ctx();
    const su = await this.rawSubject(id);
    if (su.state !== "enrolled")
      this.invariant("subject-state",
        `受试者当前是「${su.state}」，只有已入组可以登记脱落 —— ` +
        "入组前退出叫筛败，两者在收入口径上完全不同");

    await c.client.query(
      `UPDATE subject SET state = 'withdrawn', withdraw_reason = $2,
              exited_on = $3, note = $4 WHERE id = $1`,
      [id, b.reason, b.withdrawnOn, b.note]);
    const cancelled = await c.client.query(
      `UPDATE subject_visit SET status = 'cancelled'
        WHERE subject_id = $1 AND status = 'planned'`, [id]);

    await this.audit.write({
      action: "登记脱落", targetType: "subject", targetId: su.screening_no,
      before: { state: su.state }, after: { state: "withdrawn", reason: b.reason },
      reason: b.note, studySiteId: su.study_site_id });

    const done = await c.client.query<{ n: string; total: string }>(
      `SELECT (SELECT count(*) FROM subject_visit
                WHERE subject_id = $1 AND status = 'locked') AS n,
              (SELECT count(*) FROM visit_template t JOIN study_site s ON s.study_id = t.study_id
                WHERE s.id = $2) AS total`, [id, su.study_site_id]);
    const n = Number(done.rows[0]?.n ?? 0), total = Number(done.rows[0]?.total ?? 0);
    return {
      data: await this.getSubject(id),
      sideEffects: [{
        type: "QualityEventOpened",
        summary: `${su.screening_no} 脱落：已完成 ${n}/${total} 次访视，` +
          `剩余 ${cancelled.rowCount ?? 0} 次已作废。` +
          "收入按已完成比例计，不按整例（I8'）",
        ref: id, studySiteId: su.study_site_id
      }] as Effect[]
    };
  }

  /* ── 访视 ───────────────────────────────────────────────────────── */

  /** 按 SOA 生成第 seq 次访视。已存在则不重复生成（幂等）。 */
  private async scheduleVisit(
    subjectId: string, seq: number, anchorDate: string
  ): Promise<Effect | null> {
    const c = ctx();
    const su = await this.rawSubject(subjectId);
    const t = await c.client.query<{
      visit_code: string; visit_label: string; offset_days: number; window_days: number;
    }>(`SELECT visit_code, visit_label, offset_days, window_days
          FROM visit_template WHERE study_id = $1 AND seq = $2`, [su.study_id, seq]);
    if (!t.rows[0]) return null;                     // SOA 到头了，没有下一次
    const tpl = t.rows[0];

    const exists = await c.client.query<{ id: string }>(
      `SELECT id FROM subject_visit WHERE subject_id = $1 AND seq = $2`, [subjectId, seq]);
    if (exists.rows[0]) return null;

    const target = new Date(anchorDate);
    target.setDate(target.getDate() + tpl.offset_days);
    const targetStr = target.toISOString().slice(0, 10);

    const { rows } = await c.client.query<{ id: string }>(
      `INSERT INTO subject_visit (subject_id, study_site_id, seq, visit_code, visit_label,
         target_date, window_days) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [subjectId, su.study_site_id, seq, tpl.visit_code, tpl.visit_label,
       targetStr, tpl.window_days]);
    const vid = rows[0]!.id;

    /* 任务清单一起生成 —— 「这次要做哪几项」不该靠 CRC 记忆 */
    await c.client.query(
      `INSERT INTO subject_visit_task (visit_id, seq, task)
       SELECT $1, seq, task FROM visit_template_task
        WHERE study_id = $2 AND visit_seq = $3 ORDER BY seq`, [vid, su.study_id, seq]);

    return {
      type: "NextVisitScheduled",
      summary: `已排下一次访视：${tpl.visit_label}，目标日 ${targetStr}，` +
        `窗口 ±${tpl.window_days} 天`,
      ref: vid, studySiteId: su.study_site_id
    };
  }

  async completeTask(visitId: string, seq: number) {
    const c = ctx();
    const v = await this.visit(visitId);
    if (v.status !== "planned")
      this.invariant("visit-state", `访视当前是「${v.status}」，不能再改任务`);
    await c.client.query(
      `UPDATE subject_visit_task SET done_at = now(), done_by = $3
        WHERE visit_id = $1 AND seq = $2 AND done_at IS NULL`,
      [visitId, seq, principal().accountId]);
    return { data: await this.visit(visitId), sideEffects: [] as Effect[] };
  }

  /**
   * 完成一次访视 —— **本系统最重要的一个命令**。
   * 七件后果里的五件在这里同一个事务内完成，另外两件在 visit-completed.ts 里登记在册。
   */
  async completeVisit(id: string, b: {
    actualDate: string; outOfWindowReason?: string; hours: number; note?: string;
  }) {
    const c = ctx();
    const v = await this.visit(id);
    if (v.status !== "planned")
      this.invariant("visit-state", `访视当前是「${v.status}」，不能重复完成`);
    if (b.actualDate > todayStr())
      this.invariant("visit-not-future", "访视实际完成日不能晚于今天");

    /* 打勾了事等于没做：任务未逐项完成不得提交 */
    const open = v.tasks.filter(t => !t.doneAt);
    if (open.length)
      throw new ProblemException("gate-not-satisfied", {
        detail: `本次访视还有 ${open.length} 项任务未完成`,
        unmet: open.slice(0, 5).map(t => ({
          code: "visit-task-open", module: "clinical", message: t.task }))
      });

    const outOfWindow = b.actualDate < v.windowFrom || b.actualDate > v.windowTo;
    /* I4 的前半：超窗必须说明原因，原因原样进入偏离记录 */
    if (outOfWindow && !b.outOfWindowReason)
      this.invariant("out-of-window-needs-reason",
        `实际完成日 ${b.actualDate} 落在窗口 ${v.windowFrom} ~ ${v.windowTo} 之外，必须说明原因`);

    await c.client.query(
      `UPDATE subject_visit SET status = 'done_pending_pi', actual_date = $2,
              hours = $3, out_of_window = $4, note = coalesce($5, note) WHERE id = $1`,
      [id, b.actualDate, b.hours, outOfWindow, b.note ?? null]);

    const effects: Effect[] = [];

    /* ① I4：超窗 → 方案偏离。**同一个事务里生成** ——
          事后补录的偏离，核查时看的是补录时间，不是发生时间。 */
    if (outOfWindow) {
      const code = `DEV-${Date.now().toString(36).toUpperCase()}-${v.seq}`;
      const late = b.actualDate > v.windowTo;
      const dev = await c.client.query<{ id: string }>(
        `INSERT INTO quality_event (code, study_site_id, subject_id, visit_id, kind,
           severity, title, detail, auto_generated, raised_by, raised_on)
         VALUES ($1,$2,$3,$4,'deviation',$5,$6,$7,true,'system',$8) RETURNING id`,
        [code, v.studySiteId, v.subjectId, id,
         late && between(v.windowTo, b.actualDate) > 7 ? "major" : "minor",
         `访视超窗：${v.visitLabel}`,
         `窗口 ${v.windowFrom} ~ ${v.windowTo}，实际完成 ${b.actualDate}` +
           `（${late ? "晚" : "早"} ${Math.abs(between(late ? v.windowTo : v.windowFrom, b.actualDate))} 天）。` +
           `填报原因：${b.outOfWindowReason}`,
         b.actualDate]);
      effects.push({
        type: "DeviationDetected",
        summary: `已生成方案偏离 ${code} —— 超窗不是打个招呼就过去了，它进质量台账`,
        ref: dev.rows[0]!.id, studySiteId: v.studySiteId
      });
    }

    /* ② 受试者补偿待发放 */
    const comp = await c.client.query<{ compensation_cents: string }>(
      `SELECT t.compensation_cents FROM visit_template t
         JOIN study_site s ON s.study_id = t.study_id
        WHERE s.id = $1 AND t.seq = $2`, [v.studySiteId, v.seq]);
    const amount = Number(comp.rows[0]?.compensation_cents ?? 0);
    if (amount > 0) {
      const due = new Date(b.actualDate);
      due.setDate(due.getDate() + 30);
      const pay = await c.client.query<{ id: string }>(
        `INSERT INTO subject_payment (study_site_id, subject_id, visit_id, amount_cents, due_on)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (visit_id) DO NOTHING RETURNING id`,
        [v.studySiteId, v.subjectId, id, amount, due.toISOString().slice(0, 10)]);
      if (pay.rows[0]) effects.push({
        type: "CompensationDue",
        summary: `受试者补偿 ${(amount / 100).toFixed(2)} 元待发放，应发日 ` +
          due.toISOString().slice(0, 10),
        ref: pay.rows[0].id, amountCents: amount, studySiteId: v.studySiteId
      });
    }

    /* ③ PostVisitTimesheet：记一条工时并归集成本（I1 / I2）。
          同一个事务里做 —— 访视记下了而工时没记上，成本就永远少一块，
          且没有任何地方会提示你。 */
    const ts = await this.timesheet.postVisitTimesheet({
      studySiteId: v.studySiteId, visitId: id, subjectId: v.subjectId,
      actualDate: b.actualDate, hours: b.hours });
    if (ts) {
      effects.push({
        type: "TimesheetPosted",
        summary: `已记 ${b.hours} 小时工时`,
        ref: ts.id, studySiteId: v.studySiteId
      });
      effects.push({
        type: "CostPosted",
        summary: `成本 ${(ts.costCents / 100).toFixed(2)} 元已归集到 ${v.siteCode}`,
        ref: ts.id, amountCents: ts.costCents, studySiteId: v.studySiteId
      });
    } else {
      /* 没入账就要说出来。悄悄跳过的那条成本，最后是从毛利里出的。 */
      effects.push({
        type: "QualityEventOpened",
        summary: "**工时未入账**：当日没有生效的费率卡，或该账号没有员工记录。" +
          "请补齐后手工填报这条工时",
        studySiteId: v.studySiteId
      });
    }

    /* ④ 筛选期访视完成 → 受试者从预筛/筛选进入待入组；⑤ 排下一次 */
    if (v.seq >= 1) {
      const nx = await this.scheduleVisit(v.subjectId, v.seq + 1,
        (await this.rawSubject(v.subjectId)).enrolled_on!.toISOString().slice(0, 10));
      if (nx) effects.push(nx);
    }

    await this.audit.write({
      action: "完成访视", targetType: "subject_visit", targetId: v.visitLabel,
      before: { status: v.status },
      after: { status: "done_pending_pi", actualDate: b.actualDate,
               hours: b.hours, outOfWindow },
      studySiteId: v.studySiteId, reason: b.outOfWindowReason ?? null });

    return {
      data: await this.visit(id),
      sideEffects: effects,
      /* 尚未接上的订阅者留在明面上，不靠记性 —— 见 visit-completed.ts */
      pending: pendingSubscribers().map(s => ({
        name: s.name, what: s.what, phase: s.pendingPhase! }))
    };
  }

  /** I3：只有该中心的 PI 本人可以确认。 */
  async confirmVisit(id: string) {
    const c = ctx();
    const p = principal();
    const v = await this.visit(id);
    if (v.status !== "done_pending_pi")
      this.invariant("visit-state", `访视当前是「${v.status}」，只有待确认的可以确认`);

    const site = await c.client.query<{ pi_account_id: string | null; pi_name: string }>(
      `SELECT pi_account_id, pi_name FROM study_site WHERE id = $1`, [v.studySiteId]);
    /* 有 piConfirm 权限不等于可以确认**这一个**中心的访视 ——
       动作维度回答"能不能做这类事"，这一条回答"是不是你的中心"。 */
    if (site.rows[0]?.pi_account_id !== p.accountId)
      this.invariant("pi-must-be-site-pi",
        `只有本中心研究者（${site.rows[0]?.pi_name ?? "未指定"}）本人可以确认该访视`);

    await c.client.query(
      `UPDATE subject_visit SET status = 'locked', pi_confirmed_by = $2, pi_confirmed_at = now()
        WHERE id = $1`, [id, p.accountId]);

    const effects: Effect[] = [];
    /* 筛选期访视锁定 → 可以入组了。这是 enroll() 那道闸门的另一面。 */
    if (v.seq === 0) effects.push({
      type: "SubjectEnrolled",
      summary: "筛选期访视已锁定，该受试者现在可以入组随机化",
      ref: v.subjectId, studySiteId: v.studySiteId
    });

    await this.audit.write({
      action: "PI 确认访视", targetType: "subject_visit", targetId: v.visitLabel,
      before: { status: v.status }, after: { status: "locked" },
      studySiteId: v.studySiteId });
    return { data: await this.visit(id), sideEffects: effects };
  }

  async markEdcEntered(id: string) {
    const c = ctx();
    const v = await this.visit(id);
    if (!v.actualDate)
      this.invariant("visit-not-done", "访视尚未完成，无从录入 EDC");
    await c.client.query(
      `UPDATE subject_visit SET edc_status = 'entered', edc_entered_on = CURRENT_DATE
        WHERE id = $1`, [id]);
    await this.audit.write({
      action: "标记 EDC 已录入", targetType: "subject_visit", targetId: v.visitLabel,
      before: { edcStatus: v.edcStatus }, after: { edcStatus: "entered" },
      studySiteId: v.studySiteId });
    return { data: await this.visit(id), sideEffects: [] as Effect[] };
  }

  /* ── 质量事件与补偿 ─────────────────────────────────────────────── */

  async listQualityEvents(q: {
    limit: number; cursor?: string; studySiteId?: string; kind?: string[]; state?: string[];
    /** 内部用：取回刚写的那一条。
     *  不能靠 `limit: 1` —— 排序是 raised_on DESC，而 raised_on 来自
     *  **事件发生的日期**，不是写入时刻：补录一条三天前的 SAE，
     *  它就不在第一页。那种 bug 表现成"字段莫名其妙是 undefined"。 */
    id?: string;
  }) {
    const c = ctx();
    const params: unknown[] = [];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const conds = ["true"];
    if (q.id) conds.push(`q.id = ${add(q.id)}`);
    if (q.studySiteId) conds.push(`q.study_site_id = ${add(q.studySiteId)}`);
    if (q.kind?.length) conds.push(`q.kind = ANY(${add(q.kind)})`);
    if (q.state?.length) conds.push(`q.state = ANY(${add(q.state)})`);
    if (q.cursor) conds.push(`q.id < ${add(q.cursor)}`);

    const { rows } = await c.client.query<{
      id: string; code: string; study_site_id: string; site_code: string;
      subject_id: string | null; screening_no: string | null; visit_id: string | null;
      kind: string; severity: string; state: string; title: string; detail: string;
      auto_generated: boolean; raised_by: string; raised_on: Date; closed_at: Date | null;
      occurred_at: Date | null; reported_at: Date | null; source_event_id: string | null;
      category: string | null; capa_plan: string | null;
      capa_owner_account_id: string | null; capa_owner_name: string | null;
      capa_due_on: Date | null;
    }>(`SELECT q.id, q.code, q.study_site_id, s.code AS site_code, q.subject_id,
               su.screening_no, q.visit_id, q.kind, q.severity, q.state, q.title,
               q.detail, q.auto_generated, q.raised_by, q.raised_on, q.closed_at,
               q.occurred_at, q.reported_at, q.source_event_id,
               q.category, q.capa_plan, q.capa_owner_account_id,
               co.display_name AS capa_owner_name, q.capa_due_on
          FROM quality_event q
          JOIN study_site s ON s.id = q.study_site_id
          LEFT JOIN subject su ON su.id = q.subject_id
          LEFT JOIN account co ON co.id = q.capa_owner_account_id
         WHERE ${conds.join(" AND ")}
         ORDER BY q.raised_on DESC, q.id DESC LIMIT ${add(q.limit + 1)}`, params);

    const today = todayStr();
    const items = rows.slice(0, q.limit).map(r => ({
      id: r.id, code: r.code, studySiteId: r.study_site_id, siteCode: r.site_code,
      subjectId: r.subject_id,
      ...(r.screening_no !== null ? { screeningNo: r.screening_no } : {}),
      visitId: r.visit_id, kind: r.kind, severity: r.severity, state: r.state,
      title: r.title, detail: r.detail, autoGenerated: r.auto_generated,
      raisedBy: r.raised_by, raisedOn: day(r.raised_on)!,
      closedAt: iso(r.closed_at),
      ageDays: between(day(r.raised_on)!, r.closed_at ? day(r.closed_at)! : today),
      occurredAt: iso(r.occurred_at), reportedAt: iso(r.reported_at),
      sourceEventId: r.source_event_id,
      /* 口径在 @sitedesk/calc 里，这里不重算 —— 界面上出现的每一个业务数字
         都来自那一层，否则同一个数会在两处慢慢分叉。 */
      reportHours: r.occurred_at
        ? saeReportHours({ occurredAt: r.occurred_at, reportedAt: r.reported_at })
        : null,
      category: r.category,
      capaPlan: r.capa_plan,
      capaOwnerAccountId: r.capa_owner_account_id,
      capaOwnerName: r.capa_owner_name,
      capaDueOn: day(r.capa_due_on),
      /* 已关闭的不再谈期限 —— 一条已经整改完的事件，「逾期几天」没有意义，
         而给它一个正数会让它混进"欠账"统计。 */
      capaOverdueDays: (() => {
        if (r.state === "closed" || !r.capa_due_on) return null;
        const over = between(day(r.capa_due_on)!, today);
        return over > 0 ? over : null;
      })(),
      /* **已指派、还没提交措施**：它不是「正在整改」，是有人欠着一份措施。 */
      owesCapaPlan: r.capa_owner_account_id !== null && r.capa_plan === null
    }));
    return { items, nextCursor: rows.length > q.limit ? items.at(-1)?.id ?? null : null };
  }

  /* ── SOA 配置（欠账 D2） ──────────────────────────────────────────
     访视计划表本来就是一张按项目的表，缺的只是一个能改它的入口，
     以及三个问题的答案 —— 与启动清单模板同一组：
     `manage` + 必填原因（谁能改）、排期时落成行（在途受试者不受影响）、
     visit_template_change 的前后快照（追溯）。 */

  async soa(studyId: string) {
    const c = ctx();
    /* 范围外与不存在同一个 404。项目的可见性由它下面有没有你看得见的中心决定。 */
    const ok = await c.client.query(
      `SELECT 1 FROM study st WHERE st.id = $1
        AND EXISTS (SELECT 1 FROM study_site s WHERE s.study_id = st.id)`, [studyId]);
    if (!ok.rowCount) throw notFound("项目");

    const { rows } = await c.client.query<{
      seq: number; visit_code: string; visit_label: string; anchor: string;
      offset_days: number; window_days: number; compensation_cents: string;
      tasks: string[] | null; scheduled: string;
    }>(`SELECT t.seq, t.visit_code, t.visit_label, t.anchor, t.offset_days,
               t.window_days, t.compensation_cents,
               (SELECT array_agg(k.task ORDER BY k.seq) FROM visit_template_task k
                 WHERE k.study_id = t.study_id AND k.visit_seq = t.seq) AS tasks,
               (SELECT count(*) FROM subject_visit v
                  JOIN study_site s ON s.id = v.study_site_id
                 WHERE s.study_id = t.study_id AND v.seq = t.seq) AS scheduled
          FROM visit_template t WHERE t.study_id = $1 ORDER BY t.seq`, [studyId]);

    const last = await c.client.query<{
      changed_at: Date; name: string | null; reason: string;
    }>(`SELECT ch.changed_at, a.display_name AS name, ch.reason
          FROM visit_template_change ch LEFT JOIN account a ON a.id = ch.changed_by
         WHERE ch.study_id = $1 ORDER BY ch.changed_at DESC LIMIT 1`, [studyId]);

    return {
      studyId,
      visits: rows.map(r => ({
        seq: r.seq, visitCode: r.visit_code, visitLabel: r.visit_label,
        anchor: r.anchor, offsetDays: r.offset_days, windowDays: r.window_days,
        compensationCents: Number(r.compensation_cents),
        tasks: r.tasks ?? [], scheduledCount: Number(r.scheduled)
      })),
      lastChangedAt: iso(last.rows[0]?.changed_at ?? null),
      lastChangedByName: last.rows[0]?.name ?? null,
      lastReason: last.rows[0]?.reason ?? null
    };
  }

  async replaceSoa(studyId: string, b: {
    visits: {
      seq: number; visitCode: string; visitLabel: string; anchor: string;
      offsetDays: number; windowDays: number; compensationCents: number; tasks: string[];
    }[];
    reason: string;
  }) {
    const c = ctx(), p = principal();
    const before = await this.soa(studyId);

    /* 只有 seq 0 锚定知情日 —— 入组之前唯一确定的日期就是它。
       库里有同名约束，这里先拦一次是为了给出一句人话。 */
    for (const v of b.visits)
      if ((v.seq === 0) !== (v.anchor === "icf"))
        this.invariant("soa-anchor-seq",
          `第 ${v.seq} 次访视的锚点是「${v.anchor}」—— ` +
          "只有第 0 次锚定知情日，其余都锚定入组日");

    const dup = b.visits.map(v => v.seq).find((x, i, all) => all.indexOf(x) !== i);
    if (dup !== undefined)
      throw new ProblemException("validation-failed", {
        detail: `seq ${dup} 出现了两次 —— 它是访视在 SOA 上的编号，不能重复` });

    /* 已经排出去的那些 seq：删不掉，锚点也改不了。
       库里有触发器兜删除，但**改锚点**它兜不住 —— 那会让已排的访视
       和 SOA 说的不是同一件事，而没有任何报错。 */
    const kept = new Map(b.visits.map(v => [v.seq, v]));
    for (const old of before.visits) {
      if (old.scheduledCount === 0) continue;
      const now = kept.get(old.seq);
      if (!now)
        this.invariant("soa-seq-in-use",
          `第 ${old.seq} 次访视（${old.visitLabel}）已经排给了 ${old.scheduledCount} 个受试者，` +
          "删掉它会让那些访视指向一个不存在的定义");
      else if (now.anchor !== old.anchor)
        this.invariant("soa-anchor-in-use",
          `第 ${old.seq} 次访视已经排出去 ${old.scheduledCount} 次，锚点不能再改 —— ` +
          "已排的那些是按旧锚点算的目标日，改了之后两边说的不是同一件事");
    }

    /* 整份替换要小心**别把留下来的那几条也删一遍**：
       触发器拦的是"删掉一个已排出去的 seq"，而先删后插会让每一条
       都经过一次删除 —— 于是任何一次修订都被自己的保护措施拦下。
       所以：只删真正被去掉的 seq，其余走 upsert。 */
    const keptSeqs = b.visits.map(v => v.seq);
    await c.client.query(
      "DELETE FROM visit_template WHERE study_id = $1 AND seq <> ALL($2::int[])",
      [studyId, keptSeqs]);

    /* visit_code 上有 UNIQUE(study_id, visit_code)。两条访视对调编号时，
       upsert 到一半会撞上还没被改掉的那一条。先把现有编号统一加一个
       `~` 后缀腾位置 —— 契约里的 Code 不允许 `~`，所以它撞不上新值。 */
    await c.client.query(
      "UPDATE visit_template SET visit_code = visit_code || '~' WHERE study_id = $1",
      [studyId]);

    await c.client.query(
      `INSERT INTO visit_template (study_id, seq, visit_code, visit_label, anchor,
         offset_days, window_days, compensation_cents)
       SELECT $1, t.seq, t.code, t.label, t.anchor, t.offset_days, t.window_days, t.comp
         FROM unnest($2::int[], $3::text[], $4::text[], $5::text[],
                     $6::int[], $7::int[], $8::bigint[])
              AS t(seq, code, label, anchor, offset_days, window_days, comp)
       ON CONFLICT (study_id, seq) DO UPDATE SET
         visit_code = EXCLUDED.visit_code, visit_label = EXCLUDED.visit_label,
         anchor = EXCLUDED.anchor, offset_days = EXCLUDED.offset_days,
         window_days = EXCLUDED.window_days,
         compensation_cents = EXCLUDED.compensation_cents`,
      [studyId,
       b.visits.map(v => v.seq), b.visits.map(v => v.visitCode),
       b.visits.map(v => v.visitLabel), b.visits.map(v => v.anchor),
       b.visits.map(v => v.offsetDays), b.visits.map(v => v.windowDays),
       b.visits.map(v => v.compensationCents)]);

    /* 任务清单整份重来 —— 它没有"已经排出去"的问题：
       subject_visit_task 在排期时已经抄成了自己的行。 */
    await c.client.query(
      "DELETE FROM visit_template_task WHERE study_id = $1", [studyId]);
    for (const v of b.visits)
      if (v.tasks.length)
        await c.client.query(
          `INSERT INTO visit_template_task (study_id, visit_seq, seq, task)
           SELECT $1, $2, ord - 1, task FROM unnest($3::text[]) WITH ORDINALITY AS t(task, ord)`,
          [studyId, v.seq, v.tasks]);

    const after = await this.soa(studyId);
    await c.client.query(
      `INSERT INTO visit_template_change (study_id, changed_by, reason, before_soa, after_soa)
       VALUES ($1,$2,$3,$4,$5)`,
      [studyId, p.accountId, b.reason,
       JSON.stringify(before.visits), JSON.stringify(after.visits)]);

    await this.audit.write({
      action: "修订访视计划表", targetType: "study", targetId: studyId,
      before: { visits: before.visits.length },
      after: { visits: after.visits.length }, reason: b.reason });

    const scheduled = before.visits.reduce((n, v) => n + v.scheduledCount, 0);
    return {
      data: after,
      sideEffects: [{
        type: "SoaRevised",
        summary: `SOA 已修订为 ${after.visits.length} 次访视。` +
          `**已排出去的 ${scheduled} 次访视不动** —— 它们在排期那一刻就把` +
          "目标日与窗口抄下来了；改模板只影响之后才排出来的那些。"
      }] as Effect[]
    };
  }

  /* ── SAE 台账与 24 小时及时率（I6） ────────────────────────────────
     kernel.ts 开头点名的原罪：这个数原本是**写死的常量**，
     而同一个页面下方就摆着一条超窗的 SAE。这里它由台账算出来。 */

  async listSae(siteId: string, q: { limit: number; cursor?: string }) {
    const c = ctx();
    /* 范围外与不存在同一个 404 —— 区分开就是在确认「它存在」 */
    const site = await c.client.query(
      "SELECT 1 FROM study_site WHERE id = $1", [siteId]);
    if (!site.rowCount) throw notFound("中心");

    const page = await this.listQualityEvents({ ...q, studySiteId: siteId, kind: ["sae"] });

    /* 及时率的分母是**这个中心的全部 SAE**，不是当前这一页 ——
       翻到第二页时及时率跟着变，那个数字就没有任何意义。 */
    const { rows } = await c.client.query<{ occurred_at: Date; reported_at: Date | null }>(
      `SELECT occurred_at, reported_at FROM quality_event
        WHERE study_site_id = $1 AND kind = 'sae' AND occurred_at IS NOT NULL`, [siteId]);
    const t = saeTimeliness(
      rows.map(r => ({ occurredAt: r.occurred_at, reportedAt: r.reported_at })), new Date());

    return {
      items: page.items, nextCursor: page.nextCursor,
      timeliness: { ...t, calcVersion: CALC_VERSION }
    };
  }

  async reportSae(siteId: string, b: {
    subjectId?: string; title: string; detail: string;
    occurredAt: string; reportedAt?: string;
  }) {
    const c = ctx();
    const site = await c.client.query<{ id: string }>(
      "SELECT id FROM study_site WHERE id = $1", [siteId]);
    if (!site.rowCount) throw notFound("中心");

    /* 发生时刻不能在未来 —— 它决定 24 小时从什么时候起算，
       填错一个日期就能把一条迟报变成按时。 */
    if (new Date(b.occurredAt).getTime() > Date.now())
      this.invariant("sae-occurred-in-future",
        `发生时刻 ${b.occurredAt} 在未来 —— 它是 24 小时的起算点，不能是一个还没到的时刻`);
    if (b.reportedAt && b.reportedAt < b.occurredAt)
      this.invariant("sae-reported-before-occurred", "上报时刻早于发生时刻");

    const code = `SAE-${Date.now().toString(36).toUpperCase()}`;
    const { rows } = await c.client.query<{ id: string }>(
      `INSERT INTO quality_event (code, study_site_id, subject_id, kind, severity,
         title, detail, auto_generated, raised_by, raised_on, occurred_at, reported_at)
       VALUES ($1,$2,$3,'sae','critical',$4,$5,false,'cra',
               ($6::timestamptz)::date, $6, $7) RETURNING id`,
      [code, siteId, b.subjectId ?? null, b.title, b.detail,
       b.occurredAt, b.reportedAt ?? null]);
    const id = rows[0]!.id;

    await this.audit.write({
      action: "登记 SAE", targetType: "quality_event", targetId: code,
      after: { occurredAt: b.occurredAt, reportedAt: b.reportedAt ?? null },
      studySiteId: siteId, reason: null });

    /* 登记时就带着上报时刻的，迟报判定在这里一并做掉 ——
       否则「先记后报」和「记的时候就报了」两条路会得出不同的台账。 */
    if (b.reportedAt) await this.flagLateSae(id, code, siteId, b.occurredAt, b.reportedAt);

    const one = await this.listQualityEvents({ limit: 1, id });
    return one.items[0]!;
  }

  async markSaeReported(id: string, b: { reportedAt: string }) {
    const c = ctx();
    const { rows } = await c.client.query<{
      id: string; code: string; study_site_id: string; kind: string;
      occurred_at: Date | null; reported_at: Date | null;
    }>(`SELECT id, code, study_site_id, kind, occurred_at, reported_at
          FROM quality_event WHERE id = $1`, [id]);
    if (!rows[0]) throw notFound("质量事件");
    const q = rows[0];
    if (q.kind !== "sae")
      this.invariant("not-an-sae", `${q.code} 不是 SAE，没有上报时刻这一说`);
    if (q.reported_at)
      throw new ProblemException("conflict-version", {
        detail: `${q.code} 已于 ${q.reported_at.toISOString()} 登记上报 —— ` +
          "改上报时刻等于改核查看的那个数，不能就地覆盖" });
    if (b.reportedAt < q.occurred_at!.toISOString())
      this.invariant("sae-reported-before-occurred", "上报时刻早于发生时刻");

    await c.client.query(
      "UPDATE quality_event SET reported_at = $2 WHERE id = $1", [id, b.reportedAt]);
    await this.audit.write({
      action: "登记 SAE 已上报", targetType: "quality_event", targetId: q.code,
      before: { reportedAt: null }, after: { reportedAt: b.reportedAt },
      studySiteId: q.study_site_id, reason: null });

    const effects = await this.flagLateSae(
      id, q.code, q.study_site_id, q.occurred_at!.toISOString(), b.reportedAt);

    const one = await this.listQualityEvents({ limit: 1, id });
    return { data: one.items[0]!, sideEffects: effects };
  }

  /** I6：超过 24 小时 → **必须**生成一条 `sae_late` 质量事件。
   *
   *  和 I4（超窗必生偏离）是同一个做法：在**同一个事务里**写，
   *  不是事后补录 —— 事后补录的记录，核查看的是补录时间，不是发生时间。
   *
   *  它是一条**独立记录**，不是 SAE 那条的一个状态位：
   *  「这一条晚报了」要走整改与关闭流程，而 SAE 本身不需要"关闭"。 */
  private async flagLateSae(
    saeId: string, saeCode: string, siteId: string, occurredAt: string, reportedAt: string
  ): Promise<Effect[]> {
    const hours = saeReportHours({ occurredAt, reportedAt })!;
    if (saeStatus({ occurredAt, reportedAt }, new Date()) !== "late") return [];

    const code = `SAELATE-${Date.now().toString(36).toUpperCase()}`;
    /* source_event_id 指向那条 SAE —— 自动生成的记录必须答得出「凭什么存在」，
       而它的来源不是一次访视（迁移 0018 为此补了这一列）。 */
    const late = await ctx().client.query<{ id: string }>(
      `INSERT INTO quality_event (code, study_site_id, kind, severity, title, detail,
         auto_generated, raised_by, raised_on, source_event_id)
       VALUES ($1,$2,'sae_late','major',$3,$4,true,'system',($5::timestamptz)::date,$6)
       RETURNING id`,
      [code, siteId, `SAE 超时上报：${saeCode}`,
       `发生于 ${occurredAt}，上报于 ${reportedAt}，` +
         `经过 ${hours.toFixed(1)} 小时，超过 ${SAE_REPORT_DEADLINE_HOURS} 小时时限。`,
       reportedAt, saeId]);
    return [{
      type: "SaeReportedLate",
      summary: `已生成 ${code} —— ${saeCode} 晚了 ` +
        `${(hours - SAE_REPORT_DEADLINE_HOURS).toFixed(1)} 小时，` +
        "这条记录不能删，只能整改关闭",
      ref: late.rows[0]!.id, studySiteId: siteId
    }];
  }

  /** 写纠正与预防措施。
   *
   *  **写措施的人不能自己验证关闭** —— 这里是 `capaWrite`，
   *  验证关闭是 `closeQA`。与数据质疑那条（回复的人不能自己关闭）
   *  是同一条规矩。 */
  async setCapaPlan(id: string, b: { plan: string; ownerAccountId?: string; dueOn: string }) {
    const c = ctx();
    const p = principal();
    const { rows } = await c.client.query<{
      id: string; code: string; kind: string; state: string; study_site_id: string;
      capa_plan: string | null; raised_on: Date;
    }>(`SELECT id, code, kind, state, study_site_id, capa_plan, raised_on
          FROM quality_event WHERE id = $1`, [id]);
    if (!rows[0]) throw notFound("质量事件");
    const q = rows[0];

    if (q.state === "closed")
      this.invariant("capa-on-closed", `${q.code} 已经关闭，不再改整改措施`);
    /* 质疑有自己的闭环（回复 → 判定）。给它挂一份整改措施，
       读的人会以为质疑也要走整改流程，而它不走。 */
    if (q.kind === "query")
      this.invariant("capa-not-on-query",
        `${q.code} 是数据质疑 —— 它走回复与判定，不走 CAPA`);
    /* 期限早于问题提出日，是把整改倒着排 —— 多半是填错了年份。 */
    if (Date.parse(b.dueOn) < Date.parse(day(q.raised_on)!))
      this.invariant("capa-due-before-found",
        `整改期限 ${b.dueOn} 早于问题提出日 ${day(q.raised_on)}`);

    const owner = b.ownerAccountId ?? p.accountId;
    await c.client.query(
      `UPDATE quality_event
          SET capa_plan = $2, capa_owner_account_id = $3, capa_due_on = $4
        WHERE id = $1`, [id, b.plan, owner, b.dueOn]);
    await this.audit.write({
      action: "写整改措施", targetType: "quality_event", targetId: q.code,
      before: { capaPlan: q.capa_plan }, after: { capaPlan: b.plan, dueOn: b.dueOn },
      reason: b.plan.slice(0, 200), studySiteId: q.study_site_id });

    const one = await this.listQualityEvents({ limit: 1, id });
    return {
      data: one.items[0]!,
      sideEffects: [{
        type: "CapaPlanned",
        summary: `${q.code} 的整改措施已提交，期限 ${b.dueOn} —— ` +
          "**验证关闭在 QA 那边，写措施的人不能自己关**",
        ref: id, studySiteId: q.study_site_id
      }] as Effect[]
    };
  }

  async closeQualityEvent(id: string, b: { reason: string }) {
    const c = ctx();
    const p = principal();
    const { rows } = await c.client.query<{
      id: string; code: string; state: string; raised_by: string; study_site_id: string;
    }>(`SELECT id, code, state, raised_by, study_site_id FROM quality_event WHERE id = $1`, [id]);
    if (!rows[0]) throw notFound("质量事件");
    const q = rows[0];
    if (q.state === "closed")
      this.invariant("quality-already-closed", `${q.code} 已经关闭`);

    /* 机构质控提出的事件，关闭权在机构 —— 我方自行关闭，
       "已关闭"这三个字在核查时就一文不值。 */
    if (q.raised_by === "institution" && p.roleCode !== "inst")
      this.invariant("institution-closes-own",
        `${q.code} 由机构质控提出，关闭权在机构 —— 我方只能整改并提交复核`);

    await c.client.query(
      `UPDATE quality_event SET state = 'closed', closed_at = now(), closed_by = $2,
              resolution = $3 WHERE id = $1`, [id, p.accountId, b.reason]);
    await this.audit.write({
      action: "关闭质量事件", targetType: "quality_event", targetId: q.code,
      before: { state: q.state }, after: { state: "closed" },
      reason: b.reason, studySiteId: q.study_site_id });

    /* 同样按 id 取回：原来这里是 `limit: 1` + 一个兜底的假对象，
       而那个兜底恰好把"取不到"这件事盖住了 —— 返回的是一个只有三个字段的
       残缺响应，前端看到的是"关闭成功但列表没变"。 */
    const one = await this.listQualityEvents({ limit: 1, id });
    return { data: one.items[0]!, sideEffects: [] as Effect[] };
  }

  async listPayments(q: {
    limit: number; cursor?: string; studySiteId?: string; unpaid?: boolean;
  }) {
    const c = ctx();
    const params: unknown[] = [];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const conds = ["true"];
    if (q.studySiteId) conds.push(`p.study_site_id = ${add(q.studySiteId)}`);
    if (q.unpaid) conds.push(`p.paid_on IS NULL`);
    if (q.cursor) conds.push(`p.id < ${add(q.cursor)}`);

    const { rows } = await c.client.query<{
      id: string; study_site_id: string; site_code: string; subject_id: string;
      screening_no: string; visit_id: string | null; visit_label: string | null;
      amount_cents: string; due_on: Date; paid_on: Date | null; receipt_ref: string | null;
    }>(`SELECT p.id, p.study_site_id, s.code AS site_code, p.subject_id, su.screening_no,
               p.visit_id, v.visit_label, p.amount_cents, p.due_on, p.paid_on, p.receipt_ref
          FROM subject_payment p
          JOIN study_site s ON s.id = p.study_site_id
          JOIN subject su ON su.id = p.subject_id
          LEFT JOIN subject_visit v ON v.id = p.visit_id
         WHERE ${conds.join(" AND ")}
         ORDER BY p.due_on, p.id DESC LIMIT ${add(q.limit + 1)}`, params);

    const today = todayStr();
    const items = rows.slice(0, q.limit).map(r => ({
      id: r.id, studySiteId: r.study_site_id, siteCode: r.site_code,
      subjectId: r.subject_id, screeningNo: r.screening_no,
      visitId: r.visit_id, visitLabel: r.visit_label,
      amountCents: Number(r.amount_cents), dueOn: day(r.due_on)!,
      paidOn: day(r.paid_on), receiptRef: r.receipt_ref,
      ageDays: between(day(r.due_on)!, r.paid_on ? day(r.paid_on)! : today)
    }));
    return { items, nextCursor: rows.length > q.limit ? items.at(-1)?.id ?? null : null };
  }

  async payPayment(id: string, b: { paidOn: string; receiptRef: string }) {
    const c = ctx();
    const { rows } = await c.client.query<{
      id: string; paid_on: Date | null; study_site_id: string; amount_cents: string;
    }>(`SELECT id, paid_on, study_site_id, amount_cents FROM subject_payment WHERE id = $1`, [id]);
    if (!rows[0]) throw notFound("补偿单");
    if (rows[0].paid_on) this.invariant("payment-already-paid", "该笔补偿已登记发放");

    await c.client.query(
      `UPDATE subject_payment SET paid_on = $2, receipt_ref = $3 WHERE id = $1`,
      [id, b.paidOn, b.receiptRef]);
    await this.audit.write({
      action: "登记补偿发放", targetType: "subject_payment", targetId: b.receiptRef,
      after: { paidOn: b.paidOn, amountCents: Number(rows[0].amount_cents) },
      studySiteId: rows[0].study_site_id });

    const one = await this.listPayments({ limit: 200, studySiteId: rows[0].study_site_id });
    return { data: one.items.find(x => x.id === id)!, sideEffects: [] as Effect[] };
  }
}
