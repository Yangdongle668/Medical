import { Injectable } from "@nestjs/common";
import {
  gradeSite, capaEffectiveness, CALC_VERSION, QUERY_STALE_DAYS,
  type CapaEvent, type CapaRepeat
} from "@sitedesk/calc";
import { ctx, principal } from "../../infra/ctx.js";
import { ProblemException, notFound } from "../../infra/problem.js";
import { AuditService as AuditLog } from "../../infra/audit.service.js";

/* ════════════════════════════════════════════════════════════════════
   内部稽查 —— 我方的第二道防线。

   机构质控是医院查我们，稽查是我们自己查自己。
   **QA 的价值不在于再发现一批问题，在于 CAPA 有效性验证：
   同类问题是否复发。**

   复发 = 当初只做了纠正，没做预防。
   「集中补签并留痕」是纠正 —— 补完签名下个月照样缺。

   ── 两个命名撞在一起，这里说明一次 ────────────────────────────────
   `audit_entry` 是**操作留痕**（谁在什么时候改了什么），
   `internal_audit` 是**质量稽查**（我方查自己）。
   中文都叫"审计/稽查"，但它们毫无关系。
   本文件里 `AuditLog` 是前者，`InternalAuditService` 是后者。
   ════════════════════════════════════════════════════════════════════ */

const day = (v: Date | null) => v ? v.toISOString().slice(0, 10) : null;
const iso = (v: Date | null) => v ? v.toISOString() : null;
const todayStr = () => day(new Date())!;

/** category 为空时按 kind 归类。**不能直接丢掉** ——
 *  丢掉的那几条会让「这一类一共几条」变小，而分母变小会让复发率虚高。 */
const KIND_LABEL: Record<string, string> = {
  deviation: "方案偏离", query: "数据质疑", ip_discrepancy: "药品不平衡",
  sae: "严重不良事件", sae_late: "SAE 上报超窗", other: "其他"
};

interface ARow {
  id: string; code: string; study_site_id: string; site_code: string; hospital: string;
  kind: string; audited_on: Date; auditor_account_id: string; auditor_name: string;
  scope: string; state: string; closed_at: Date | null;
  findings: {
    seq: number; severity: string; finding: string;
    repeat_of: string | null; repeat_code: string | null; repeat_closed: boolean | null;
    state: string; verification: string | null; closed_at: string | null;
  }[];
}

const A_COLS = `
  a.id, a.code, a.study_site_id, s.code AS site_code, s.hospital,
  a.kind, a.audited_on, a.auditor_account_id, ac.display_name AS auditor_name,
  a.scope, a.state, a.closed_at,
  COALESCE((
    SELECT json_agg(json_build_object(
             'seq', f.seq, 'severity', f.severity, 'finding', f.finding,
             'repeat_of', f.repeat_of, 'repeat_code', q.code,
             'repeat_closed', CASE WHEN f.repeat_of IS NULL THEN NULL
                                   ELSE q.state = 'closed' END,
             'state', f.state, 'verification', f.verification,
             'closed_at', f.closed_at) ORDER BY f.seq)
      FROM audit_finding f
      LEFT JOIN quality_event q ON q.id = f.repeat_of
     WHERE f.audit_id = a.id), '[]'::json) AS findings`;
const A_FROM = `
  FROM internal_audit a
  JOIN study_site s ON s.id = a.study_site_id
  JOIN account ac ON ac.id = a.auditor_account_id`;

@Injectable()
export class InternalAuditService {
  constructor(private readonly log: AuditLog) {}

  private invariant(name: string, detail: string): never {
    throw new ProblemException("invariant-violated", { detail, invariant: name });
  }

  private dto(r: ARow) {
    const findings = r.findings.map(f => ({
      seq: f.seq, severity: f.severity, finding: f.finding,
      repeatOf: f.repeat_of, repeatOfCode: f.repeat_code,
      repeatAfterClose: f.repeat_closed,
      state: f.state, verification: f.verification,
      closedAt: f.closed_at ? new Date(f.closed_at).toISOString() : null
    }));
    return {
      id: r.id, code: r.code,
      studySiteId: r.study_site_id, siteCode: r.site_code, hospital: r.hospital,
      kind: r.kind, auditedOn: day(r.audited_on)!,
      auditorAccountId: r.auditor_account_id, auditorName: r.auditor_name,
      scope: r.scope, state: r.state, closedAt: iso(r.closed_at),
      findings,
      openFindings: findings.filter(f => f.state === "open").length,
      repeatFindings: findings.filter(f => f.repeatOf !== null).length
    };
  }

