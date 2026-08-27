import { Injectable } from "@nestjs/common";
import { ctx } from "../../infra/ctx.js";
import { ProblemException, notFound } from "../../infra/problem.js";
import { AuditService } from "../../infra/audit.service.js";

/* ════════════════════════════════════════════════════════════════════
   药品台账 · 生物样本 · 伦理递交

   这三样是为同一件事补的：关闭闸门里那四项从来没能真查过的检查
   （见 modules/site/gate.ts 与迁移 0017）。

   ── 一条贯穿三张表的规矩 ──────────────────────────────────────────
   **台账只追加。** 记错了用反向流水冲销，不改历史 ——
   核查看的就是这本台账，而一本能被改的台账不构成证据。
   药品流水由数据库触发器兜住（UPDATE/DELETE 直接拒），
   样本与递交的"推进"只允许把空的时点填上，不允许改已经填过的。
   ════════════════════════════════════════════════════════════════════ */

const day = (v: Date | null) => v ? v.toISOString().slice(0, 10) : null;
const todayStr = () => new Date().toISOString().slice(0, 10);

interface IpRow {
  id: string; study_site_id: string; moved_on: Date; kind: string;
  quantity: number; subject_ref: string | null; ref_no: string | null; note: string | null;
}
interface SpecimenRow {
  id: string; study_site_id: string; subject_ref: string; kind: string;
  collected_on: Date; shipped_on: Date | null; received_on: Date | null;
  discarded_on: Date | null; tracking_no: string | null;
}
interface SubmissionRow {
  id: string; study_site_id: string; kind: string; submitted_on: Date;
  decision: string; decided_on: Date | null; ref_no: string | null; note: string | null;
}

const toIp = (r: IpRow) => ({
  id: r.id, studySiteId: r.study_site_id, movedOn: day(r.moved_on)!,
  kind: r.kind, quantity: Number(r.quantity),
  subjectRef: r.subject_ref, refNo: r.ref_no, note: r.note
});
const toSpecimen = (r: SpecimenRow) => ({
  id: r.id, studySiteId: r.study_site_id, subjectRef: r.subject_ref, kind: r.kind,
  collectedOn: day(r.collected_on)!, shippedOn: day(r.shipped_on),
  receivedOn: day(r.received_on), discardedOn: day(r.discarded_on),
  trackingNo: r.tracking_no,
  /* 闭环 = 实验室确认收到，或已销毁登记。两个都没有 = 在路上不知去向。 */
  closed: !!(r.received_on || r.discarded_on)
});
const toSubmission = (r: SubmissionRow) => ({
  id: r.id, studySiteId: r.study_site_id, kind: r.kind,
  submittedOn: day(r.submitted_on)!, decision: r.decision,
  decidedOn: day(r.decided_on), refNo: r.ref_no, note: r.note
});

@Injectable()
export class AccountabilityService {
  constructor(private readonly audit: AuditService) {}

  /** 中心在不在范围内。**范围之外一律当作不存在** —— 404，不是 403。 */
  private async assertSite(id: string) {
    const c = ctx();
    const { rows } = await c.client.query("SELECT 1 FROM study_site WHERE id = $1", [id]);
    if (!rows.length) throw notFound("中心");
  }

  /* ── 药品 ─────────────────────────────────────────────────────── */
  async listIp(siteId: string, q: { limit: number; cursor?: string }) {
    await this.assertSite(siteId);
    const c = ctx();
    const params: unknown[] = [siteId];
    let cond = "";
    if (q.cursor) { params.push(q.cursor); cond = ` AND m.id < $${params.length}`; }
    params.push(q.limit + 1);
    const { rows } = await c.client.query<IpRow>(
      `SELECT m.* FROM ip_movement m WHERE m.study_site_id = $1${cond}
        ORDER BY m.moved_on DESC, m.id DESC LIMIT $${params.length}`, params);
    const { rows: bal } = await c.client.query<{ n: string }>(
      "SELECT app.ip_balance($1) AS n", [siteId]);
    const balance = Number(bal[0]?.n ?? 0);
    const items = rows.slice(0, q.limit).map(toIp);
    return {
      items,
      nextCursor: rows.length > q.limit ? items.at(-1)?.id ?? null : null,
      balance,
      /* 关闭闸门看的就是它：不为 0 就关不掉（负数是账不平，正数是还有药在手）。
         放在台账里，是为了让人在这一页直接看见"我为什么关不掉中心"。 */
      blocksClose: balance !== 0
    };
  }

