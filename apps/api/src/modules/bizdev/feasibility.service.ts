import { Injectable } from "@nestjs/common";
import {
  feasibilityScore, feasibilityBias, CALC_VERSION,
  type FeasibilityAnswers
} from "@sitedesk/calc";
import { ctx, principal } from "../../infra/ctx.js";
import { ProblemException, notFound } from "../../infra/problem.js";
import { AuditService } from "../../infra/audit.service.js";

/* ════════════════════════════════════════════════════════════════════
   中心可行性调查。

   服务层照旧只做三件事：取数、调 calc、写审计。
   **这里不出现任何算术** —— 评分口径在 `@sitedesk/calc`，
   前端拿到的是算好的结果加逐项拆解，不是一份问卷让它自己算。
   同一套口径出现在两个地方，迟早分叉；分叉那天，
   一家医院会因为看哪个页面而得到不同的结论。
   ════════════════════════════════════════════════════════════════════ */

const day = (v: Date | null) => v ? v.toISOString().slice(0, 10) : null;
const num = (v: string | number | null) => v === null ? null : Number(v);

/** 低于这条线入选，必须写理由。与 `feasibilityScore` 的 good 线同一个数 ——
 *  写死两遍会在调口径时漏掉一处，于是"要不要填理由"和"页面上标不标红"
 *  会各说各话。 */
const OVERRIDE_BELOW = 65;

interface Row {
  id: string; code: string;
  study_id: string; study_code: string; study_short: string;
  hospital: string; city: string; dept: string; pi_name: string;
  surveyed_on: Date; surveyed_by_name: string | null;
  pt_year: number; past_n: number; past_best: string; compet: number;
  ethics_days: number; start_days: number; team_n: number;
  pi_commit: string; elig_pct: string | null;
  status: string; decided_on: Date | null; decided_by_name: string | null;
  study_site_id: string | null; site_code: string | null;
  override_reason: string | null; reject_reason: string | null;
  actual_rate: string | null;
}

const COLS = `
  f.id, f.code, f.study_id, st.code AS study_code, st.short_name AS study_short,
  f.hospital, f.city, f.dept, f.pi_name,
  f.surveyed_on, sb.display_name AS surveyed_by_name,
  f.pt_year, f.past_n, f.past_best, f.compet, f.ethics_days, f.start_days,
  f.team_n, f.pi_commit, f.elig_pct,
  f.status, f.decided_on, db.display_name AS decided_by_name,
  f.study_site_id, ss.code AS site_code,
  f.override_reason, f.reject_reason, f.actual_rate`;
const FROM = `
  FROM feasibility f
  JOIN study st ON st.id = f.study_id
  LEFT JOIN account sb ON sb.id = f.surveyed_by
  LEFT JOIN account db ON db.id = f.decided_by
  LEFT JOIN study_site ss ON ss.id = f.study_site_id`;

function answersOf(r: Row): FeasibilityAnswers {
  return {
    ptYear: r.pt_year, pastN: r.past_n, pastBest: Number(r.past_best),
    compet: r.compet, ethicsDays: r.ethics_days, startDays: r.start_days,
    teamN: r.team_n, piCommit: Number(r.pi_commit),
    /* **null 要原样传下去。** 用 0 代替它，那家"当时根本没问过入排匹配度"
       的医院会变成"入排匹配度是 0"，扣满 9 分 —— 而那次教训
       （评分 82 入选、实际筛败率 57%）恰恰是因为当时没有这一栏。 */
    eligPct: r.elig_pct === null ? null : Number(r.elig_pct)
  };
}

function toDto(r: Row) {
  const answers = answersOf(r);
  const s = feasibilityScore(answers);
  const actualRate = num(r.actual_rate);
  return {
    id: r.id, code: r.code,
    study: { id: r.study_id, code: r.study_code, shortName: r.study_short },
    hospital: r.hospital, city: r.city, dept: r.dept, piName: r.pi_name,
    surveyedOn: day(r.surveyed_on)!, surveyedByName: r.surveyed_by_name,
    answers,
    score: { ...s, calcVersion: CALC_VERSION },
    status: r.status,
    decidedOn: day(r.decided_on), decidedByName: r.decided_by_name,
    studySiteId: r.study_site_id, siteCode: r.site_code,
    overrideReason: r.override_reason, rejectReason: r.reject_reason,
    actualRate,
    bias: actualRate === null ? null
      : feasibilityBias(actualRate, s.predictedPerMonth)
  };
}

@Injectable()
export class FeasibilityService {
  constructor(private readonly audit: AuditService) {}

