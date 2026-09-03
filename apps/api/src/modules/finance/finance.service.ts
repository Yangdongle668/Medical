import { Injectable } from "@nestjs/common";
import {
  arAging, forecastMilestones, cashFlow, roundCents, CALC_VERSION,
  WORKDAYS_PER_MONTH, DAYS_PER_MONTH,
  type CashIn, type MilestonePlan, type SiteForecastInput
} from "@sitedesk/calc";
import { ctx, principal } from "../../infra/ctx.js";
import { siteScopeSql } from "@sitedesk/policy";
import { ProblemException, notFound } from "../../infra/problem.js";
import { AuditService } from "../../infra/audit.service.js";

/* ════════════════════════════════════════════════════════════════════
   里程碑 · 客户 · 现金流。

   服务层照旧只做三件事：取数、调 calc、写审计。**这里不出现算术。**

   一条贯穿的规矩：**「已达成但没开票」不是未来收入。**
   它是记录缺口 —— 钱本来就该收到了，只是没人去开票。
   算进现金流会凭空造出钱，而且是在最不该乐观的那个月。
   ════════════════════════════════════════════════════════════════════ */

const day = (v: Date | null) => v ? v.toISOString().slice(0, 10) : null;
/** 丢掉值为 null 的键 —— 受列权限管辖的字段一律非 nullable。 */
const omitNull = <T extends Record<string, unknown>>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null)) as Partial<T>;

/** 两个**日历日**之间相差几天。两端都归到当地零点 ——
 *  带着时分秒相减，当天到期的会算出「逾期 0 天」，
 *  既进了逾期清单又显示 0 天。 */
const atMidnight = (v: Date) => new Date(v.getFullYear(), v.getMonth(), v.getDate());
const daysBetween = (a: Date, b: Date) =>
  Math.round((atMidnight(b).getTime() - atMidnight(a).getTime()) / 86_400_000);

interface MsRow {
  id: string; code: string; study_site_id: string; site_code: string;
  hospital: string; study_id: string; study_code: string; study_short: string;
  client_name: string; plan_code: string; plan_label: string;
  amount_cents: string; reached_on: Date; state: string;
  invoiced_on: Date | null; due_on: Date | null; paid_on: Date | null;
  note: string | null;
}
const MS_COLS = `
  m.id, m.code, m.study_site_id, s.code AS site_code, s.hospital,
  st.id AS study_id, st.code AS study_code, st.short_name AS study_short,
  cl.name AS client_name, m.plan_code, p.label AS plan_label,
  m.amount_cents, m.reached_on, m.state, m.invoiced_on, m.due_on, m.paid_on, m.note`;
const MS_FROM = `
  FROM milestone m
  JOIN study_site s ON s.id = m.study_site_id
  JOIN study st ON st.id = s.study_id
  JOIN client cl ON cl.id = st.client_id
  JOIN milestone_plan p ON p.code = m.plan_code`;

@Injectable()
export class FinanceService {
  constructor(private readonly audit: AuditService) {}

  private msDto(r: MsRow, today: Date) {
    /* 已回款的不再谈到期 —— 一笔已经到账的钱，「距到期还有几天」没有意义，
       而给它一个负数会让它混进逾期统计。 */
    const open = r.state === "invoiced" && r.due_on !== null;
    const daysToDue = open ? daysBetween(today, r.due_on!) : null;
    return {
      id: r.id, code: r.code,
      studySiteId: r.study_site_id, siteCode: r.site_code, hospital: r.hospital,
      study: { id: r.study_id, code: r.study_code, shortName: r.study_short },
      clientName: r.client_name,
      planCode: r.plan_code, planLabel: r.plan_label,
      milestoneCents: Number(r.amount_cents),
      reachedOn: day(r.reached_on)!,
      state: r.state,
      invoicedOn: day(r.invoiced_on), dueOn: day(r.due_on), paidOn: day(r.paid_on),
      daysToDue,
      /* 「没逾期」和「逾期 0 天」是两回事 —— 前者给 null。 */
      overdueDays: daysToDue !== null && daysToDue < 0 ? -daysToDue : null,
      note: r.note
    };
  }

