import { Injectable } from "@nestjs/common";
import {
  queryLoad, siteQueryDensity, densityVerdict, CALC_VERSION,
  QUERY_STALE_DAYS, type QueryRecord, type QueryState
} from "@sitedesk/calc";
import { ctx, principal } from "../../infra/ctx.js";
import { ProblemException, notFound } from "../../infra/problem.js";
import { AuditService } from "../../infra/audit.service.js";

/* ════════════════════════════════════════════════════════════════════
   数据质疑（EDC Query）。

   ── 它为什么不是一张新表 ──────────────────────────────────────────
   质疑是 `kind = 'query'` 的质量事件。再建一张 data_query，
   「本中心还有几条未关闭的质量事件」这个数就有了两个答案 ——
   而核查时被问到的恰恰是这个数。

   ── 关闭走的是另一条路，不是 closeQualityEvent ────────────────────
   质量事件的关闭门是 `closeQA`，并且带一条硬规矩：**机构提出的，
   关闭权在机构**。数据质疑的关闭门是 `closeQ`，规矩不一样：
   **谁提的都行，但只有 DM 能关** —— 中心回复了不等于问题解决了。

   两条线共用一张表，但不共用一个动作。混成一个端点的话，
   要么 QA 能关数据质疑，要么 DM 能替机构关它自己提的事件，
   而这两件事都会让「已关闭」在核查时一文不值。

   ── 服务层照旧不出现算术 ──────────────────────────────────────────
   平均挂起、每例质疑数、集中度都在 @sitedesk/calc 里。
   ════════════════════════════════════════════════════════════════════ */

const day = (v: Date | null) => v ? v.toISOString().slice(0, 10) : null;
const iso = (v: Date | null) => v ? v.toISOString() : null;
const todayStr = () => day(new Date())!;
const between = (a: string, b: string) =>
  Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/** 提出方没有账号时（系统生成的）显示什么。 */
const RAISED_BY_LABEL: Record<string, string> = {
  system: "系统", cra: "监查员", qa: "质量保证", institution: "机构质控", dm: "数据管理"
};

interface QRow {
  id: string; code: string; study_site_id: string; site_code: string; hospital: string;
  study_short: string; subject_id: string | null; screening_no: string | null;
  form: string; field_name: string; detail: string; severity: string; state: string;
  raised_by: string; raised_by_name: string | null; raised_on: Date;
  owner_account_id: string | null; owner_name: string | null;
  answer: string | null; answered_on: Date | null; returned_reason: string | null;
  chase_count: number; last_chased_on: Date | null;
  closed_at: Date | null; resolution: string | null;
}

const Q_COLS = `
  q.id, q.code, q.study_site_id, s.code AS site_code, s.hospital,
  st.short_name AS study_short, q.subject_id, su.screening_no,
  q.form, q.field_name, q.detail, q.severity, q.state,
  q.raised_by, ra.display_name AS raised_by_name, q.raised_on,
  q.owner_account_id, ow.display_name AS owner_name,
  q.answer, q.answered_on, q.returned_reason,
  q.chase_count, q.last_chased_on, q.closed_at, q.resolution`;
/* 两个 account 的 LEFT JOIN 是安全的：`account_scope`（迁移 0005）只对
   **外部方**收窄到"只看得见自己"，而数据质疑对外部方整体关闭（0032）——
   所以能看到质疑的一定是内部身份，姓名一定解析得出来。
   哪天这条前提变了，界面上会先出现「无人认领」这种假象，
   而它和"真的没有责任人"长得一模一样 —— 所以把前提写在这里。 */
const Q_FROM = `
  FROM quality_event q
  JOIN study_site s ON s.id = q.study_site_id
  JOIN study st ON st.id = s.study_id
  LEFT JOIN subject su ON su.id = q.subject_id
  LEFT JOIN account ra ON ra.id = q.raised_by_account
  LEFT JOIN account ow ON ow.id = q.owner_account_id`;

@Injectable()
export class DataQueryService {
  constructor(private readonly audit: AuditService) {}

  private invariant(name: string, detail: string): never {
    throw new ProblemException("invariant-violated", { detail, invariant: name });
  }