  async list(q: {
    limit: number; cursor?: string; studyId?: string;
    status?: string[]; overrideOnly?: boolean; q?: string;
  }) {
    const c = ctx();
    const params: unknown[] = [];
    const conds = ["true"];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    if (q.studyId) conds.push(`f.study_id = ${add(q.studyId)}`);
    if (q.status?.length) conds.push(`f.status = ANY(${add(q.status)}::text[])`);
    if (q.q) conds.push(`f.hospital ILIKE ${add(`%${q.q}%`)}`);
    if (q.cursor) conds.push(`f.code < ${add(q.cursor)}`);

    const { rows } = await c.client.query<Row>(
      `SELECT ${COLS} ${FROM}
        WHERE ${conds.join(" AND ")}
        ORDER BY f.code DESC LIMIT ${add(q.limit + 1)}`, params);

    let items = rows.slice(0, q.limit).map(toDto);
    /* overrideOnly 在**装配之后**筛：判据是分数，而分数是算出来的，
       SQL 里没有它。想在 SQL 里筛就得把评分口径抄进一条 WHERE ——
       那正是第二套口径的来源。
       这一页的数据量是"候选中心"，几十到几百条，这么筛是划算的。 */
    if (q.overrideOnly)
      items = items.filter(i => i.status === "selected" && i.score.total < OVERRIDE_BELOW);
    return {
      items,
      nextCursor: rows.length > q.limit ? items.at(-1)?.code ?? null : null
    };
  }

  /** 口径的回顾。**这是这一页存在的第二个理由。** */
  async calibration() {
    const c = ctx();
    const { rows } = await c.client.query<Row>(
      `SELECT ${COLS} ${FROM} WHERE f.status = 'selected'`);
    const all = rows.map(toDto);
    const withActual = all.filter(x => x.bias !== null);
    const overrides = all.filter(x => x.score.total < OVERRIDE_BELOW);
    return {
      selected: withActual.length,
      meanBias: withActual.length
        ? withActual.reduce((n, x) => n + x.bias!, 0) / withActual.length : null,
      overrides: overrides.length,
      /* 「当初说了不行」的兑现次数。月入组低于 1 例的中心，
         在一个 20 个月的入组期里最多贡献 20 例 —— 而它占着一份合同例数。 */
      overridesGoneBad: overrides.filter(
        x => x.actualRate !== null && x.actualRate < 1).length,
      calcVersion: CALC_VERSION
    };
  }

  private async one(id: string) {
    const c = ctx();
    const { rows } = await c.client.query<Row>(
      `SELECT ${COLS} ${FROM} WHERE f.id = $1`, [id]);
    if (!rows[0]) throw notFound("可行性调查");
    return rows[0];
  }

  async create(b: {
    studyId: string; hospital: string; city: string; dept: string;
    piName: string; surveyedOn: string; answers: FeasibilityAnswers;
  }) {
    const c = ctx();
    const p = principal();
    /* 编号在**库里**数，不在应用里数：应用里"读一次 count 再加一"要两个
       往返，中间隔着整个网络延迟。放进一条 INSERT 之后窗口收窄到一条语句。

       **但它不是完全无竞态的** —— 两个并发事务仍可能读到同一个 count。
       真正挡住重号的是 `UNIQUE (tenant_id, code)`：撞上了是一次插入被拒，
       不是两条一样的编号。这个取舍是有意的：重号的代价是台账对不上，
       而偶尔一次"请重试"是可以接受的。要彻底消掉竞态得按年开序列，
       而那会在跨年时带来另一类麻烦。 */
    const year = b.surveyedOn.slice(0, 4);
    const a = b.answers;
    const { rows } = await c.client.query<{ id: string }>(
      `INSERT INTO feasibility (
         code, study_id, hospital, city, dept, pi_name, surveyed_on, surveyed_by,
         pt_year, past_n, past_best, compet, ethics_days, start_days,
         team_n, pi_commit, elig_pct)
       VALUES (
         'FS-' || $1 || '-' || lpad((
           SELECT count(*) + 1 FROM feasibility
            WHERE tenant_id = app.current_tenant_id()
              AND code LIKE 'FS-' || $1 || '-%')::text, 3, '0'),
         $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       RETURNING id`,
      [year, b.studyId, b.hospital, b.city, b.dept, b.piName, b.surveyedOn,
       p.accountId, a.ptYear, a.pastN, a.pastBest, a.compet, a.ethicsDays,
       a.startDays, a.teamN, a.piCommit, a.eligPct]);

    const dto = toDto(await this.one(rows[0]!.id));
    await this.audit.write({
      action: "登记可行性调查", targetType: "feasibility", targetId: dto.code,
      after: { hospital: dto.hospital, score: Math.round(dto.score.total) },
      reason: null });
    return dto;
  }

