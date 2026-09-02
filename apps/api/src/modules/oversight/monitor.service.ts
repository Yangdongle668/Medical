import { Injectable } from "@nestjs/common";
import {
  monitorPlan, monitorDue, mvrLoad, mvrLagDays, travelEstimateCents,
  MVR_DUE_DAYS, QUERY_STALE_DAYS, CALC_VERSION, type SiteRisk
} from "@sitedesk/calc";
import { ctx, principal } from "../../infra/ctx.js";
import { ProblemException, notFound } from "../../infra/problem.js";
import { AuditService } from "../../infra/audit.service.js";

/* ════════════════════════════════════════════════════════════════════
   监查访视。

   ── 服务层只做三件事：取数、调 calc、写审计 ───────────────────────
   风险分级、建议间隔、抽样比例、报告滞后，全部在 @sitedesk/calc 里。
   这里出现任何一个阈值，同一个中心就会在两张页上得到两个结论。

   ── 四个日期各有各的问题 ──────────────────────────────────────────
     planned_on          排了没有
     confirmed_on        中心那边知不知道
     performed_on        人到底去了没有
     report_submitted_on 报告交了没有

   把它们压成一个「状态」字段，「为什么这个中心三个月没人管」
   就答不出来 —— 而那是这一页唯一要回答的问题。
   ════════════════════════════════════════════════════════════════════ */

const day = (v: Date | null) => v ? v.toISOString().slice(0, 10) : null;
const iso = (v: Date | null) => v ? v.toISOString() : null;
const todayStr = () => day(new Date())!;
const between = (a: string, b: string) =>
  Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/** 未来「四周」是多久 —— 原型的口径，跟着它。 */
const UPCOMING_DAYS = 28;
/** 单次现场监查的差旅估算（分）。与原型的 RATE.travel = 0.285 万/次 同一个数。
 *  **它是口径的一部分，不是常识** —— 一线城市往返和跨省两天差得远，
 *  但改这个常量等于改全系统对「下季度差旅预算」的回答。 */
const TRAVEL_PER_VISIT_CENTS = 285_000;

interface VRow {
  id: string; code: string; study_site_id: string; site_code: string; hospital: string;
  study_short: string; kind: string; planned_on: Date;
  monitor_account_id: string; monitor_name: string; days: string; state: string;
  confirmed_on: Date | null; performed_on: Date | null; report_submitted_on: Date | null;
  sdv_sample_pct: number | null; note: string | null;
  items: { seq: number; task: string; done_at: string | null; done_by_name: string | null }[];
}

const V_COLS = `
  v.id, v.code, v.study_site_id, s.code AS site_code, s.hospital,
  st.short_name AS study_short, v.kind, v.planned_on,
  v.monitor_account_id, a.display_name AS monitor_name, v.days, v.state,
  v.confirmed_on, v.performed_on, v.report_submitted_on, v.sdv_sample_pct, v.note,
  COALESCE((
    SELECT json_agg(json_build_object(
             'seq', i.seq, 'task', i.task, 'done_at', i.done_at,
             'done_by_name', da.display_name) ORDER BY i.seq)
      FROM monitor_visit_item i
      LEFT JOIN account da ON da.id = i.done_by
     WHERE i.visit_id = v.id), '[]'::json) AS items`;
const V_FROM = `
  FROM monitor_visit v
  JOIN study_site s ON s.id = v.study_site_id
  JOIN study st ON st.id = s.study_id
  JOIN account a ON a.id = v.monitor_account_id`;

@Injectable()
export class MonitorService {
  constructor(private readonly audit: AuditService) {}

  private invariant(name: string, detail: string): never {
    throw new ProblemException("invariant-violated", { detail, invariant: name });
  }