  private dto(r: QRow, today: string) {
    const ageDays = between(day(r.raised_on)!, r.closed_at ? day(r.closed_at)! : today);
    return {
      id: r.id, code: r.code,
      studySiteId: r.study_site_id, siteCode: r.site_code, hospital: r.hospital,
      studyShortName: r.study_short,
      subjectId: r.subject_id,
      /* 受列权限管辖的字段一律非 nullable：没有值和没有权限共用「字段不存在」
         这一个表达式，多一个 null 就多一种含义。 */
      ...(r.screening_no !== null ? { screeningNo: r.screening_no } : {}),
      form: r.form, fieldName: r.field_name, detail: r.detail,
      severity: r.severity, state: r.state,
      raisedBy: r.raised_by,
      raisedByName: r.raised_by_name ?? RAISED_BY_LABEL[r.raised_by] ?? null,
      raisedOn: day(r.raised_on)!,
      ownerAccountId: r.owner_account_id, ownerName: r.owner_name,
      answer: r.answer, answeredOn: day(r.answered_on),
      returnedReason: r.returned_reason,
      chaseCount: r.chase_count, lastChasedOn: day(r.last_chased_on),
      closedAt: iso(r.closed_at), resolution: r.resolution,
      ageDays,
      stale: r.state === "open" && ageDays > QUERY_STALE_DAYS
    };
  }

  async list(q: {
    limit: number; cursor?: string; studySiteId?: string; subjectId?: string;
    state?: string[]; mine?: boolean; raisedByMe?: boolean; staleOnly?: boolean;
    /** 内部用：取回刚写的那一条。排序按挂起天数，写回的那条不一定在第一页。 */
    id?: string;
  }) {
    const c = ctx();
    const p = principal();
    const params: unknown[] = [];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const conds = [`q.kind = 'query'`];
    if (q.id) conds.push(`q.id = ${add(q.id)}`);
    if (q.studySiteId) conds.push(`q.study_site_id = ${add(q.studySiteId)}`);
    if (q.subjectId) conds.push(`q.subject_id = ${add(q.subjectId)}`);
    if (q.state?.length) conds.push(`q.state = ANY(${add(q.state)})`);
    if (q.mine) conds.push(`q.owner_account_id = ${add(p.accountId)}`);
    if (q.raisedByMe) conds.push(`q.raised_by_account = ${add(p.accountId)}`);
    /* 超期只对「待中心回复」成立。已回复待关闭挂了 20 天是 DM 自己的欠账，
       混进这一栏，打电话就打错了人。 */
    if (q.staleOnly)
      conds.push(`q.state = 'open'
                  AND CURRENT_DATE - q.raised_on > ${add(QUERY_STALE_DAYS)}`);
    /* 游标：排序是「挂得最久的在前」，等价于 raised_on 升序。
       同日的按 id 定序，否则翻页会漏行或重复。 */
    if (q.cursor) {
      const [on, id] = q.cursor.split("|");
      conds.push(`(q.raised_on, q.id) > (${add(on)}::date, ${add(id)}::uuid)`);
    }

    const { rows } = await c.client.query<QRow>(
      `SELECT ${Q_COLS} ${Q_FROM}
        WHERE ${conds.join(" AND ")}
        ORDER BY q.raised_on, q.id LIMIT ${add(q.limit + 1)}`, params);

    const today = todayStr();
    const page = rows.slice(0, q.limit);
    const items = page.map(r => this.dto(r, today));
    const last = page.at(-1);
    return {
      items,
      nextCursor: rows.length > q.limit && last
        ? `${day(last.raised_on)}|${last.id}` : null
    };
  }

  /** 负荷与中心分布。**统计不分页** —— 分页统计出来的平均数
   *  是「第一页的平均」，而看的人以为是全部的平均。 */
  async stats(q: { studySiteId?: string; mine?: boolean }) {
    const c = ctx();
    const p = principal();
    const params: unknown[] = [];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const conds = [`q.kind = 'query'`];
    if (q.studySiteId) conds.push(`q.study_site_id = ${add(q.studySiteId)}`);
    if (q.mine) conds.push(`q.owner_account_id = ${add(p.accountId)}`);

    const { rows } = await c.client.query<{
      study_site_id: string; site_code: string; hospital: string;
      form: string; state: string; raised_on: Date; closed_at: Date | null;
    }>(`SELECT q.study_site_id, s.code AS site_code, s.hospital,
               q.form, q.state, q.raised_on, q.closed_at
          FROM quality_event q
          JOIN study_site s ON s.id = q.study_site_id
         WHERE ${conds.join(" AND ")}`, params);

    /* 入组例数从 subject 数，且**只数看得见的中心** ——
       RLS 会把行滤掉，但如果这里 LEFT JOIN 回 study_site 再 count，
       算出来的密度分母会包含看不见的中心的入组数。 */
    const enrolled = await c.client.query<{
      id: string; code: string; hospital: string; n: string;
    }>(`SELECT s.id, s.code, s.hospital,
               count(su.id) FILTER (WHERE su.state IN ('enrolled','completed')) AS n
          FROM study_site s
          LEFT JOIN subject su ON su.study_site_id = s.id
         GROUP BY s.id, s.code, s.hospital`);

    const today = todayStr();
    const age = (raisedOn: Date, closedAt: Date | null) =>
      between(day(raisedOn)!, closedAt ? day(closedAt)! : today);

    const all: QueryRecord[] = rows.map(r => ({
      ageDays: age(r.raised_on, r.closed_at), state: r.state as QueryState
    }));

    const bySite = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = bySite.get(r.study_site_id);
      if (list) list.push(r); else bySite.set(r.study_site_id, [r]);
    }