  async list(q: {
    limit: number; cursor?: string; studySiteId?: string;
    kind?: string[]; openOnly?: boolean; id?: string;
  }) {
    const c = ctx();
    const params: unknown[] = [];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const conds = ["true"];
    if (q.id) conds.push(`a.id = ${add(q.id)}`);
    if (q.studySiteId) conds.push(`a.study_site_id = ${add(q.studySiteId)}`);
    if (q.kind?.length) conds.push(`a.kind = ANY(${add(q.kind)})`);
    if (q.openOnly) conds.push(`a.state <> 'closed'`);
    if (q.cursor) {
      const [on, id] = q.cursor.split("|");
      conds.push(`(a.audited_on, a.id) < (${add(on)}::date, ${add(id)}::uuid)`);
    }

    const { rows } = await c.client.query<ARow>(
      `SELECT ${A_COLS} ${A_FROM}
        WHERE ${conds.join(" AND ")}
        ORDER BY a.audited_on DESC, a.id DESC LIMIT ${add(q.limit + 1)}`, params);

    const pageRows = rows.slice(0, q.limit);
    const last = pageRows.at(-1);
    return {
      items: pageRows.map(r => this.dto(r)),
      nextCursor: rows.length > q.limit && last
        ? `${day(last.audited_on)}|${last.id}` : null
    };
  }

  /** CAPA 有效性与中心质量评级。**统计不分页。** */
  async board(q: { studySiteId?: string }) {
    const c = ctx();
    const params: unknown[] = [];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const evCond = q.studySiteId ? `AND e.study_site_id = ${add(q.studySiteId)}` : "";

    /* ── CAPA 有效性 ────────────────────────────────────────────
       质疑不进这张表 —— 它走自己的闭环（回复 → 判定），不挂 CAPA。 */
    const events = await c.client.query<{
      category: string | null; kind: string; state: string;
      capa_plan: string | null; capa_owner_account_id: string | null;
    }>(`SELECT e.category, e.kind, e.state, e.capa_plan, e.capa_owner_account_id
          FROM quality_event e
         WHERE e.kind <> 'query' ${evCond}`, params);

    /* 复发算在**源问题**那一类上，不是稽查发现那一类。 */
    const repeats = await c.client.query<{
      category: string | null; kind: string; source_closed: boolean;
    }>(`SELECT q.category, q.kind, q.state = 'closed' AS source_closed
          FROM audit_finding f
          JOIN internal_audit a ON a.id = f.audit_id
          JOIN quality_event q ON q.id = f.repeat_of
         WHERE f.repeat_of IS NOT NULL
           ${q.studySiteId ? `AND a.study_site_id = $1` : ""}`,
      q.studySiteId ? [q.studySiteId] : []);

    const cat = (c2: string | null, kind: string) =>
      c2 ?? KIND_LABEL[kind] ?? kind;
    const capaEvents: CapaEvent[] = events.rows.map(e => ({
      category: cat(e.category, e.kind),
      closed: e.state === "closed",
      owesPlan: e.capa_owner_account_id !== null && e.capa_plan === null
    }));
    const capaRepeats: CapaRepeat[] = repeats.rows.map(r => ({
      category: cat(r.category, r.kind), sourceClosed: r.source_closed
    }));

    /* ── 中心质量评级 ──────────────────────────────────────────
       **每个中心都评，不只是入组中的那些。** 原型只给 enrolled > 0 的中心评级 ——
       于是一个还没入组、却已经有三条未关闭发现的中心是隐形的，
       而那正是最该在启动前处理掉的。 */
    /* **这条查询自带一份参数。** 上面那两条各自编了号，
       在这里接着用会得到一条只引用 $2、不引用 $1 的 SQL ——
       Postgres 报的是「无法确定 $1 的类型」，而它指不到这一行。
       （不带 studySiteId 时恰好只有一个参数，所以这个坑在默认路径上不响。） */
    const sp: unknown[] = [QUERY_STALE_DAYS];
    const spAdd = (v: unknown) => { sp.push(v); return `$${sp.length}`; };
    const siteCond = q.studySiteId ? `AND s.id = ${spAdd(q.studySiteId)}` : "";

    const sites = await c.client.query<{
      id: string; code: string; hospital: string;
      severe_open: string; minor_open: string; sae_late: string;
      stale_queries: string; capa_repeats: string;
    }>(`
      SELECT s.id, s.code, s.hospital,
             count(e.id) FILTER (
               WHERE e.state <> 'closed' AND e.kind NOT IN ('query','sae_late')
                 AND e.severity IN ('major','critical')) AS severe_open,
             count(e.id) FILTER (
               WHERE e.state <> 'closed' AND e.kind NOT IN ('query','sae_late')
                 AND e.severity = 'minor') AS minor_open,
             count(e.id) FILTER (
               WHERE e.state <> 'closed' AND e.kind = 'sae_late') AS sae_late,
             count(e.id) FILTER (
               WHERE e.kind = 'query' AND e.state = 'open'
                 AND CURRENT_DATE - e.raised_on > $1) AS stale_queries,
             (SELECT count(*) FROM audit_finding f
                JOIN internal_audit a ON a.id = f.audit_id
               WHERE a.study_site_id = s.id AND f.repeat_of IS NOT NULL) AS capa_repeats
        FROM study_site s
        LEFT JOIN quality_event e ON e.study_site_id = s.id
       WHERE NOT app.current_is_external() ${siteCond}
       GROUP BY s.id, s.code, s.hospital`, sp);

    const graded = sites.rows.map(r => {
      const input = {
        severeOpen: Number(r.severe_open), minorOpen: Number(r.minor_open),
        saeLate: Number(r.sae_late), staleQueries: Number(r.stale_queries),
        capaRepeats: Number(r.capa_repeats)
      };
      return {
        studySiteId: r.id, siteCode: r.code, hospital: r.hospital,
        ...gradeSite(input), ...input
      };
    }).sort((a, b) => b.penalty - a.penalty || a.siteCode.localeCompare(b.siteCode));

    /* 顶上那三个数也要跟着筛 —— 按中心筛之后，
       CAPA 表和评级都收窄了而计数没收窄的话，
       页头会说「3 项稽查进行中」而下面一条都看不见。 */
    const au = await c.client.query<{ open_audits: string; open_findings: string; repeats: string }>(
      `SELECT count(DISTINCT a.id) FILTER (WHERE a.state <> 'closed') AS open_audits,
              count(f.seq) FILTER (WHERE f.state = 'open') AS open_findings,
              count(f.seq) FILTER (WHERE f.repeat_of IS NOT NULL) AS repeats
         FROM internal_audit a
         LEFT JOIN audit_finding f ON f.audit_id = a.id
        WHERE true ${q.studySiteId ? "AND a.study_site_id = $1" : ""}`,
      q.studySiteId ? [q.studySiteId] : []);

    return {
      openAudits: Number(au.rows[0]!.open_audits),
      openFindings: Number(au.rows[0]!.open_findings),
      repeatFindings: Number(au.rows[0]!.repeats),
      owesCapaPlan: capaEvents.filter(e => e.owesPlan).length,
      capa: capaEffectiveness(capaEvents, capaRepeats),
      sites: graded,
      calcVersion: CALC_VERSION
    };
  }