  private dto(r: VRow, today: string) {
    const performedOn = day(r.performed_on);
    const reportSubmittedOn = day(r.report_submitted_on);
    const lag = mvrLagDays({ performedOn, reportSubmittedOn }, today);
    const plannedOn = day(r.planned_on)!;
    const items = r.items.map(i => ({
      seq: i.seq, task: i.task,
      doneAt: i.done_at ? new Date(i.done_at).toISOString() : null,
      doneByName: i.done_by_name
    }));
    /* 「计划日过了还没去」和「去了没交报告」是两个不同的欠账 ——
       前者要改期或者出发，后者要坐下来写。合成一个数字，
       两种都不知道该做什么。 */
    const notYetThere = r.state === "proposed" || r.state === "scheduled";
    const visitOverdue = notYetThere ? between(plannedOn, today) : 0;
    return {
      id: r.id, code: r.code,
      studySiteId: r.study_site_id, siteCode: r.site_code, hospital: r.hospital,
      studyShortName: r.study_short,
      kind: r.kind, plannedOn,
      monitorAccountId: r.monitor_account_id, monitorName: r.monitor_name,
      days: Number(r.days), state: r.state,
      confirmedOn: day(r.confirmed_on), performedOn, reportSubmittedOn,
      sdvSamplePct: r.sdv_sample_pct, note: r.note,
      items,
      openItems: items.filter(i => i.doneAt === null).length,
      mvrLagDays: lag,
      mvrOverdue: reportSubmittedOn === null && lag !== null && lag > MVR_DUE_DAYS,
      visitOverdueDays: visitOverdue > 0 ? visitOverdue : null
    };
  }

  async list(q: {
    limit: number; cursor?: string; studySiteId?: string;
    kind?: string[]; state?: string[]; mine?: boolean; openOnly?: boolean; id?: string;
  }) {
    const c = ctx();
    const p = principal();
    const params: unknown[] = [];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const conds = ["true"];
    if (q.id) conds.push(`v.id = ${add(q.id)}`);
    if (q.studySiteId) conds.push(`v.study_site_id = ${add(q.studySiteId)}`);
    if (q.kind?.length) conds.push(`v.kind = ANY(${add(q.kind)})`);
    if (q.state?.length) conds.push(`v.state = ANY(${add(q.state)})`);
    if (q.mine) conds.push(`v.monitor_account_id = ${add(p.accountId)}`);
    if (q.openOnly) conds.push(`v.state <> 'reported'`);
    /* 游标按计划日 + id：同一天排两次监查是常事，只按日期翻页会漏行。 */
    if (q.cursor) {
      const [on, id] = q.cursor.split("|");
      conds.push(`(v.planned_on, v.id) > (${add(on)}::date, ${add(id)}::uuid)`);
    }

    const { rows } = await c.client.query<VRow>(
      `SELECT ${V_COLS} ${V_FROM}
        WHERE ${conds.join(" AND ")}
        ORDER BY v.planned_on, v.id LIMIT ${add(q.limit + 1)}`, params);

    const today = todayStr();
    const pageRows = rows.slice(0, q.limit);
    const last = pageRows.at(-1);
    return {
      items: pageRows.map(r => this.dto(r, today)),
      nextCursor: rows.length > q.limit && last
        ? `${day(last.planned_on)}|${last.id}` : null
    };
  }