  async listMilestones(q: {
    limit: number; cursor?: string; studySiteId?: string; studyId?: string;
    clientId?: string; state?: string[];
    receivableOnly?: boolean; overdueOnly?: boolean;
  }) {
    const c = ctx();
    const params: unknown[] = [];
    const conds = ["true"];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    if (q.studySiteId) conds.push(`m.study_site_id = ${add(q.studySiteId)}`);
    if (q.studyId)     conds.push(`st.id = ${add(q.studyId)}`);
    if (q.clientId)    conds.push(`cl.id = ${add(q.clientId)}`);
    if (q.state?.length) conds.push(`m.state = ANY(${add(q.state)}::text[])`);
    if (q.receivableOnly) conds.push(`m.state = 'invoiced'`);
    /* 逾期在 SQL 里判，不在 JS 里筛：这张表会长到几百上千行，
       而"要打电话的那几笔"是最常用的一个筛子。 */
    if (q.overdueOnly) conds.push(`m.state = 'invoiced' AND m.due_on < CURRENT_DATE`);
    if (q.cursor) conds.push(`m.code < ${add(q.cursor)}`);

    const { rows } = await c.client.query<MsRow>(
      `SELECT ${MS_COLS} ${MS_FROM}
        WHERE ${conds.join(" AND ")}
        /* **逾期最久的排最前**：一笔挂了 94 天的应收，
           比今天刚达成的那笔紧急得多。已回款的沉到最后。 */
        ORDER BY (m.state = 'paid'), m.due_on NULLS LAST, m.reached_on DESC
        LIMIT ${add(q.limit + 1)}`, params);

    const today = new Date();
    const items = rows.slice(0, q.limit).map(r => this.msDto(r, today));
    return {
      items, nextCursor: rows.length > q.limit ? items.at(-1)?.code ?? null : null
    };
  }

  async plan() {
    const c = ctx();
    const { rows } = await c.client.query<{
      code: string; label: string; ratio: string; seq: number;
    }>(`SELECT code, label, ratio, seq FROM milestone_plan ORDER BY seq`);
    return { items: rows.map(r => ({ ...r, ratio: Number(r.ratio) })) };
  }

  async arAging(q: { clientId?: string }) {
    const c = ctx();
    const params: unknown[] = [];
    const conds = [`m.state = 'invoiced'`];
    if (q.clientId) { params.push(q.clientId); conds.push(`cl.id = $${params.length}`); }
    const { rows } = await c.client.query<{ amount_cents: string; due_on: Date }>(
      `SELECT m.amount_cents, m.due_on ${MS_FROM} WHERE ${conds.join(" AND ")}`, params);
    const today = new Date();
    return {
      ...arAging(rows.map(r => ({
        amountCents: Number(r.amount_cents),
        daysToDue: daysBetween(today, r.due_on)
      }))),
      calcVersion: CALC_VERSION
    };
  }

  private async oneMs(id: string) {
    const c = ctx();
    const { rows } = await c.client.query<MsRow>(
      `SELECT ${MS_COLS} ${MS_FROM} WHERE m.id = $1`, [id]);
    if (!rows[0]) throw notFound("里程碑");
    return rows[0];
  }

