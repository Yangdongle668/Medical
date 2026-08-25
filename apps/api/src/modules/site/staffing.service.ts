import { Injectable } from "@nestjs/common";
import { DEFAULT_HANDOVER_ITEMS } from "@sitedesk/contracts";
import { ctx, principal } from "../../infra/ctx.js";
import { ProblemException, notFound } from "../../infra/problem.js";
import { AuditService } from "../../infra/audit.service.js";
import { evaluateGate } from "./gate.js";

const day = (v: Date | null) => v ? v.toISOString().slice(0, 10) : null;
const iso = (v: Date | null) => v ? v.toISOString() : null;
/** 两个**日历日**之间相差几天。
 *  必须先把两端归到当地零点：`new Date()` 带着时分秒，
 *  拿它直接和 date 列相减，当天到期的项会算出「逾期 0 天」——
 *  既进了逾期清单，又显示 0 天。差一天的错误在访视窗口上就是一次方案偏离。 */
const atMidnight = (v: Date) => new Date(v.getFullYear(), v.getMonth(), v.getDate());
const daysBetween = (a: Date, b: Date) =>
  Math.round((atMidnight(b).getTime() - atMidnight(a).getTime()) / 86_400_000);

interface ItemRow {
  id: string; study_site_id: string; category: string; category_label: string;
  item: string; owner_account_id: string | null; owner_name: string | null;
  due_on: Date | null; is_blocking: boolean;
  done_at: Date | null; done_by_name: string | null;
}
const ITEM_COLS = `
  i.id, i.study_site_id, i.category, c.label AS category_label, i.item,
  i.owner_account_id, o.display_name AS owner_name, i.due_on, i.is_blocking,
  i.done_at, b.display_name AS done_by_name`;
const ITEM_FROM = `
  startup_item i
  JOIN startup_category c ON c.code = i.category
  LEFT JOIN account o ON o.id = i.owner_account_id
  LEFT JOIN account b ON b.id = i.done_by`;

const toItem = (r: ItemRow, today = new Date()) => ({
  id: r.id, studySiteId: r.study_site_id,
  category: r.category, categoryLabel: r.category_label, item: r.item,
  ownerAccountId: r.owner_account_id, ownerName: r.owner_name,
  dueOn: day(r.due_on), isBlocking: r.is_blocking,
  doneAt: iso(r.done_at), doneByName: r.done_by_name,
  /* 当天到期不算逾期 —— 逾期是「过了应完成日」，不是「今天该做」 */
  overdueDays: !r.done_at && r.due_on && daysBetween(r.due_on, today) > 0
    ? daysBetween(r.due_on, today) : null
});

@Injectable()
export class StaffingService {
  constructor(private readonly audit: AuditService) {}

  /* ── 启动清单 ─────────────────────────────────────────────────── */
  async checklist(siteId: string) {
    const c = ctx();
    /* 中心本身受行范围约束；清单靠 RLS 跟着走，这里再取一次是为了拿到编号与计划 SIV 日 */
    const site = await c.client.query<{
      id: string; code: string; hospital: string; state: string; siv_planned_on: Date | null;
    }>(`SELECT id, code, hospital, state, siv_planned_on FROM study_site WHERE id = $1`, [siteId]);
    if (!site.rows[0]) throw notFound("中心");
    const s = site.rows[0];

    const { rows } = await c.client.query<ItemRow>(
      `SELECT ${ITEM_COLS} FROM ${ITEM_FROM}
        WHERE i.study_site_id = $1 ORDER BY c.seq, i.sort_order`, [siteId]);
    const today = new Date();
    const items = rows.map(r => toItem(r, today));

    return {
      studySiteId: s.id, siteCode: s.code, hospital: s.hospital, state: s.state,
      sivPlannedOn: day(s.siv_planned_on),
      daysToSiv: s.siv_planned_on ? daysBetween(today, s.siv_planned_on) : null,
      total: items.length,
      done: items.filter(i => i.doneAt).length,
      blockingOpen: items.filter(i => i.isBlocking && !i.doneAt).length,
      overdue: items.filter(i => i.overdueDays !== null).length,
      items
    };
  }

  private async item(id: string): Promise<ItemRow> {
    const { rows } = await ctx().client.query<ItemRow>(
      `SELECT ${ITEM_COLS} FROM ${ITEM_FROM} WHERE i.id = $1`, [id]);
    if (!rows[0]) throw notFound("启动清单项");
    return rows[0];
  }