  private async one(id: string) {
    const c = ctx();
    const { rows } = await c.client.query<ARow>(
      `SELECT ${A_COLS} ${A_FROM} WHERE a.id = $1`, [id]);
    if (!rows[0]) throw notFound("内部稽查");
    return rows[0];
  }

  private async reload(id: string) {
    const one = await this.list({ limit: 1, id });
    return one.items[0]!;
  }

  async open(b: { studySiteId: string; kind: string; auditedOn?: string; scope: string }) {
    const c = ctx();
    const p = principal();
    const site = await c.client.query<{ id: string; code: string }>(
      `SELECT id, code FROM study_site WHERE id = $1`, [b.studySiteId]);
    if (!site.rows[0]) throw notFound("中心");

    const on = b.auditedOn ?? todayStr();
    if (Date.parse(on) > Date.parse(todayStr()))
      this.invariant("audit-future-date", "稽查日期不能在将来 —— 还没发生的事不能登记");

    const code = `AU-${Date.now().toString(36).toUpperCase()}`;
    const ins = await c.client.query<{ id: string }>(
      `INSERT INTO internal_audit
         (code, study_site_id, kind, audited_on, auditor_account_id, scope, state)
       VALUES ($1,$2,$3,$4,$5,$6,'open') RETURNING id`,
      [code, b.studySiteId, b.kind, on, p.accountId, b.scope]);
    const id = ins.rows[0]!.id;
    await this.log.write({
      action: "发起内部稽查", targetType: "internal_audit", targetId: code,
      after: { kind: b.kind, scope: b.scope }, reason: b.scope.slice(0, 200),
      studySiteId: b.studySiteId });

    return {
      data: await this.reload(id),
      sideEffects: [{
        type: "InternalAuditOpened",
        summary: `${code} 已对 ${site.rows[0].code} 发起 —— 发现项逐条记，全部关闭时自动结案`,
        ref: id, studySiteId: b.studySiteId
      }]
    };
  }