  async invoice(id: string, b: { invoicedOn?: string; note?: string }) {
    const c = ctx();
    const before = await this.oneMs(id);
    if (before.state !== "pending")
      throw new ProblemException("invariant-violated", {
        detail: `${before.code} 已经开过票了（${before.state === "paid" ? "并且已回款" : ""}）` });

    const on = b.invoicedOn ?? new Date().toISOString().slice(0, 10);
    if (on < day(before.reached_on)!)
      throw new ProblemException("invariant-violated", {
        detail: `开票日不能早于达成日（${day(before.reached_on)}）—— 开不出那样的票` });

    /* 到期日 = 开票日 + **客户账期**，在这里算出来并落库固化。
       客户之后改账期，历史发票的到期日不该跟着变。 */
    const { rows } = await c.client.query<{ due_on: Date; terms: number }>(
      `UPDATE milestone m
          SET state = 'invoiced', invoiced_on = $2::date,
              due_on = $2::date + (
                SELECT cl.payment_terms_days FROM study_site s
                  JOIN study st ON st.id = s.study_id
                  JOIN client cl ON cl.id = st.client_id
                 WHERE s.id = m.study_site_id),
              note = coalesce($3, m.note)
        WHERE m.id = $1
        RETURNING due_on, (SELECT cl.payment_terms_days FROM study_site s
                             JOIN study st ON st.id = s.study_id
                             JOIN client cl ON cl.id = st.client_id
                            WHERE s.id = m.study_site_id) AS terms`,
      [id, on, b.note ?? null]);

    await this.audit.write({
      action: "里程碑开票", targetType: "milestone", targetId: before.code,
      before: { state: before.state },
      after: { state: "invoiced", invoicedOn: on, dueOn: day(rows[0]!.due_on) },
      studySiteId: before.study_site_id, reason: b.note ?? null });

    const data = this.msDto(await this.oneMs(id), new Date());
    return {
      data,
      sideEffects: [{
        type: "MilestoneReached" as const,
        summary: `${before.code} 已开票，账期 ${rows[0]!.terms} 天 —— ` +
          `${data.dueOn} 到期`,
        ref: id, amountCents: Number(before.amount_cents),
        studySiteId: before.study_site_id
      }]
    };
  }

  async pay(id: string, b: { paidOn?: string; note?: string }) {
    const c = ctx();
    const before = await this.oneMs(id);
    if (before.state === "pending")
      throw new ProblemException("invariant-violated", {
        detail: `${before.code} 还没开票 —— 没有票的钱记不进来` });
    /* **已回款的不能改回去。** 钱到账是一件不可撤销的事实；
       写错了要走冲销，不是改状态。 */
    if (before.state === "paid")
      throw new ProblemException("invariant-violated", {
        detail: `${before.code} 已经登记过回款了（${day(before.paid_on)}）——` +
          "钱到账是不可撤销的事实，写错了要走冲销" });

    const on = b.paidOn ?? new Date().toISOString().slice(0, 10);
    if (on < day(before.invoiced_on)!)
      throw new ProblemException("invariant-violated", {
        detail: `回款日不能早于开票日（${day(before.invoiced_on)}）` });

    await c.client.query(
      `UPDATE milestone SET state = 'paid', paid_on = $2::date,
              note = coalesce($3, note) WHERE id = $1`, [id, on, b.note ?? null]);
    await this.audit.write({
      action: "里程碑回款", targetType: "milestone", targetId: before.code,
      before: { state: before.state }, after: { state: "paid", paidOn: on },
      studySiteId: before.study_site_id, reason: b.note ?? null });

    const late = daysBetween(before.due_on!, new Date(on));
    return {
      data: this.msDto(await this.oneMs(id), new Date()),
      sideEffects: [{
        type: "MilestoneReached" as const,
        summary: late > 0
          ? `${before.code} 已回款，比约定晚了 ${late} 天`
          : `${before.code} 已回款`,
        ref: id, amountCents: Number(before.amount_cents),
        studySiteId: before.study_site_id
      }]
    };
  }

  /* ── 客户 ─────────────────────────────────────────────────────── */