  async recordIp(siteId: string, b: {
    movedOn?: string; kind: string; quantity: number;
    subjectRef?: string; refNo?: string; note?: string;
  }) {
    await this.assertSite(siteId);
    const c = ctx();
    /* 销毁与退回申办方必须有单号：没有单号的销毁登记，在核查那里等于没做过。 */
    if ((b.kind === "destroy" || b.kind === "ship_back") && !b.refNo?.trim())
      throw new ProblemException("invariant-violated", {
        detail: "销毁或退回申办方必须填单号 —— 没有单号的登记，核查时等于没发生过",
        invariant: "ip-movement-needs-ref"
      });
    const { rows } = await c.client.query<IpRow>(
      `INSERT INTO ip_movement (study_site_id, moved_on, kind, quantity,
                                subject_ref, ref_no, note, created_by)
       VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3, $4, $5, $6, $7,
               app.current_account_id())
       RETURNING *`,
      [siteId, b.movedOn ?? null, b.kind, b.quantity,
       b.subjectRef ?? null, b.refNo ?? null, b.note ?? null]);
    const row = rows[0]!;
    await this.audit.write({
      action: "create", targetType: "ip_movement", targetId: row.id,
      studySiteId: siteId, after: toIp(row)
    });
    return toIp(row);
  }

  /* ── 样本 ─────────────────────────────────────────────────────── */
  async listSpecimens(siteId: string, q: { limit: number; cursor?: string; openOnly?: boolean }) {
    await this.assertSite(siteId);
    const c = ctx();
    const params: unknown[] = [siteId];
    let cond = "";
    if (q.openOnly) cond += " AND s.received_on IS NULL AND s.discarded_on IS NULL";
    if (q.cursor) { params.push(q.cursor); cond += ` AND s.id < $${params.length}`; }
    params.push(q.limit + 1);
    const { rows } = await c.client.query<SpecimenRow>(
      `SELECT s.* FROM specimen s WHERE s.study_site_id = $1${cond}
        ORDER BY s.collected_on DESC, s.id DESC LIMIT $${params.length}`, params);
    const items = rows.slice(0, q.limit).map(toSpecimen);
    return { items, nextCursor: rows.length > q.limit ? items.at(-1)?.id ?? null : null };
  }