  async addFinding(id: string, b: {
    severity: string; finding: string; repeatOf?: string;
  }) {
    const c = ctx();
    const a = await this.one(id);
    if (a.state === "closed")
      this.invariant("audit-closed", `${a.code} 已结案 —— 新发现要新开一次稽查`);

    if (b.repeatOf) {
      const src = await c.client.query<{ code: string; raised_on: Date; state: string }>(
        `SELECT code, raised_on, state FROM quality_event WHERE id = $1`, [b.repeatOf]);
      if (!src.rows[0]) throw notFound("质量事件");
      /* 源事件必须早于本次稽查。指向一条今天才提出的事件，那不是复发 ——
         而"复发"这个判定会把整条问题类型判成 CAPA 无效。 */
      if (Date.parse(day(src.rows[0].raised_on)!) >= Date.parse(day(a.audited_on)!))
        this.invariant("repeat-not-earlier",
          `${src.rows[0].code} 提出于 ${day(src.rows[0].raised_on)}，不早于本次稽查 ` +
          `${day(a.audited_on)} —— 那不是复发`);
    }

    const seq = a.findings.length;
    await c.client.query(
      `INSERT INTO audit_finding (audit_id, seq, severity, finding, repeat_of, state)
       VALUES ($1,$2,$3,$4,$5,'open')`,
      [id, seq, b.severity, b.finding, b.repeatOf ?? null]);
    /* 有了发现项，稽查就从"进行中"进入"待整改"。 */
    if (a.state === "open")
      await c.client.query(
        `UPDATE internal_audit SET state = 'remediating' WHERE id = $1`, [id]);

    await this.log.write({
      action: "记稽查发现", targetType: "internal_audit", targetId: a.code,
      after: { seq, severity: b.severity, repeatOf: b.repeatOf ?? null },
      reason: b.finding.slice(0, 200), studySiteId: a.study_site_id });

    return {
      data: await this.reload(id),
      sideEffects: [{
        type: "AuditFindingAdded",
        summary: b.repeatOf
          ? `${a.code} 记下一条**复发**发现 —— 同类问题的 CAPA 判定会因此变成「无效」`
          : `${a.code} 已记下第 ${seq + 1} 条发现`,
        ref: id, studySiteId: a.study_site_id
      }]
    };
  }

  async closeFinding(id: string, seq: number, b: { verification: string }) {
    const c = ctx();
    const p = principal();
    const a = await this.one(id);
    const f = a.findings.find(x => x.seq === seq);
    if (!f) throw notFound("稽查发现");
    if (f.state === "closed")
      this.invariant("finding-already-closed", `${a.code} 第 ${seq + 1} 条已经关闭`);

    await c.client.query(
      `UPDATE audit_finding
          SET state = 'closed', verification = $3, closed_at = now(), closed_by = $4
        WHERE audit_id = $1 AND seq = $2`, [id, seq, b.verification, p.accountId]);

    /* 全部发现项关闭时稽查自动结案。留一个手动的「关闭稽查」按钮，
       就会出现「发现项全关了但稽查还开着」这种只有系统自己知道的状态。 */
    const left = a.findings.filter(x => x.state === "open" && x.seq !== seq).length;
    if (left === 0)
      await c.client.query(
        `UPDATE internal_audit SET state = 'closed', closed_at = now(), closed_by = $2
          WHERE id = $1`, [id, p.accountId]);

    await this.log.write({
      action: "验证稽查发现并关闭", targetType: "internal_audit", targetId: a.code,
      before: { seq, state: "open" }, after: { seq, state: "closed" },
      reason: b.verification.slice(0, 200), studySiteId: a.study_site_id });

    return {
      data: await this.reload(id),
      sideEffects: [{
        type: "AuditFindingClosed",
        summary: left === 0
          ? `${a.code} 全部发现项已验证关闭，稽查自动结案`
          : `${a.code} 第 ${seq + 1} 条已验证关闭，还剩 ${left} 条`,
        ref: id, studySiteId: a.study_site_id
      }]
    };
  }
}