  /** 计划与欠账。**统计不分页** —— 分页统计出来的平均是「第一页的平均」。 */
  async board(q: { studyId?: string }) {
    const c = ctx();
    const today = todayStr();
    const params: unknown[] = [];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const siteCond = q.studyId ? `AND s.study_id = ${add(q.studyId)}` : "";

    /* 一条 SQL 把四路质量信号按中心汇到一起。分四次查再在内存里拼，
       会在"某个中心一条质疑都没有"那一支上悄悄丢掉整行。 */
    const { rows } = await c.client.query<{
      id: string; code: string; hospital: string; state: string;
      severe_open: string; minor_open: string; sae_late: string; stale_queries: string;
      last_enrolled_on: Date | null; last_visit_on: Date | null; open_visits: string;
    }>(`
      SELECT s.id, s.code, s.hospital, s.state,
             count(q.id) FILTER (
               WHERE q.state <> 'closed' AND q.kind NOT IN ('query','sae_late')
                 AND q.severity IN ('major','critical')) AS severe_open,
             count(q.id) FILTER (
               WHERE q.state <> 'closed' AND q.kind NOT IN ('query','sae_late')
                 AND q.severity = 'minor') AS minor_open,
             count(q.id) FILTER (
               WHERE q.state <> 'closed' AND q.kind = 'sae_late') AS sae_late,
             count(q.id) FILTER (
               WHERE q.kind = 'query' AND q.state = 'open'
                 AND CURRENT_DATE - q.raised_on > ${add(QUERY_STALE_DAYS)}) AS stale_queries,
             (SELECT max(su.enrolled_on) FROM subject su
               WHERE su.study_site_id = s.id) AS last_enrolled_on,
             (SELECT max(v.performed_on) FROM monitor_visit v
               WHERE v.study_site_id = s.id) AS last_visit_on,
             (SELECT count(*) FROM monitor_visit v
               WHERE v.study_site_id = s.id AND v.state <> 'reported') AS open_visits
        FROM study_site s
        LEFT JOIN quality_event q ON q.study_site_id = s.id
       WHERE NOT app.current_is_external() ${siteCond}
       GROUP BY s.id, s.code, s.hospital, s.state`, params);

    const sites = rows.map(r => {
      const lastEnrolled = day(r.last_enrolled_on);
      const risk: SiteRisk = {
        severeOpen: Number(r.severe_open),
        minorOpen: Number(r.minor_open),
        saeLate: Number(r.sae_late),
        staleQueries: Number(r.stale_queries),
        daysSinceEnroll: lastEnrolled ? between(lastEnrolled, today) : null
      };
      const plan = monitorPlan(risk);
      const lastVisitOn = day(r.last_visit_on);
      const due = monitorDue(lastVisitOn, plan.intervalDays, today);
      return {
        studySiteId: r.id, siteCode: r.code, hospital: r.hospital, siteState: r.state,
        band: plan.band, riskScore: plan.score,
        intervalDays: plan.intervalDays, sdvSamplePct: plan.sdvSamplePct,
        reasons: plan.reasons,
        lastVisitOn, ...due,
        neverVisited: lastVisitOn === null,
        openVisits: Number(r.open_visits)
      };
    }).sort((a, b) =>
      /* 逾期最久的排最前；从没去过的紧随其后（它们没有逾期天数，
         但"一次都没去过"比"逾期 3 天"要紧）；其余按风险分。 */
      (b.overdueDays ?? -1) - (a.overdueDays ?? -1)
      || Number(b.neverVisited) - Number(a.neverVisited)
      || b.riskScore - a.riskScore
      || a.siteCode.localeCompare(b.siteCode));

    /* MVR 负荷按**全部已到现场的访视**算，不只是这一页上的。 */
    const vs = await c.client.query<{ performed_on: Date | null; report_submitted_on: Date | null }>(
      `SELECT v.performed_on, v.report_submitted_on FROM monitor_visit v
         JOIN study_site s ON s.id = v.study_site_id
        WHERE true ${siteCond}`, q.studyId ? [q.studyId] : []);
    const load = mvrLoad(
      vs.rows.map(v => ({
        performedOn: day(v.performed_on), reportSubmittedOn: day(v.report_submitted_on)
      })), today);

    const up = await c.client.query<{ n: string; d: string | null }>(
      `SELECT count(*) AS n, sum(v.days) AS d FROM monitor_visit v
         JOIN study_site s ON s.id = v.study_site_id
        WHERE v.state IN ('proposed','scheduled')
          AND v.planned_on <= CURRENT_DATE + ${UPCOMING_DAYS} ${siteCond}`,
      q.studyId ? [q.studyId] : []);
    const upcomingVisits = Number(up.rows[0]!.n);

    return {
      load, sites,
      upcomingVisits,
      upcomingDays: Number(up.rows[0]!.d ?? 0),
      travelEstimateCents: travelEstimateCents(upcomingVisits, TRAVEL_PER_VISIT_CENTS),
      calcVersion: CALC_VERSION
    };
  }