  async decide(id: string, b: { decision: "selected" | "rejected"; reason?: string }) {
    const c = ctx();
    const p = principal();
    const before = await this.one(id);
    if (before.status !== "assessing")
      throw new ProblemException("invariant-violated", {
        detail: `${before.code} 已经定过了（${before.status === "selected" ? "已入选" : "未入选"}）` +
          " —— 决定不能改，要改就重新做一次调查" });

    const score = feasibilityScore(answersOf(before));
    const reason = b.reason?.trim() ?? "";
    /* **系统不阻止低分入选** —— 它拦不住，也不该拦：商务上的取舍
       本来就不归一套评分决定。但它必须留下一句话。
       拒绝同样要写：申办方问「为什么没选这家」，
       「评分不够」不是答案，「年就诊 45 例、既往没做过」才是。 */
    const needsReason =
      b.decision === "rejected" || score.total < OVERRIDE_BELOW;
    if (needsReason && reason.length < 4)
      throw new ProblemException("invariant-violated", {
        detail: b.decision === "rejected"
          ? "拒绝必须写理由 —— 申办方问「为什么没选这家」时，「评分不够」不是答案"
          : `${before.code} 评分 ${Math.round(score.total)} 分，低于 ${OVERRIDE_BELOW} 分。` +
            "入选它不被阻止，但必须写下理由 —— 半年后复盘「这家怎么会选进来」时，" +
            "有那句话和没有那句话，是完全不同的两次会" });

    await c.client.query(
      `UPDATE feasibility
          SET status = $2, decided_on = CURRENT_DATE, decided_by = $3,
              override_reason = CASE WHEN $2 = 'selected' AND $4 <> '' THEN $4 ELSE NULL END,
              reject_reason   = CASE WHEN $2 = 'rejected' THEN $4 ELSE NULL END
        WHERE id = $1`, [id, b.decision, p.accountId, reason]);

    await this.audit.write({
      action: b.decision === "selected" ? "入选候选中心" : "拒绝候选中心",
      targetType: "feasibility", targetId: before.code,
      before: { status: before.status },
      after: { status: b.decision, score: Math.round(score.total) },
      reason: reason || null });

    const data = toDto(await this.one(id));
    /* 低分入选要在界面上说一句 —— 它已经写进审计了，
       但当场看见和事后查出来是两回事。 */
    const sideEffects = b.decision === "selected" && score.total < OVERRIDE_BELOW
      ? [{
          type: "FeasibilityOverride" as const,
          summary: `${data.hospital} 评分 ${Math.round(score.total)} 分入选 —— ` +
            `预测月入组约 ${data.score.predictedPerMonth.toFixed(1)} 例，` +
            "理由已记入审计轨迹",
          ref: data.id
        }]
      : [];
    return { data, sideEffects };
  }

  async recordActual(id: string, actualRate: number) {
    const c = ctx();
    const before = await this.one(id);
    if (before.status !== "selected")
      throw new ProblemException("invariant-violated", {
        detail: `${before.code} 没有入选 —— 只有入选的中心谈得上实际入组速度` });

    await c.client.query(
      `UPDATE feasibility SET actual_rate = $2 WHERE id = $1`, [id, actualRate]);
    await this.audit.write({
      action: "回填实际月入组", targetType: "feasibility", targetId: before.code,
      before: { actualRate: num(before.actual_rate) }, after: { actualRate },
      reason: null });

    const data = toDto(await this.one(id));
    /* 预测偏得离谱要说出来。**这条提示是这套口径能被质疑的唯一入口** ——
       比值持续小于 1 说明 PI 承诺系数该往下调，而没人会去主动看那张回顾表。 */
    const sideEffects = data.bias !== null && (data.bias < 0.5 || data.bias > 2)
      ? [{
          type: "FeasibilityBias" as const,
          summary: `实际是预测的 ${(data.bias * 100).toFixed(0)}% —— ` +
            (data.bias < 0.5
              ? "这套评分对这家医院打得太乐观了，去「口径回顾」看看是不是系统性的"
              : "这套评分打得偏保守，可能漏掉了同样条件的候选中心"),
          ref: data.id
        }]
      : [];
    return { data, sideEffects };
  }
}