  async completeItem(id: string, note?: string) {
    const c = ctx(), p = principal();
    const before = await this.item(id);
    if (before.done_at) throw new ProblemException("conflict-version", {
      detail: `「${before.item}」已于 ${iso(before.done_at)} 被标记完成` });

    await c.client.query(
      `UPDATE startup_item SET done_at = now(), done_by = $2 WHERE id = $1`, [id, p.accountId]);
    await this.audit.write({
      action: "完成启动清单项", targetType: "startup_item", targetId: before.item,
      before: { doneAt: null }, after: { doneAt: new Date().toISOString() },
      studySiteId: before.study_site_id, reason: note ?? null });

    const after = await this.item(id);
    const gate = await evaluateGate(c.client, before.study_site_id, "siv");
    const sideEffects: { type: "SiteStateChanged"; summary: string; ref?: string; studySiteId?: string }[] = [];
    if (before.is_blocking && gate.satisfied)
      sideEffects.push({
        type: "SiteStateChanged",
        summary: "最后一个启动阻塞项已清零 —— 该中心现在可以推进到「SIV启动」",
        ref: before.study_site_id, studySiteId: before.study_site_id
      });
    return { data: toItem(after), sideEffects };
  }

  async reopenItem(id: string, reason: string) {
    const c = ctx();
    const before = await this.item(id);
    if (!before.done_at) throw new ProblemException("conflict-version", {
      detail: `「${before.item}」本来就未完成` });

    await c.client.query(
      `UPDATE startup_item SET done_at = NULL, done_by = NULL WHERE id = $1`, [id]);
    await this.audit.write({
      action: "撤销启动清单项", targetType: "startup_item", targetId: before.item,
      before: { doneAt: iso(before.done_at) }, after: { doneAt: null },
      studySiteId: before.study_site_id, reason });

    const site = await c.client.query<{ code: string; state: string }>(
      `SELECT code, state FROM study_site WHERE id = $1`, [before.study_site_id]);
    const sideEffects = before.is_blocking && site.rows[0]
      && ["siv", "enrolling", "enrolled", "followup"].includes(site.rows[0].state)
      ? [{
          type: "SiteStateChanged" as const,
          summary: `注意：${site.rows[0].code} 已处于「${site.rows[0].state}」，` +
            `但一个启动阻塞项被撤回 —— 该中心当初的启动条件现在不成立`,
          ref: before.study_site_id, studySiteId: before.study_site_id
        }]
      : [];
    return { data: toItem(await this.item(id)), sideEffects };
  }

  /* ── 人员 ─────────────────────────────────────────────────────── */
  async listStaff(q: { limit: number; cursor?: string; roleKind?: string; successionGap?: boolean }) {
    const c = ctx();
    const params: unknown[] = [];
    const conds = ["true"];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    if (q.roleKind) conds.push(`st.role_kind = ${add(q.roleKind)}`);
    if (q.cursor)   conds.push(`a.login > ${add(q.cursor)}`);
    const { rows } = await c.client.query<{
      account_id: string; login: string; display_name: string; role_kind: string;
      level: string; city: string; gcp_expires_on: Date | null;
      mentor_name: string | null; successor_name: string | null;
      successor_id: string | null; site_count: string;
    }>(`
      SELECT st.account_id, a.login, a.display_name, st.role_kind, st.level, st.city,
             st.gcp_expires_on, m.display_name AS mentor_name,
             su.display_name AS successor_name, st.successor_account_id AS successor_id,
             (SELECT count(*) FROM site_assignment sa
               WHERE sa.account_id = st.account_id AND sa.effective @> CURRENT_DATE) AS site_count
        FROM staff st JOIN account a ON a.id = st.account_id
        LEFT JOIN account m  ON m.id  = st.mentor_account_id
        LEFT JOIN account su ON su.id = st.successor_account_id
       WHERE ${conds.join(" AND ")} ORDER BY a.login LIMIT ${add(q.limit + 1)}`, params);

    const today = new Date();
    let items = rows.slice(0, q.limit).map(r => {
      const n = Number(r.site_count);
      return {
        accountId: r.account_id, login: r.login, displayName: r.display_name,
        roleKind: r.role_kind, level: r.level, city: r.city,
        gcpExpiresOn: day(r.gcp_expires_on),
        gcpDaysLeft: r.gcp_expires_on ? daysBetween(today, r.gcp_expires_on) : null,
        mentorName: r.mentor_name, successorName: r.successor_name,
        siteCount: n,
        /* 带 3 个以上中心却没有继任者 —— 一旦离职就断档 */
        successionGap: n >= 3 && !r.successor_id
      };
    });
    if (q.successionGap) items = items.filter(i => i.successionGap);
    return { items, nextCursor: rows.length > q.limit ? items.at(-1)?.login ?? null : null };
  }

