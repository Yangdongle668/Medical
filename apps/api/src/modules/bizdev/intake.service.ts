import { Injectable } from "@nestjs/common";
import {
  intakeMath, filingGap, INTAKE_GM_GATE, CALC_VERSION
} from "@sitedesk/calc";
import { ctx, principal } from "../../infra/ctx.js";
import { ProblemException, notFound } from "../../infra/problem.js";
import { AuditService } from "../../infra/audit.service.js";

/* ════════════════════════════════════════════════════════════════════
   立项与建档。

   ── 项目是怎么进系统的 ────────────────────────────────────────────
   在此之前 `study` 的第一行是凭空出现的。真实系统里，一个项目要先有人
   提出来、有人算过账、有人批准，然后才有档案。

   ── 批准与建档在同一个事务里 ──────────────────────────────────────
   约束上「已批准」与「有项目档案」互为充要条件（迁移 0037），
   所以不存在「批准了但档案没建」这一格 ——
   而那是这条流程最容易漏的一格：批的人以为建了，做的人以为批完会自动建。

   ── 服务层不出现算术 ──────────────────────────────────────────────
   毛利率、保本合同额、建档滞后都在 @sitedesk/calc 里。
   毛利率尤其不能接受调用方传入：**一个可以自己报毛利率的申请，
   门槛就形同虚设。**
   ════════════════════════════════════════════════════════════════════ */

const day = (v: Date | null) => v ? v.toISOString().slice(0, 10) : null;
/** 丢掉值为 null 的键 —— 受列权限管辖的字段一律非 nullable。 */
const omitNull = <T extends Record<string, unknown>>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null)) as Partial<T>;

interface IRow {
  id: string; code: string; drug: string; sponsor_name: string;
  phase: string; indication: string;
  planned_sites: number; planned_subjects: number; enroll_months: number;
  contract_cents: string; estimated_cost_cents: string;
  note: string | null;
  submitted_by: string; submitted_by_name: string; submitted_on: Date;
  state: string; decided_by_name: string | null; decided_on: Date | null;
  decision_note: string | null;
  study_id: string | null; study_code: string | null;
}

const I_COLS = `
  i.id, i.code, i.drug, i.sponsor_name, i.phase, i.indication,
  i.planned_sites, i.planned_subjects, i.enroll_months,
  i.contract_cents, i.estimated_cost_cents, i.note,
  i.submitted_by, sb.display_name AS submitted_by_name, i.submitted_on,
  i.state, db.display_name AS decided_by_name, i.decided_on, i.decision_note,
  i.study_id, st.code AS study_code`;
const I_FROM = `
  FROM intake_application i
  JOIN account sb ON sb.id = i.submitted_by
  LEFT JOIN account db ON db.id = i.decided_by
  LEFT JOIN study st ON st.id = i.study_id`;

@Injectable()
export class IntakeService {
  constructor(private readonly audit: AuditService) {}

  private invariant(name: string, detail: string): never {
    throw new ProblemException("invariant-violated", { detail, invariant: name });
  }

  private dto(r: IRow) {
    const m = intakeMath({
      contractCents: Number(r.contract_cents),
      estimatedCostCents: Number(r.estimated_cost_cents),
      plannedSubjects: r.planned_subjects,
      plannedSites: r.planned_sites
    });
    return {
      id: r.id, code: r.code, drug: r.drug, sponsorName: r.sponsor_name,
      phase: r.phase, indication: r.indication,
      plannedSites: r.planned_sites, plannedSubjects: r.planned_subjects,
      enrollMonths: r.enroll_months,
      ...omitNull({
        contractCents: Number(r.contract_cents),
        estimatedCostCents: Number(r.estimated_cost_cents),
        grossCents: m.grossCents,
        grossMargin: m.grossMargin,
        perSubjectCents: m.perSubjectCents,
        breakEvenContractCents: m.breakEvenContractCents
      }),
      belowGate: m.belowGate,
      subjectsPerSite: m.subjectsPerSite,
      note: r.note,
      submittedBy: r.submitted_by, submittedByName: r.submitted_by_name,
      submittedOn: day(r.submitted_on)!,
      state: r.state,
      decidedByName: r.decided_by_name, decidedOn: day(r.decided_on),
      decisionNote: r.decision_note,
      studyId: r.study_id, studyCode: r.study_code
    };
  }