  async listClients(q: { limit: number; cursor?: string; q?: string }) {
    const c = ctx();
    const sc = siteScopeSql(principal(), "s", 1);
    const params: unknown[] = [...sc.params];
    const conds = ["true"];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    if (q.q) conds.push(`cl.name ILIKE ${add(`%${q.q}%`)}`);
    if (q.cursor) conds.push(`cl.name > ${add(q.cursor)}`);

    /* **一条查询装配全部** —— 按客户逐个去打项目、中心、里程碑，
       四个客户就是十三条查询，而这一页的存在理由正是"跨项目的账"。 */
    const { rows } = await c.client.query<{
      id: string; name: string; since_year: number | null; contact: string | null;
      payment_terms_days: number; nps: number | null; note: string | null;
      study_count: string; site_count: string; enrolled: string;
      planned_subjects: string; contract_cents: string;
      paid_cents: string; receivable_cents: string; overdue_cents: string;
      ar_days: string | null;
    }>(`
      WITH visible AS (
        SELECT s.id, s.study_id FROM study_site s WHERE ${sc.sql}
      )
      SELECT cl.id, cl.name, cl.since_year, cl.contact, cl.payment_terms_days,
             cl.nps, cl.note,
             count(DISTINCT st.id)                                  AS study_count,
             count(DISTINCT v.id)                                   AS site_count,
             coalesce(sum(sub.enrolled), 0)                         AS enrolled,
             coalesce(max(st.planned_subjects), 0)                  AS planned_subjects,
             coalesce(sum(DISTINCT st.contract_amount_cents), 0)    AS contract_cents,
             coalesce(sum(ms.paid), 0)                              AS paid_cents,
             coalesce(sum(ms.receivable), 0)                        AS receivable_cents,
             coalesce(sum(ms.overdue), 0)                           AS overdue_cents,
             avg(ms.ar_days)                                        AS ar_days
        FROM client cl
        JOIN study st ON st.client_id = cl.id
        JOIN visible v ON v.study_id = st.id
        LEFT JOIN LATERAL (
          SELECT count(*) FILTER (
            WHERE sj.state IN ('enrolled','completed','withdrawn')) AS enrolled
            FROM subject sj WHERE sj.study_site_id = v.id) sub ON true
        LEFT JOIN LATERAL (
          SELECT
            coalesce(sum(m.amount_cents) FILTER (WHERE m.state = 'paid'), 0) AS paid,
            coalesce(sum(m.amount_cents) FILTER (WHERE m.state = 'invoiced'), 0) AS receivable,
            coalesce(sum(m.amount_cents) FILTER (
              WHERE m.state = 'invoiced' AND m.due_on < CURRENT_DATE), 0) AS overdue,
            avg(CURRENT_DATE - m.invoiced_on) FILTER (
              WHERE m.state = 'invoiced') AS ar_days
            FROM milestone m WHERE m.study_site_id = v.id) ms ON true
       WHERE ${conds.join(" AND ")}
       GROUP BY cl.id
       ORDER BY cl.name
       LIMIT ${add(q.limit + 1)}`, params);

    const items = rows.slice(0, q.limit).map(r => ({
      id: r.id, name: r.name, sinceYear: r.since_year, contact: r.contact,
      paymentTermsDays: r.payment_terms_days, nps: r.nps, note: r.note,
      studyCount: Number(r.study_count), siteCount: Number(r.site_count),
      enrolled: Number(r.enrolled), plannedSubjects: Number(r.planned_subjects),
      contractCents: Number(r.contract_cents),
      paidCents: Number(r.paid_cents),
      receivableCents: Number(r.receivable_cents),
      overdueCents: Number(r.overdue_cents),
      /* 没有应收时是 null，不是 0 —— 「一笔都没欠」和「平均欠 0 天」是两回事。 */
      meanArDays: r.ar_days === null ? null : Number(r.ar_days)
    }));
    return {
      items, nextCursor: rows.length > q.limit ? items.at(-1)?.name ?? null : null
    };
  }

  async updateClient(id: string, b: {
    sinceYear?: number | null; contact?: string | null;
    paymentTermsDays?: number; nps?: number | null; note?: string | null;
  }) {
    const c = ctx();
    const before = await c.client.query<{ name: string; payment_terms_days: number }>(
      `SELECT name, payment_terms_days FROM client WHERE id = $1`, [id]);
    if (!before.rows[0]) throw notFound("客户");

    const sets: string[] = [];
    const params: unknown[] = [id];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    if (b.sinceYear !== undefined) sets.push(`since_year = ${add(b.sinceYear)}`);
    if (b.contact !== undefined) sets.push(`contact = ${add(b.contact)}`);
    if (b.paymentTermsDays !== undefined)
      sets.push(`payment_terms_days = ${add(b.paymentTermsDays)}`);
    if (b.nps !== undefined) sets.push(`nps = ${add(b.nps)}`);
    if (b.note !== undefined) sets.push(`note = ${add(b.note)}`);
    if (sets.length)
      await c.client.query(
        `UPDATE client SET ${sets.join(", ")} WHERE id = $1`, params);

    await this.audit.write({
      action: "改客户档案", targetType: "client", targetId: before.rows[0].name,
      before: { paymentTermsDays: before.rows[0].payment_terms_days },
      after: { paymentTermsDays: b.paymentTermsDays ?? before.rows[0].payment_terms_days },
      reason: null });

    const one = await this.listClients({ limit: 1000 });
    const found = one.items.find(x => x.id === id);
    if (!found) throw notFound("客户");
    return found;
  }