    const sites = [...bySite.entries()].map(([id, rs]) => {
      const meta = enrolled.rows.find(e => e.id === id);
      const d = siteQueryDensity({
        studySiteId: id,
        enrolled: Number(meta?.n ?? 0),
        queries: rs.map(r => ({
          ageDays: age(r.raised_on, r.closed_at),
          state: r.state as QueryState, form: r.form
        }))
      });
      return {
        ...d,
        siteCode: rs[0]!.site_code, hospital: rs[0]!.hospital,
        verdict: densityVerdict(d)
      };
    }).sort((a, b) =>
      /* 密度降序，**算不出密度的排在最后而不是最前** ——
         null 当成 0 排在最干净的一端，那正是最该去看一眼的中心；
         当成无穷大排在最前，又会把「还没开始录」当成最严重的问题。
         摆在最后并且写明"未入组"，是唯一不误导的位置。 */
      (b.perSubject ?? -1) - (a.perSubject ?? -1)
      || b.total - a.total || a.siteCode.localeCompare(b.siteCode));

    return { load: queryLoad(all), sites, calcVersion: CALC_VERSION };
  }

  private async one(id: string) {
    const c = ctx();
    const { rows } = await c.client.query<QRow>(
      `SELECT ${Q_COLS} ${Q_FROM} WHERE q.id = $1 AND q.kind = 'query'`, [id]);
    if (!rows[0]) throw notFound("数据质疑");
    return rows[0];
  }

  private async reload(id: string) {
    const one = await this.list({ limit: 1, id });
    return one.items[0]!;
  }

  async raise(b: {
    subjectId: string; form: string; fieldName: string; detail: string;
    ownerAccountId?: string; severity?: string;
  }) {
    const c = ctx();
    const p = principal();

    const su = await c.client.query<{
      id: string; study_site_id: string; screening_no: string;
      crc_account_id: string | null; state: string;
    }>(`SELECT id, study_site_id, screening_no, crc_account_id, state
          FROM subject WHERE id = $1`, [b.subjectId]);
    if (!su.rows[0]) throw notFound("受试者");
    const s = su.rows[0];

    /* 筛败的受试者不再录数据，对他提质疑是提给一个已经关掉的档案。 */
    if (s.state === "screen_failed")
      this.invariant("query-on-screen-failed",
        `${s.screening_no} 已筛败 —— 不再录入数据，质疑无从核实`);

    /* 责任 CRC 在这一刻固化。取不到就拒绝创建：
       **无人认领的质疑等于没提** —— 它会一直挂着，而没有人会收到它。 */
    const owner = b.ownerAccountId ?? s.crc_account_id;
    if (!owner)
      this.invariant("query-needs-owner",
        `${s.screening_no} 还没有责任 CRC —— 请先指派，否则这条质疑没有人认领`);

    /* 提出方按角色落库。dm 是这一版新加的取值：此前 by:"数据管理"
       在原型里出现了 5 次，而系统里没有这个来源，于是它只能记成 cra。 */
    const raisedBy = p.roleCode === "dm" ? "dm"
      : p.roleCode === "qa" ? "qa" : "cra";

    const code = `Q-${Date.now().toString(36).toUpperCase()}`;
    const ins = await c.client.query<{ id: string }>(
      `INSERT INTO quality_event
         (code, study_site_id, subject_id, kind, severity, state, title, detail,
          form, field_name, owner_account_id, raised_by, raised_by_account, raised_on)
       VALUES ($1,$2,$3,'query',$4,'open',$5,$6,$7,$8,$9,$10,$11,CURRENT_DATE)
       RETURNING id`,
      [code, s.study_site_id, s.id, b.severity ?? "minor",
       `${b.form} · ${b.fieldName}`, b.detail,
       b.form, b.fieldName, owner, raisedBy, p.accountId]);

    await this.audit.write({
      action: "发起数据质疑", targetType: "quality_event", targetId: code,
      after: { form: b.form, field: b.fieldName, owner, state: "open" },
      reason: b.detail.slice(0, 200), studySiteId: s.study_site_id });

    const data = await this.reload(ins.rows[0]!.id);
    return {
      data,
      sideEffects: [{
        type: "DataQueryRaised",
        summary: `${code} 已发起，指派给 ${data.ownerName ?? "责任 CRC"}` +
          `（${b.form} · ${b.fieldName}）`,
        ref: ins.rows[0]!.id, studySiteId: s.study_site_id
      }]
    };
  }

  async answer(id: string, b: { answer: string }) {
    const c = ctx();
    const q = await this.one(id);
    if (q.state === "closed")
      this.invariant("query-already-closed", `${q.code} 已经关闭`);
    if (q.state === "pending_review")
      this.invariant("query-already-answered",
        `${q.code} 已经回复过，正等数据管理判定 —— 要补充请等退回后再答`);

    await c.client.query(
      `UPDATE quality_event
          SET state = 'pending_review', answer = $2, answered_on = CURRENT_DATE
        WHERE id = $1`, [id, b.answer]);
    await this.audit.write({
      action: "回复数据质疑", targetType: "quality_event", targetId: q.code,
      before: { state: q.state, answer: q.answer },
      after: { state: "pending_review", answer: b.answer },
      reason: b.answer.slice(0, 200), studySiteId: q.study_site_id });

    const ageDays = between(day(q.raised_on)!, todayStr());
    return {
      data: await this.reload(id),
      sideEffects: [{
        type: "DataQueryAnswered",
        summary: `${q.code} 已回复，挂起 ${ageDays} 天 —— ` +
          "等数据管理判定；**回复了不等于关闭了**",
        ref: id, studySiteId: q.study_site_id
      }]
    };
  }

  async close(id: string, b: { reason: string }) {
    const c = ctx();
    const p = principal();
    const q = await this.one(id);
    if (q.state === "closed")
      this.invariant("query-already-closed", `${q.code} 已经关闭`);
    /* 没有回复而直接关闭，「已关闭」这三个字只是把问题从列表上抹掉。 */
    if (q.state !== "pending_review")
      this.invariant("query-close-needs-answer",
        `${q.code} 中心还没有回复 —— 关掉它等于把问题从列表上抹掉，而不是解决`);

    await c.client.query(
      `UPDATE quality_event
          SET state = 'closed', closed_at = now(), closed_by = $2, resolution = $3
        WHERE id = $1`, [id, p.accountId, b.reason]);
    await this.audit.write({
      action: "关闭数据质疑", targetType: "quality_event", targetId: q.code,
      before: { state: q.state }, after: { state: "closed" },
      reason: b.reason, studySiteId: q.study_site_id });

    const ageDays = between(day(q.raised_on)!, todayStr());
    return {
      data: await this.reload(id),
      sideEffects: [{
        type: "DataQueryClosed",
        summary: `${q.code} 已关闭，共挂起 ${ageDays} 天`,
        ref: id, studySiteId: q.study_site_id
      }]
    };
  }

  async returnToSite(id: string, b: { reason: string }) {
    const c = ctx();
    const q = await this.one(id);
    if (q.state !== "pending_review")
      this.invariant("query-return-needs-answer",
        `${q.code} 不在「已回复待关闭」，没有可退回的回复`);

    /* 回复内容保留 —— 退回不是"当他没答过"，CRC 要能看到自己上次写了什么
       和为什么不够。历次回复留在审计轨迹里。 */
    await c.client.query(
      `UPDATE quality_event SET state = 'open', returned_reason = $2 WHERE id = $1`,
      [id, b.reason]);
    await this.audit.write({
      action: "退回数据质疑", targetType: "quality_event", targetId: q.code,
      before: { state: "pending_review" }, after: { state: "open" },
      reason: b.reason, studySiteId: q.study_site_id });

    return {
      data: await this.reload(id),
      sideEffects: [{
        type: "DataQueryReturned",
        summary: `${q.code} 已退回 ${q.owner_name ?? "责任 CRC"} —— ${b.reason}`,
        ref: id, studySiteId: q.study_site_id
      }]
    };
  }

  async chase(id: string, b: { reason: string }) {
    const c = ctx();
    const q = await this.one(id);
    if (q.state !== "open")
      this.invariant("query-chase-open-only",
        `${q.code} 不在「待中心回复」 —— 现在球不在中心那边`);

    const { rows } = await c.client.query<{ chase_count: number }>(
      `UPDATE quality_event
          SET chase_count = chase_count + 1, last_chased_on = CURRENT_DATE
        WHERE id = $1 RETURNING chase_count`, [id]);
    await this.audit.write({
      action: "催办数据质疑", targetType: "quality_event", targetId: q.code,
      before: { chaseCount: q.chase_count },
      after: { chaseCount: rows[0]!.chase_count },
      reason: b.reason, studySiteId: q.study_site_id });

    const n = rows[0]!.chase_count;
    return {
      data: await this.reload(id),
      sideEffects: [{
        type: "DataQueryChased",
        summary: `已记录对 ${q.hospital} 的第 ${n} 次催办：${q.code}` +
          (n >= 3 ? " —— 催到第三次还没回，该升级到 PM 而不是再打一个电话" : ""),
        ref: id, studySiteId: q.study_site_id
      }]
    };
  }
}