  async list(q: {
    limit: number; cursor?: string; state?: string[];
    mine?: boolean; belowGateOnly?: boolean; id?: string;
  }) {
    const c = ctx();
    const p = principal();
    const params: unknown[] = [];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const conds = ["true"];
    if (q.id) conds.push(`i.id = ${add(q.id)}`);
    if (q.state?.length) conds.push(`i.state = ANY(${add(q.state)})`);
    if (q.mine) conds.push(`i.submitted_by = ${add(p.accountId)}`);
    /* 越线判定在 calc 里，但**筛选要在 SQL 里** ——
       取回来再筛会让 limit 变成"取 20 条里越线的几条"。
       算式两处写等于两套口径，所以这里用的是同一个门槛常量。 */
    if (q.belowGateOnly)
      conds.push(`(i.contract_cents = 0
                   OR (i.contract_cents - i.estimated_cost_cents)::numeric
                      / i.contract_cents < ${add(INTAKE_GM_GATE)})`);
    if (q.cursor) conds.push(`i.id < ${add(q.cursor)}`);

    const { rows } = await c.client.query<IRow>(
      `SELECT ${I_COLS} ${I_FROM}
        WHERE ${conds.join(" AND ")}
        ORDER BY i.submitted_on DESC, i.id DESC LIMIT ${add(q.limit + 1)}`, params);

    const pageRows = rows.slice(0, q.limit);
    /* 越线的排最前 —— 按提交日排的话，最该看的那几条会沉在底下。
       翻页游标仍按 id：排序是展示口径，游标是稳定口径，两者不必相同。 */
    const items = pageRows.map(r => this.dto(r))
      .sort((a, b) => Number(b.belowGate) - Number(a.belowGate)
        || b.submittedOn.localeCompare(a.submittedOn));
    return {
      items,
      nextCursor: rows.length > q.limit ? pageRows.at(-1)?.id ?? null : null
    };
  }

  async board() {
    const c = ctx();
    const open = await c.client.query<IRow>(
      `SELECT ${I_COLS} ${I_FROM} WHERE i.state = 'submitted'`);
    const dtos = open.rows.map(r => this.dto(r));

    const studies = await c.client.query<{
      id: string; code: string; short_name: string; client_name: string;
      phase: string; planned_subjects: number; planned_sites: number;
      built: string; contract_amount_cents: string;
    }>(`SELECT st.id, st.code, st.short_name, cl.name AS client_name, st.phase,
               st.planned_subjects, st.planned_sites,
               (SELECT count(*) FROM study_site s WHERE s.study_id = st.id) AS built,
               st.contract_amount_cents
          FROM study st JOIN client cl ON cl.id = st.client_id
         ORDER BY st.code`);

    const rows = studies.rows.map(r => {
      const g = filingGap(r.planned_sites, Number(r.built));
      return {
        studyId: r.id, studyCode: r.code, shortName: r.short_name,
        clientName: r.client_name, phase: r.phase,
        plannedSubjects: r.planned_subjects,
        plannedSites: g.plannedSites, builtSites: g.builtSites,
        missingSites: g.missing, filedRatio: g.filedRatio,
        ...omitNull({ contractCents: Number(r.contract_amount_cents) })
      };
    }).sort((a, b) => b.missingSites - a.missingSites
      || a.studyCode.localeCompare(b.studyCode));

    return {
      open: dtos.length,
      belowGate: dtos.filter(d => d.belowGate).length,
      /* 受列权限管辖的字段照常发出去 —— **删字段的是 MaskInterceptor**，
         不是这里。在这里自己判断"看不看得到"，等于把列权限抄了第二份。
         omitNull 只负责真的为 null 的那些（毛利率算不出来时）。 */
      openContractCents: dtos.reduce(
        (n, d) => n + (d.contractCents ?? 0), 0),
      gmGate: INTAKE_GM_GATE,
      studies: rows,
      missingSites: rows.reduce((n, r) => n + r.missingSites, 0),
      calcVersion: CALC_VERSION
    };
  }

  private async reload(id: string) {
    const one = await this.list({ limit: 1, id });
    if (!one.items[0]) throw notFound("立项申请");
    return one.items[0];
  }