  /* ── 交接 ─────────────────────────────────────────────────────── */
  private async handover(id: string) {
    const c = ctx();
    const { rows } = await c.client.query<{
      id: string; from_account_id: string; from_name: string;
      to_account_id: string; to_name: string; reason: string;
      planned_on: Date; status: string; completed_at: Date | null;
    }>(`SELECT h.id, h.from_account_id, f.display_name AS from_name,
               h.to_account_id, t.display_name AS to_name,
               h.reason, h.planned_on, h.status, h.completed_at
          FROM handover h JOIN account f ON f.id = h.from_account_id
                          JOIN account t ON t.id = h.to_account_id
         WHERE h.id = $1`, [id]);
    const h = rows[0];
    if (!h) throw notFound("交接单");
    const sites = await c.client.query<{ id: string; code: string; hospital: string }>(
      `SELECT s.id, s.code, s.hospital FROM handover_site hs
         JOIN study_site s ON s.id = hs.study_site_id
        WHERE hs.handover_id = $1 ORDER BY s.code`, [id]);
    const items = await c.client.query<{
      seq: number; item: string; done_at: Date | null; done_by_name: string | null;
    }>(`SELECT hi.seq, hi.item, hi.done_at, a.display_name AS done_by_name
          FROM handover_item hi LEFT JOIN account a ON a.id = hi.done_by
         WHERE hi.handover_id = $1 ORDER BY hi.seq`, [id]);
    return {
      id: h.id,
      fromAccountId: h.from_account_id, fromName: h.from_name,
      toAccountId: h.to_account_id, toName: h.to_name,
      reason: h.reason, plannedOn: day(h.planned_on)!, status: h.status,
      completedAt: iso(h.completed_at),
      sites: sites.rows,
      items: items.rows.map(i => ({
        seq: i.seq, item: i.item, doneAt: iso(i.done_at), doneByName: i.done_by_name })),
      doneCount: items.rows.filter(i => i.done_at).length,
      totalCount: items.rows.length
    };
  }

  async listHandovers(q: { limit: number; cursor?: string; status?: string }) {
    const c = ctx();
    const params: unknown[] = [];
    const conds = ["true"];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    if (q.status) conds.push(`h.status = ${add(q.status)}`);
    if (q.cursor) conds.push(`h.id < ${add(q.cursor)}`);
    const { rows } = await c.client.query<{ id: string }>(
      `SELECT h.id FROM handover h WHERE ${conds.join(" AND ")}
        ORDER BY h.planned_on DESC, h.id DESC LIMIT ${add(q.limit + 1)}`, params);
    const items = [];
    for (const r of rows.slice(0, q.limit)) items.push(await this.handover(r.id));
    return { items, nextCursor: rows.length > q.limit ? items.at(-1)?.id ?? null : null };
  }