  /* ── 现金流 ───────────────────────────────────────────────────── */

  async cashForecast(months = 6) {
    const c = ctx();
    const sc = siteScopeSql(principal(), "s", 1);
    const today = new Date();

    const [plan, msRows, siteRows, burn] = await Promise.all([
      this.plan(),
      /* 已达成、还没回款的：这些是**确定的**未来现金。 */
      c.client.query<MsRow>(
        `SELECT ${MS_COLS} ${MS_FROM} WHERE m.state <> 'paid'`),
      /* 每个中心的现状，够推出还有哪几段没收。 */
      c.client.query<{
        id: string; contract_cents: string; contracted: number; enrolled: string;
        reached: string[]; state: string; fpi_on: Date | null;
        siv_planned_on: Date | null;
      }>(`
        SELECT s.id,
               (s.startup_fee_cents + s.contracted * s.unit_price_cents) AS contract_cents,
               s.contracted, s.state, s.fpi_on, s.siv_planned_on,
               (SELECT count(*) FROM subject sj
                 WHERE sj.study_site_id = s.id
                   AND sj.state IN ('enrolled','completed','withdrawn')) AS enrolled,
               coalesce((SELECT array_agg(m.plan_code) FROM milestone m
                          WHERE m.study_site_id = s.id), '{}') AS reached
          FROM study_site s
         WHERE ${sc.sql}
           /* **预测那一半要跟着里程碑的可见性走，不是中心的。**
              milestone 与 client 两张表对外部方整表关闭，而中心表不是 ——
              机构办看得见本院的中心。少了这一条，一个机构办会在现金流上
              看到「入组达成 80%（预计）」这样一行：金额被列权限抹掉了，
              但**这个中心快拿到一笔钱**这件事本身就是商业信息。
              第一版就漏了它，集成测试当场照出来。

              （注：这段注释里不能出现反引号 —— 它在一个模板字符串里，
              一个反引号就会把整条 SQL 截断，而报错指向几十行以外。） */
           AND NOT app.current_is_external()`, sc.params),
      this.monthlyBurn()
    ]);

    const planForCalc: MilestonePlan = plan.items.map(p => ({ code: p.code, ratio: p.ratio }));
    const ins: CashIn[] = [];

    /* ① 已开票未回款：**按到期日落月**。 */
    for (const m of msRows.rows) {
      const amt = Number(m.amount_cents);
      if (m.state === "invoiced" && m.due_on) {
        const d = daysBetween(today, m.due_on);
        const mo = Math.max(1, Math.ceil(d / DAYS_PER_MONTH));
        ins.push({
          amountCents: amt, month: mo,
          label: `${m.code} ${m.hospital} ${m.plan_label}`,
          kind: d < 0 ? "overdue" : "invoiced"
        });
      } else if (m.state === "pending") {
        /* ② 待开票：假设两周内开票，再走一个账期 —— 粗估落在第 3 个月。
           它是**已经发生的事实**（里程碑达成了），只是流程还没走完，
           所以进现金，但标成 pending：压力情景里不推迟它。 */
        ins.push({
          amountCents: amt, month: Math.min(3, months),
          label: `${m.code} ${m.hospital} ${m.plan_label}（待开票）`,
          kind: "pending"
        });
      }
    }

    /* ③ 预计将达成的：按入组速度推，达成月 + 2 个月账期。
       **gap（已达成却不在台账里）的不进现金** —— 那是记录缺口。 */
    let recordGapCents = 0, recordGapCount = 0;
    for (const s of siteRows.rows) {
      const enrolled = Number(s.enrolled);
      const monthsSinceFpi = s.fpi_on
        ? Math.max(1, daysBetween(s.fpi_on, today) / DAYS_PER_MONTH) : null;
      const input: SiteForecastInput = {
        contractCents: Number(s.contract_cents),
        contracted: s.contracted,
        enrolled,
        reached: s.reached,
        velocityPerMonth: monthsSinceFpi ? enrolled / monthsSinceFpi : null,
        monthsToSiv: PAST_SIV.includes(s.state) ? 0
          : s.siv_planned_on
            ? Math.max(0, daysBetween(today, s.siv_planned_on) / DAYS_PER_MONTH)
            : null,
        contractSigned: SIGNED.includes(s.state)
      };
      for (const f of forecastMilestones(input, planForCalc)) {
        if (f.gap) { recordGapCents += f.amountCents; recordGapCount++; continue; }
        const mo = Math.ceil(f.inMonths) + 2;
        if (mo <= months)
          ins.push({
            amountCents: f.amountCents, month: mo,
            label: `${planLabel(plan.items, f.planCode)}（预计）`,
            kind: "forecast"
          });
      }
    }

    const start = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
    const f = cashFlow(ins, burn.burnCents, months, start, recordGapCents);
    return {
      months: f.months.map(m => ({
        month: m.month, inCents: m.inCents, outCents: m.outCents,
        netCents: m.netCents, cumCents: m.cumCents,
        items: m.items.map(i =>
          ({ label: i.label, inflowCents: i.amountCents, kind: i.kind }))
      })),
      burnCents: f.burnCents, headcount: burn.headcount,
      troughCents: f.troughCents, troughMonth: f.troughMonth,
      stress: {
        months: f.stress.months.map(m => ({
          month: m.month, inCents: m.inCents, outCents: m.outCents,
          netCents: m.netCents, cumCents: m.cumCents,
          items: m.items.map(i =>
            ({ label: i.label, inflowCents: i.amountCents, kind: i.kind }))
        })),
        troughCents: f.stress.troughCents, troughMonth: f.stress.troughMonth
      },
      recordGapCents, recordGapCount,
      calcVersion: CALC_VERSION
    };
  }