  private async one(id: string) {
    const c = ctx();
    const { rows } = await c.client.query<VRow>(
      `SELECT ${V_COLS} ${V_FROM} WHERE v.id = $1`, [id]);
    if (!rows[0]) throw notFound("监查访视");
    return rows[0];
  }

  private async reload(id: string) {
    const one = await this.list({ limit: 1, id });
    return one.items[0]!;
  }

  async plan(b: {
    studySiteId: string; kind: string; plannedOn: string;
    monitorAccountId?: string; days: number; sdvSamplePct?: number;
    note?: string; items: string[];
  }) {
    const c = ctx();
    const p = principal();
    const site = await c.client.query<{ id: string; code: string; state: string }>(
      `SELECT id, code, state FROM study_site WHERE id = $1`, [b.studySiteId]);
    if (!site.rows[0]) throw notFound("中心");
    const s = site.rows[0];

    /* 已关闭的中心不再排监查 —— COV 之后还去，说明关闭那一步没做完，
       而那是中心状态的问题，不是排期的问题。 */
    if (s.state === "closed")
      this.invariant("monitor-on-closed-site",
        `${s.code} 已关闭 —— 关闭之后还要去，说明关闭那一步没做完`);

    const monitor = b.monitorAccountId ?? p.accountId;
    const code = `MV-${Date.now().toString(36).toUpperCase()}`;
    const ins = await c.client.query<{ id: string }>(
      `INSERT INTO monitor_visit
         (code, study_site_id, kind, planned_on, monitor_account_id, days,
          state, sdv_sample_pct, note)
       VALUES ($1,$2,$3,$4,$5,$6,'proposed',$7,$8) RETURNING id`,
      [code, b.studySiteId, b.kind, b.plannedOn, monitor, b.days,
       b.sdvSamplePct ?? null, b.note ?? null]);
    const id = ins.rows[0]!.id;
    for (const [seq, task] of b.items.entries())
      await c.client.query(
        `INSERT INTO monitor_visit_item (visit_id, seq, task) VALUES ($1,$2,$3)`,
        [id, seq, task]);

    await this.audit.write({
      action: "排监查访视", targetType: "monitor_visit", targetId: code,
      after: { kind: b.kind, plannedOn: b.plannedOn, items: b.items.length },
      studySiteId: b.studySiteId });

    return {
      data: await this.reload(id),
      sideEffects: [{
        type: "MonitorVisitPlanned",
        summary: `${code} 已排到 ${b.plannedOn}（${b.items.length} 项跟进项）—— ` +
          "还要与中心确认时间",
        ref: id, studySiteId: b.studySiteId
      }]
    };
  }

  async confirm(id: string) {
    const c = ctx();
    const v = await this.one(id);
    if (v.state !== "proposed")
      this.invariant("monitor-already-confirmed", `${v.code} 已经确认过了`);
    await c.client.query(
      `UPDATE monitor_visit SET state = 'scheduled', confirmed_on = CURRENT_DATE
        WHERE id = $1`, [id]);
    await this.audit.write({
      action: "确认监查排期", targetType: "monitor_visit", targetId: v.code,
      before: { state: v.state }, after: { state: "scheduled" },
      studySiteId: v.study_site_id });
    return {
      data: await this.reload(id),
      sideEffects: [{
        type: "MonitorVisitConfirmed",
        summary: `${v.code} 已与 ${v.hospital} 确认 ${day(v.planned_on)}`,
        ref: id, studySiteId: v.study_site_id
      }]
    };
  }