  async createHandover(b: {
    toAccountId: string; studySiteIds: string[]; reason: string; plannedOn: string;
  }) {
    const c = ctx(), p = principal();
    if (b.toAccountId === p.accountId)
      throw new ProblemException("validation-failed", { detail: "不能把中心交接给自己" });

    /* 只能交接自己当前负责的中心 */
    const mine = await c.client.query<{ study_site_id: string }>(
      `SELECT study_site_id FROM site_assignment
        WHERE account_id = $1 AND effective @> CURRENT_DATE
          AND study_site_id = ANY($2)`, [p.accountId, b.studySiteIds]);
    const held = new Set(mine.rows.map(r => r.study_site_id));
    const notMine = b.studySiteIds.filter(id => !held.has(id));
    if (notMine.length)
      throw new ProblemException("invariant-violated", {
        detail: `只能交接自己当前负责的中心；有 ${notMine.length} 个不在你的派工里`,
        invariant: "handover-only-own-sites" });

    /* 接手人必须是同工种的在职人员 —— CRA 与 CRC 不能互相顶替 */
    const to = await c.client.query<{ role_kind: string; status: string; name: string }>(
      `SELECT st.role_kind, a.status, a.display_name AS name
         FROM staff st JOIN account a ON a.id = st.account_id
        WHERE st.account_id = $1`, [b.toAccountId]);
    const me = await c.client.query<{ role_kind: string }>(
      `SELECT role_kind FROM staff WHERE account_id = $1`, [p.accountId]);
    if (!to.rows[0] || to.rows[0].status !== "active")
      throw new ProblemException("validation-failed", { detail: "接手人不存在或已停用" });
    if (me.rows[0] && to.rows[0].role_kind !== me.rows[0].role_kind)
      throw new ProblemException("invariant-violated", {
        detail: `接手人是 ${to.rows[0].role_kind}，与你的工种 ${me.rows[0].role_kind} 不同 —— ` +
          `CRA 与 CRC 不能互相顶替`,
        invariant: "handover-same-role-kind" });

    const { rows } = await c.client.query<{ id: string }>(
      `INSERT INTO handover (from_account_id, to_account_id, reason, planned_on)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [p.accountId, b.toAccountId, b.reason, b.plannedOn]);
    const id = rows[0]!.id;
    for (const s of b.studySiteIds)
      await c.client.query(
        `INSERT INTO handover_site (handover_id, study_site_id) VALUES ($1,$2)`, [id, s]);
    for (const [i, item] of DEFAULT_HANDOVER_ITEMS.entries())
      await c.client.query(
        `INSERT INTO handover_item (handover_id, seq, item) VALUES ($1,$2,$3)`, [id, i, item]);

    await this.audit.write({
      action: "发起交接", targetType: "handover", targetId: id,
      after: { to: to.rows[0].name, sites: b.studySiteIds.length },
      studySiteId: b.studySiteIds[0] ?? null, reason: b.reason });
    return this.handover(id);
  }

  async completeHandoverItem(id: string, seq: number) {
    const c = ctx(), p = principal();
    const r = await c.client.query(
      `UPDATE handover_item SET done_at = now(), done_by = $3
        WHERE handover_id = $1 AND seq = $2 AND done_at IS NULL`, [id, seq, p.accountId]);
    if (!r.rowCount) throw notFound("交接清单项");
    const h = await this.handover(id);
    return {
      data: h,
      sideEffects: h.doneCount === h.totalCount
        ? [{ type: "SiteStateChanged" as const,
             summary: `${h.totalCount} 项清单已全部确认 —— 现在可以完成这笔交接` , ref: h.id }]
        : []
    };
  }

  async completeHandover(id: string) {
    const c = ctx();
    const h = await this.handover(id);
    if (h.status !== "pending")
      throw new ProblemException("conflict-version", { detail: `交接单已是「${h.status}」` });

    /* 清单未逐项确认不得完成 —— 签了字但受试者没交底，等于没交接 */
    const open = h.items.filter(i => !i.doneAt);
    if (open.length)
      throw new ProblemException("gate-not-satisfied", {
        detail: `交接清单还有 ${open.length} 项未确认`,
        unmet: open.map(i => ({
          code: "handover-item-open", message: i.item, module: "handover" })) });

    await c.client.query(
      `UPDATE handover SET status='completed', completed_at=now() WHERE id=$1`, [id]);

    /* 派工转移：原负责人的派工结束于今天，接手人从今天开始 */
    const moved: string[] = [];
    for (const s of h.sites) {
      const kind = await c.client.query<{ role_kind: string }>(
        `SELECT role_kind FROM site_assignment
          WHERE account_id = $1 AND study_site_id = $2 AND effective @> CURRENT_DATE`,
        [h.fromAccountId, s.id]);
      if (!kind.rows[0]) continue;
      await c.client.query(
        `UPDATE site_assignment
            SET effective = daterange(lower(effective), CURRENT_DATE, '[)')
          WHERE account_id = $1 AND study_site_id = $2 AND effective @> CURRENT_DATE`,
        [h.fromAccountId, s.id]);
      await c.client.query(
        `INSERT INTO site_assignment (account_id, study_site_id, role_kind, effective)
         VALUES ($1,$2,$3, daterange(CURRENT_DATE, NULL, '[)'))`,
        [h.toAccountId, s.id, kind.rows[0].role_kind]);
      moved.push(s.code);
    }

    await this.audit.write({
      action: "完成交接", targetType: "handover", targetId: id,
      before: { status: "pending" }, after: { status: "completed", moved },
      studySiteId: h.sites[0]?.id ?? null,
      reason: `${h.fromName} → ${h.toName}：${h.reason}` });

    return {
      data: await this.handover(id),
      sideEffects: moved.map(code => ({
        type: "SiteStateChanged" as const,
        summary: `${code} 的派工已由 ${h.fromName} 转至 ${h.toName} —— 双方的可见范围随即改变`
      }))
    };
  }
}