  async submit(b: {
    drug: string; sponsorName: string; phase: string; indication: string;
    plannedSites: number; plannedSubjects: number; enrollMonths: number;
    contractCents: number; estimatedCostCents: number; note?: string;
  }) {
    const c = ctx();
    const p = principal();
    const code = `NP-${Date.now().toString(36).toUpperCase()}`;
    const ins = await c.client.query<{ id: string }>(
      `INSERT INTO intake_application
         (code, drug, sponsor_name, phase, indication, planned_sites, planned_subjects,
          enroll_months, contract_cents, estimated_cost_cents, note, submitted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [code, b.drug, b.sponsorName, b.phase, b.indication, b.plannedSites,
       b.plannedSubjects, b.enrollMonths, b.contractCents, b.estimatedCostCents,
       b.note ?? null, p.accountId]);

    const m = intakeMath({
      contractCents: b.contractCents, estimatedCostCents: b.estimatedCostCents,
      plannedSubjects: b.plannedSubjects, plannedSites: b.plannedSites
    });
    await this.audit.write({
      action: "提交立项申请", targetType: "intake_application", targetId: code,
      after: { drug: b.drug, sponsor: b.sponsorName, belowGate: m.belowGate },
      reason: b.note?.slice(0, 200) });

    return {
      data: await this.reload(ins.rows[0]!.id),
      sideEffects: [{
        type: "IntakeSubmitted",
        summary: m.belowGate
          ? `${code} 已提交 —— **测算毛利率低于 ${Math.round(INTAKE_GM_GATE * 100)}% 门槛**，` +
            "必须过经营层那一关"
          : `${code} 已提交，等待经营层审批`,
        ref: ins.rows[0]!.id
      }]
    };
  }

  async decide(id: string, b: { result: "approved" | "returned"; reason?: string }) {
    const c = ctx();
    const p = principal();
    const { rows } = await c.client.query<{
      id: string; code: string; state: string; drug: string; sponsor_name: string;
      phase: string; indication: string; planned_sites: number;
      planned_subjects: number; contract_cents: string; submitted_by: string;
      submitted_by_name: string;
    }>(`SELECT i.id, i.code, i.state, i.drug, i.sponsor_name, i.phase, i.indication,
               i.planned_sites, i.planned_subjects, i.contract_cents, i.submitted_by,
               sb.display_name AS submitted_by_name
          FROM intake_application i JOIN account sb ON sb.id = i.submitted_by
         WHERE i.id = $1`, [id]);
    if (!rows[0]) throw notFound("立项申请");
    const a = rows[0];

    if (a.state !== "submitted")
      this.invariant("intake-already-decided",
        `${a.code} 已经${a.state === "approved" ? "批准" : "退回"}过了`);
    /* **提交人不能批准自己的申请** —— 与工时审批同一条规矩。
       一个能自己批自己的门槛，只是多点一次鼠标。 */
    if (a.submitted_by === p.accountId)
      this.invariant("intake-self-approval",
        `${a.code} 是你自己提交的 —— 立项审批不能自己批自己`);

    if (b.result === "returned") {
      if (!b.reason || b.reason.trim().length < 4)
        this.invariant("intake-return-needs-reason",
          "退回必须写理由 —— 不说为什么，提交人只能猜，而猜错的代价是" +
          "拿着同一份价格再谈一轮");
      await c.client.query(
        `UPDATE intake_application
            SET state = 'returned', decided_by = $2, decided_on = CURRENT_DATE,
                decision_note = $3 WHERE id = $1`, [id, p.accountId, b.reason]);
      await this.audit.write({
        action: "退回立项申请", targetType: "intake_application", targetId: a.code,
        before: { state: "submitted" }, after: { state: "returned" },
        reason: b.reason });
      return {
        data: await this.reload(id),
        sideEffects: [{
          type: "IntakeReturned",
          summary: `${a.code} 已退回 ${a.submitted_by_name} —— ${b.reason.trim()}`,
          ref: id
        }]
      };
    }

    /* ── 批准：同一个事务里建客户与项目档案 ─────────────────────
       约束上「已批准」与「有项目档案」互为充要条件，所以这里不可能
       只走一半 —— 而「批准了但档案没建」是这条流程最容易漏的一格。 */
    const cl = await c.client.query<{ id: string }>(
      `INSERT INTO client (name) VALUES ($1)
       ON CONFLICT (tenant_id, name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`, [a.sponsor_name]);

    const year = new Date().getFullYear();
    const seq = await c.client.query<{ n: string }>(
      `SELECT count(*) + 1 AS n FROM study WHERE code LIKE $1`, [`HJ-${year}-%`]);
    const studyCode = `HJ-${year}-${String(seq.rows[0]!.n).padStart(3, "0")}`;

    const st = await c.client.query<{ id: string }>(
      `INSERT INTO study (code, short_name, client_id, phase, indication,
         planned_subjects, planned_sites, contract_amount_cents, started_on)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_DATE) RETURNING id`,
      [studyCode, a.drug.slice(0, 40), cl.rows[0]!.id, a.phase, a.indication,
       a.planned_subjects, a.planned_sites, a.contract_cents]);

    await c.client.query(
      `UPDATE intake_application
          SET state = 'approved', decided_by = $2, decided_on = CURRENT_DATE,
              decision_note = $3, study_id = $4 WHERE id = $1`,
      [id, p.accountId, b.reason ?? null, st.rows[0]!.id]);

    await this.audit.write({
      action: "批准立项", targetType: "intake_application", targetId: a.code,
      before: { state: "submitted" },
      after: { state: "approved", studyCode },
      reason: b.reason ?? `批准 ${a.drug}` });

    return {
      data: await this.reload(id),
      sideEffects: [{
        type: "IntakeApproved",
        summary: `${a.drug} 已批准立项，方案编号 ${studyCode} —— ` +
          `合同写了 ${a.planned_sites} 个中心，现在一个都还没建档`,
        ref: id
      }]
    };
  }
}