  async perform(id: string, b: { performedOn?: string }) {
    const c = ctx();
    const v = await this.one(id);
    if (v.state === "proposed")
      this.invariant("monitor-not-confirmed",
        `${v.code} 还没与中心确认时间 —— 先确认，否则"去过了"这件事对不上中心的记录`);
    if (v.state !== "scheduled")
      this.invariant("monitor-already-performed", `${v.code} 已经登记过到现场`);

    const on = b.performedOn ?? todayStr();
    if (Date.parse(on) > Date.parse(todayStr()))
      this.invariant("monitor-future-visit", "现场日期不能在将来 —— 还没发生的事不能登记");

    await c.client.query(
      `UPDATE monitor_visit SET state = 'done', performed_on = $2 WHERE id = $1`, [id, on]);
    await this.audit.write({
      action: "登记监查到现场", targetType: "monitor_visit", targetId: v.code,
      before: { state: v.state }, after: { state: "done", performedOn: on },
      studySiteId: v.study_site_id });
    return {
      data: await this.reload(id),
      sideEffects: [{
        type: "MonitorVisitPerformed",
        summary: `${v.code} 已登记到现场（${on}）—— ` +
          `监查报告请在 ${MVR_DUE_DAYS} 天内提交`,
        ref: id, studySiteId: v.study_site_id
      }]
    };
  }

  async setItemDone(id: string, seq: number, b: { done: boolean }) {
    const c = ctx();
    const p = principal();
    const v = await this.one(id);
    /* 报告交上去之后跟进项冻结。交上去的报告和台账对不上，
       比台账上少一项严重得多 —— 核查时两份材料互相打脸。 */
    if (v.state === "reported")
      this.invariant("monitor-report-frozen",
        `${v.code} 的报告已提交，跟进项不能再改 —— 要改就出一份补充报告`);

    const r = await c.client.query(
      b.done
        ? `UPDATE monitor_visit_item SET done_at = now(), done_by = $3
            WHERE visit_id = $1 AND seq = $2`
        : `UPDATE monitor_visit_item SET done_at = NULL, done_by = NULL
            WHERE visit_id = $1 AND seq = $2`,
      b.done ? [id, seq, p.accountId] : [id, seq]);
    if (!r.rowCount) throw notFound("跟进项");

    return {
      data: await this.reload(id),
      sideEffects: [] as { type: string; summary: string; ref?: string }[]
    };
  }

  async submitReport(id: string) {
    const c = ctx();
    const v = await this.one(id);
    if (v.state === "reported")
      this.invariant("monitor-already-reported", `${v.code} 的报告已经提交过了`);
    if (v.state !== "done")
      this.invariant("monitor-not-performed",
        `${v.code} 还没登记到现场 —— 没去过的访视写不出监查报告`);

    /* 拦的时候要说得出拦在哪几项。一句"条件不满足"对要交报告的人
       没有任何用处 —— 与 SIV 闸门同一条规矩。 */
    const open = v.items.filter(i => i.done_at === null);
    if (open.length)
      this.invariant("monitor-items-open",
        `还有 ${open.length} 项跟进项未关闭，监查报告无法提交：` +
        open.slice(0, 5).map(i => i.task).join("；") + (open.length > 5 ? " 等" : ""));

    await c.client.query(
      `UPDATE monitor_visit SET state = 'reported', report_submitted_on = CURRENT_DATE
        WHERE id = $1`, [id]);
    await this.audit.write({
      action: "提交监查报告", targetType: "monitor_visit", targetId: v.code,
      before: { state: v.state }, after: { state: "reported" },
      studySiteId: v.study_site_id });

    const lag = mvrLagDays(
      { performedOn: day(v.performed_on), reportSubmittedOn: todayStr() }, todayStr());
    return {
      data: await this.reload(id),
      sideEffects: [{
        type: "MonitorReportSubmitted",
        summary: `${v.code} 监查报告已提交，距现场 ${lag} 天` +
          (lag !== null && lag > MVR_DUE_DAYS ? ` —— 超过 ${MVR_DUE_DAYS} 天时限` : ""),
        ref: id, studySiteId: v.study_site_id
      }]
    };
  }
}