  async recordSpecimen(siteId: string, b: {
    subjectRef: string; kind: string; collectedOn: string; trackingNo?: string;
  }) {
    await this.assertSite(siteId);
    const c = ctx();
    const { rows } = await c.client.query<SpecimenRow>(
      `INSERT INTO specimen (study_site_id, subject_ref, kind, collected_on, tracking_no)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [siteId, b.subjectRef, b.kind, b.collectedOn, b.trackingNo ?? null]);
    const row = rows[0]!;
    await this.audit.write({
      action: "create", targetType: "specimen", targetId: row.id,
      studySiteId: siteId, after: toSpecimen(row)
    });
    return toSpecimen(row);
  }

  async advanceSpecimen(id: string, b: { stage: string; on: string }) {
    const c = ctx();
    const { rows: cur } = await c.client.query<SpecimenRow>(
      "SELECT * FROM specimen WHERE id = $1", [id]);
    const before = cur[0];
    if (!before) throw notFound("样本");

    const col = { shipped: "shipped_on", received: "received_on", discarded: "discarded_on" }[b.stage];
    if (!col) throw new ProblemException("validation-failed", { detail: "未知的链路节点" });

    /* **只允许把空的填上。** 改一个已经填过的时点，就是在改台账 ——
       而台账被改过一次，它作为证据的价值就没了。要改只能出具说明另走流程。 */
    const already = before[col as "shipped_on"];
    if (already)
      throw new ProblemException("conflict-version", {
        detail: `这一步已经登记过（${day(already)}）—— 台账只追加，改历史要另走说明流程`
      });
    if (b.stage !== "shipped" && !before.shipped_on)
      throw new ProblemException("invariant-violated", {
        detail: "样本还没登记寄出，不能直接登记收到或销毁",
        invariant: "specimen-out-of-order"
      });

    const { rows } = await c.client.query<SpecimenRow>(
      `UPDATE specimen SET ${col} = $2 WHERE id = $1 RETURNING *`, [id, b.on]);
    const row = rows[0]!;
    await this.audit.write({
      action: "update", targetType: "specimen", targetId: id,
      studySiteId: row.study_site_id, before: toSpecimen(before), after: toSpecimen(row)
    });
    return {
      ...toSpecimen(row),
      sideEffects: row.received_on || row.discarded_on
        ? [{ type: "SpecimenClosed", summary: "这管样本的链路已闭环，不再挡关闭闸门" }]
        : []
    };
  }

  /* ── 伦理递交 ─────────────────────────────────────────────────── */
  async listSubmissions(siteId: string, q: { limit: number; cursor?: string }) {
    await this.assertSite(siteId);
    const c = ctx();
    const params: unknown[] = [siteId];
    let cond = "";
    if (q.cursor) { params.push(q.cursor); cond = ` AND r.id < $${params.length}`; }
    params.push(q.limit + 1);
    const { rows } = await c.client.query<SubmissionRow>(
      `SELECT r.* FROM regulatory_submission r WHERE r.study_site_id = $1${cond}
        ORDER BY r.submitted_on DESC, r.id DESC LIMIT $${params.length}`, params);
    const items = rows.slice(0, q.limit).map(toSubmission);
    return { items, nextCursor: rows.length > q.limit ? items.at(-1)?.id ?? null : null };
  }

  async recordSubmission(siteId: string, b: {
    kind: string; submittedOn: string; refNo?: string; note?: string;
  }) {
    await this.assertSite(siteId);
    const c = ctx();
    if (b.submittedOn > todayStr())
      throw new ProblemException("validation-failed", { detail: "递交日期不能是将来" });
    const { rows } = await c.client.query<SubmissionRow>(
      `INSERT INTO regulatory_submission (study_site_id, kind, submitted_on, ref_no, note)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [siteId, b.kind, b.submittedOn, b.refNo ?? null, b.note ?? null]);
    const row = rows[0]!;
    await this.audit.write({
      action: "create", targetType: "regulatory_submission", targetId: row.id,
      studySiteId: siteId, after: toSubmission(row)
    });
    return toSubmission(row);
  }

  async decide(id: string, b: { decision: string; decidedOn: string; note?: string }) {
    const c = ctx();
    const { rows: cur } = await c.client.query<SubmissionRow>(
      "SELECT * FROM regulatory_submission WHERE id = $1", [id]);
    const before = cur[0];
    if (!before) throw notFound("递交记录");
    if (before.decision !== "pending")
      throw new ProblemException("conflict-version", {
        detail: `这一条已经有批复了（${before.decision}）—— 改批复要另走说明流程`
      });

    const { rows } = await c.client.query<SubmissionRow>(
      `UPDATE regulatory_submission
          SET decision = $2, decided_on = $3, note = COALESCE($4, note)
        WHERE id = $1 RETURNING *`, [id, b.decision, b.decidedOn, b.note ?? null]);
    const row = rows[0]!;
    await this.audit.write({
      action: "update", targetType: "regulatory_submission", targetId: id,
      studySiteId: row.study_site_id, before: toSubmission(before), after: toSubmission(row)
    });
    return {
      ...toSubmission(row),
      sideEffects: row.kind === "closeout" && row.decision === "approved"
        ? [{ type: "CloseoutApproved",
             summary: "结题报告已获批 —— 关闭闸门的最后一项前置条件成立",
             studySiteId: row.study_site_id }]
        : []
    };
  }
}