  /** 每月刚性支出：在职人力 × 现行费率 × 月均工作日，再加管理分摊。
   *
   *  **只算在职的** —— 停用的账号不发工资，把他们算进去会让缺口
   *  看起来比实际更早到来，而这一页最怕的就是狼来了。 */
  private async monthlyBurn() {
    const c = ctx();
    const { rows } = await c.client.query<{ n: string; direct: string }>(`
      SELECT count(*) AS n,
             coalesce(sum(r.day_cost_cents), 0) AS direct
        FROM staff st
        JOIN account a ON a.id = st.account_id AND a.status = 'active'
        CROSS JOIN LATERAL app.rate_on(st.role_kind, st.level, CURRENT_DATE) r`);
    const perDay = Number(rows[0]?.direct ?? 0);
    /* 管理分摊按项目的 overhead_rate —— 取一个租户级的代表值：
       各项目的费率在种子里是同一个，真分叉时这里要按人头归属摊，
       而人头归属这套系统现在还没有。**先用最大值，偏保守。** */
    const oh = await c.client.query<{ rate: string }>(
      `SELECT coalesce(max(overhead_rate), 0) AS rate FROM study`);
    const direct = roundCents(perDay * WORKDAYS_PER_MONTH);
    return {
      headcount: Number(rows[0]?.n ?? 0),
      burnCents: direct + roundCents(direct * Number(oh.rows[0]?.rate ?? 0))
    };
  }
}

/** 「已经启动过了」的那几个状态 —— 与 site.service 的 INVALIDATED 同源。 */
const PAST_SIV = ["siv", "enrolling", "enrolled", "followup", "closed"];
/** 合同已签（状态机已过「合同签署」）。 */
const SIGNED = ["contract", ...PAST_SIV];

const planLabel = (items: { code: string; label: string }[], code: string) =>
  items.find(p => p.code === code)?.label ?? code;
