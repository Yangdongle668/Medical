import { Injectable } from "@nestjs/common";
import { DEFAULT_HANDOVER_ITEMS } from "@sitedesk/contracts";
/* EDC 及时线与访视详情页共用同一个函数 —— 两处各写一份 5 个工作日，
   两个页面会对同一条访视给出不同的结论，而没有任何地方是红的。 */
import { edcDaysLate, dutyTotal } from "@sitedesk/calc";
import { ctx, principal } from "../../infra/ctx.js";
import { siteScopeSql } from "@sitedesk/policy";
import { ProblemException, notFound } from "../../infra/problem.js";
import { AuditService } from "../../infra/audit.service.js";
import { NotifyService } from "../../infra/notify.js";
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
  constructor(
    private readonly audit: AuditService,
    private readonly notify: NotifyService
  ) {}

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

  /** 各中心的启动清单进度。**两条查询，不是每个中心一条。**
   *
   *  逐项明细不下发：这一页问的是"哪几个中心卡住了"，
   *  而 15 个中心 × 16 项 = 240 行里，它一行都不画。
   *
   *  统计在 SQL 里做，不是取回全部 startup_item 再在 JS 里数 ——
   *  后者在 15 个中心时看不出区别，中心上到几百个时那一条请求会把
   *  几千行搬进内存，只为了得到四个整数。 */
  async listChecklists(q: { limit: number; cursor?: string; blockedOnly?: boolean }) {
    const c = ctx();
    const sc = siteScopeSql(principal(), "s");
    const params: unknown[] = [...sc.params];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const conds = [sc.sql];
    if (q.cursor) conds.push(`s.code > ${add(q.cursor)}`);

    const { rows } = await c.client.query<{
      id: string; code: string; hospital: string; state: string;
      siv_planned_on: Date | null;
      total: string; done: string; blocking_open: string; overdue: string;
    }>(`
      SELECT s.id, s.code, s.hospital, s.state, s.siv_planned_on,
             count(i.id)                                             AS total,
             count(i.id) FILTER (WHERE i.done_at IS NOT NULL)         AS done,
             count(i.id) FILTER (WHERE i.is_blocking
                                   AND i.done_at IS NULL)             AS blocking_open,
             /* 逾期与 toItem() 同一条口径：**当天到期不算逾期** ——
                逾期是"过了应完成日"，不是"今天该做"。
                所以下面是严格小于 CURRENT_DATE，不是小于等于。
                两处口径必须一致，否则汇总页说 3 项逾期、详情页说 2 项。
                （注释里不写反引号 —— 它会把这个模板字符串就地截断。） */
             count(i.id) FILTER (WHERE i.done_at IS NULL
                                   AND i.due_on IS NOT NULL
                                   AND i.due_on < CURRENT_DATE)       AS overdue
        FROM study_site s LEFT JOIN startup_item i ON i.study_site_id = s.id
       WHERE ${conds.join(" AND ")}
       GROUP BY s.id, s.code, s.hospital, s.state, s.siv_planned_on
       ORDER BY s.code LIMIT ${add(q.limit + 1)}`, params);

    const page = rows.slice(0, q.limit);
    const today = new Date();
    let items = page.map(r => ({
      studySiteId: r.id, siteCode: r.code, hospital: r.hospital, state: r.state,
      sivPlannedOn: day(r.siv_planned_on),
      daysToSiv: r.siv_planned_on ? daysBetween(today, r.siv_planned_on) : null,
      total: Number(r.total), done: Number(r.done),
      blockingOpen: Number(r.blocking_open), overdue: Number(r.overdue)
    }));
    if (q.blockedOnly) items = items.filter(x => x.blockingOpen > 0);

    return { items, nextCursor: rows.length > q.limit ? page.at(-1)!.code : null };
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

    /* ── 判定与写入之间有一道缝 ────────────────────────────────────
       上面那句 `if (before.done_at)` 是**读**出来的，而 UPDATE 是另一次
       往返。两个请求同时进来，都读到"还没完成"，然后都去写 ——
       在此之前两个都返回 201，清单项被"完成"了两次，
       审计里也就有了两条说同一件事的记录。

       把条件挪进 UPDATE 的 WHERE：谁抢到那一行谁写，
       另一个 rowCount = 0，当场变成冲突。
       上面那句读**留着**：它给的是一句说得清的话
       （「已于 X 被 Y 标记完成」），而这里只知道"没抢到"。 */
    const won = await c.client.query(
      `UPDATE startup_item SET done_at = now(), done_by = $2
        WHERE id = $1 AND done_at IS NULL`, [id, p.accountId]);
    if (!won.rowCount)
      throw new ProblemException("conflict-version", {
        detail: `「${before.item}」刚刚被另一个人标记完成了` });

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
  async listStaff(q: {
    limit: number; cursor?: string; roleKind?: string;
    successionGap?: boolean; activeOnly?: boolean;
  }) {
    const c = ctx();
    const params: unknown[] = [];
    const conds = ["true"];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    if (q.roleKind) conds.push(`st.role_kind = ${add(q.roleKind)}`);
    /* 停用的人默认**留在名册里** —— 「谁离职了、他的中心谁接的」是
       交接台账要回答的问题，把人从名册上抹掉等于抹掉那段历史。
       但发起交接的候选人列表要传 activeOnly：选一个登不进来的人，
       等于把中心交给一个没人的位置。 */
    if (q.activeOnly) conds.push("a.status = 'active'");
    if (q.cursor)   conds.push(`a.login > ${add(q.cursor)}`);
    const { rows } = await c.client.query<{
      account_id: string; login: string; display_name: string; role_kind: string;
      level: string; city: string; gcp_expires_on: Date | null;
      mentor_name: string | null; successor_name: string | null;
      successor_id: string | null; site_count: string;
      status: string; disabled_reason: string | null;
    }>(`
      SELECT st.account_id, a.login, a.display_name, st.role_kind, st.level, st.city,
             st.gcp_expires_on, m.display_name AS mentor_name,
             su.display_name AS successor_name, st.successor_account_id AS successor_id,
             a.status, a.disabled_reason,
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
        successionGap: n >= 3 && !r.successor_id,
        active: r.status === "active",
        disabledReason: r.disabled_reason
      };
    });
    if (q.successionGap) items = items.filter(i => i.successionGap);
    return { items, nextCursor: rows.length > q.limit ? items.at(-1)?.login ?? null : null };
  }

  /** 备案名册。数据源是 `app.site_staff_registry()` —— 不是 staff 表。
   *
   *  那个函数走 SECURITY DEFINER，因为 `staff_scope` 对外部方整表关闭；
   *  但它内部照样调 `app.site_visible`，所以**行范围一点没放宽**：
   *  机构办只看本院，PI 只看自己的中心，CRA 只看被指派的。
   *
   *  函数按「人 × 中心」出行，这里合并成「人」——
   *  备案备的是人，一个 CRC 在本院带三个中心是一条记录的三个中心，
   *  不是三条记录。 */
  async listSiteStaff(q: {
    limit: number; cursor?: string; roleKind?: string;
    gcpProblem?: boolean; studySiteId?: string;
  }) {
    const c = ctx();
    const params: unknown[] = [];
    const conds = ["true"];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    if (q.roleKind)     conds.push(`r.role_kind = ${add(q.roleKind)}`);
    if (q.studySiteId)  conds.push(`r.study_site_id = ${add(q.studySiteId)}`);
    /* 游标走 account_id：显示名会重名，而 login 这一列**这条端点不给**
       —— 拿一个不下发的列做游标，翻页就成了前端猜不出来的黑箱。 */
    if (q.cursor)       conds.push(`r.account_id > ${add(q.cursor)}`);

    const { rows } = await c.client.query<{
      account_id: string; display_name: string; role_kind: string;
      gcp_expires_on: Date | null; active: boolean;
      study_site_id: string; site_code: string; hospital: string;
      study_short: string; since: Date;
    }>(`SELECT r.* FROM app.site_staff_registry() r
         WHERE ${conds.join(" AND ")}
         ORDER BY r.account_id, r.site_code`, params);

    const today = new Date();
    const byAccount = new Map<string, {
      accountId: string; displayName: string; roleKind: string;
      gcpExpiresOn: string | null; gcpDaysLeft: number | null; active: boolean;
      sites: { id: string; code: string; hospital: string;
               studyShortName: string; since: string }[];
    }>();
    for (const r of rows) {
      let p = byAccount.get(r.account_id);
      if (!p) {
        p = {
          accountId: r.account_id, displayName: r.display_name, roleKind: r.role_kind,
          gcpExpiresOn: day(r.gcp_expires_on),
          gcpDaysLeft: r.gcp_expires_on ? daysBetween(today, r.gcp_expires_on) : null,
          active: r.active, sites: []
        };
        byAccount.set(r.account_id, p);
      }
      p.sites.push({
        id: r.study_site_id, code: r.site_code, hospital: r.hospital,
        studyShortName: r.study_short, since: day(r.since)!
      });
    }

    let items = [...byAccount.values()];
    /* 60 天是**备案窗口**，不是「快到期了」的美学阈值：
       换证要走机构培训与考试，排期通常一个月起。
       证书为空一并算问题 —— 没有证书和证书过期，在核查时是同一件事。 */
    if (q.gcpProblem)
      items = items.filter(i => i.gcpDaysLeft === null || i.gcpDaysLeft <= 60);
    /* 分页在合并之后切：函数按「人 × 中心」出行，
       按行数截断会把一个人的中心切成两半，第二页再出现同一个人。 */
    const pageItems = items.slice(0, q.limit);
    return {
      items: pageItems,
      nextCursor: items.length > q.limit ? pageItems.at(-1)?.accountId ?? null : null
    };
  }

  /* ── 派工 ─────────────────────────────────────────────────────────
     `site_assignment` 是行规则 `assigned` 的**唯一来源**（迁移 0002），
     而在这一版之前**全系统没有一处往里写**：种子灌了 30 行，
     `app.transfer_handover_assignments()` 在两个人之间挪行 ——
     挪的是已经存在的那些。第一行从哪来，没有答案。

     后果不是"少个功能"。开发库的审计轨迹里躺着这一条：

       09-06 11:13  admin  调整角色权限  crc
                    rowRule: assigned → team    理由：「改为按组切行」

     派不了工，就把整个角色的行规则改掉。**一个建不出来的东西，
     会被人用改规则的方式绕过去**，而绕过去之后没有任何地方是红的。 */

  private readonly ASSIGN_COLS = `
    sa.id, sa.account_id, a.display_name, sa.role_kind,
    sa.study_site_id, s.code AS site_code, s.hospital,
    st.id AS study_id, st.code AS study_code, st.short_name AS study_short,
    lower(sa.effective) AS since, upper(sa.effective) AS until,
    sa.effective @> CURRENT_DATE AS active`;
  private readonly ASSIGN_FROM = `
    site_assignment sa
    JOIN account    a  ON a.id  = sa.account_id
    JOIN study_site s  ON s.id  = sa.study_site_id
    JOIN study      st ON st.id = s.study_id`;

  /** `tail` 是 ORDER BY / LIMIT 那一截 —— **由调用方给全**。
   *  这里原来在末尾写死一句 ORDER BY，而分页那一端还要再排一次，
   *  拼出来就是两个 ORDER BY 子句：语法错误，且要到真跑那条查询时才炸。 */
  private async assignments(where: string, params: unknown[],
    tail = "ORDER BY s.code, lower(sa.effective) DESC") {
    const { rows } = await ctx().client.query<{
      id: string; account_id: string; display_name: string; role_kind: string;
      study_site_id: string; site_code: string; hospital: string;
      study_id: string; study_code: string; study_short: string;
      since: Date; until: Date | null; active: boolean;
    }>(`SELECT ${this.ASSIGN_COLS} FROM ${this.ASSIGN_FROM}
         WHERE ${where} ${tail}`, params);
    return rows.map(r => ({
      id: r.id, accountId: r.account_id, displayName: r.display_name,
      roleKind: r.role_kind, studySiteId: r.study_site_id,
      siteCode: r.site_code, hospital: r.hospital,
      studyId: r.study_id, studyCode: r.study_code, studyShortName: r.study_short,
      since: day(r.since)!, until: day(r.until), active: r.active
    }));
  }

  /* ── 一线履职：该登记的登记了没有 ──────────────────────────────────
     四类各算一个数，按人归。**全部走调用者自己的行范围** ——
     这几张表的 RLS 策略原样生效，所以 PM 数的是本组的、经营层数的是全部、
     外部方一行都没有（`staff_scope` 对他们整表关闭）。
     也正因如此它不需要一个新动作、不需要一张新表：它只是把已有的行按人归了一次。

     ── 归属是按「谁的受试者」，不是按「谁被派到这个中心」 ──────────────
     一个中心上同时有 CRA 和 CRC（演示库里每个中心都是 2 个人）。
     按派工归的话，同一条待登记访视会同时记在两个人头上 ——
     而两个人都看到"有人欠着"，多半谁都不会去办。
     `subject.crc_account_id` 是这条受试者的负责人，598/598 都有值，
     那才是"这一条归谁"的答案。受理那一类同理，归 `submitted_by`。

     ── 为什么在 SQL 里算工作日会错 ────────────────────────────────────
     EDC 那一类的判据是「完成后 5 个**工作日**」。这里先把
     `actual_date` 取回来，在 JS 里用 calc 的 `edcDaysLate` 判 ——
     和访视详情页那句「已超出 N 天」是同一个函数。
     在 SQL 里另写一版 `- interval '7 days'` 之类的近似，
     两处就会对同一条访视给出不同的结论，而没有任何地方是红的。

     ── 一个要说清的依赖：名单出自 `staff`，不是 `account` ──────────────
     所以**一个只有账号、没有名册行的 CRC 不在这张表上**，
     连带他名下欠着的事也不在。那不是这里漏了判断，是"半个人"那个坑的
     又一层：他同样填不了工时（费率按 `staff.level` 挑）、
     派工的下拉里也没有他。
     「组织与权限」的账号台账已经把缺名册的账号标出来了（`staffRoleKind`
     那一列），补登一次这三处一起好 —— 在这里凭空补一行假名册，
     换来的是一个职级是猜的人，而那会让他往后每一张工时单都算错钱。 */
  async listRegistrationDuties(q: { limit: number; cursor?: string; owingOnly?: boolean }) {
    const c = ctx();
    const params: unknown[] = [];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const cursor = q.cursor ? `AND a.login > ${add(q.cursor)}` : "";

    const { rows } = await c.client.query<{
      account_id: string; login: string; display_name: string; role_kind: string;
      pending_pi: string; out_of_window: string; acceptance_no_letter: string;
      oldest_days: string | null; today: string;
      /* EDC 那一类不在 SQL 里定结论：只把候选行的完成日取回来。 */
      edc_dates: string[] | null;
    }>(`
      WITH me AS (
        SELECT st.account_id, a.login, a.display_name, st.role_kind
          FROM staff st JOIN account a ON a.id = st.account_id
         WHERE a.status = 'active' AND st.role_kind IN ('CRC', 'CRA') ${cursor}
      ),
      v AS (
        SELECT su.crc_account_id AS account_id, sv.status, sv.actual_date,
               sv.edc_status, sv.target_date, sv.window_days
          FROM subject_visit sv JOIN subject su ON su.id = sv.subject_id
         WHERE su.crc_account_id IS NOT NULL
      ),
      ac AS (
        SELECT submitted_by AS account_id, submitted_on
          FROM site_acceptance
         WHERE state <> 'accepted' AND origin = 'in_system' AND submitted_by IS NOT NULL
      )
      SELECT me.account_id, me.login, me.display_name, me.role_kind,
             /* 「今天」取**库的** CURRENT_DATE，不取进程的 new Date()。
                这条查询里别处已经在用 CURRENT_DATE 比日期了，
                再从 JS 拿一个 UTC 切出来的今天，两者在东八区早上八点前
                差一天 —— 而差一天的错误在访视窗口上就是一次方案偏离。 */
             CURRENT_DATE::text AS today,
             (SELECT count(*) FROM v WHERE v.account_id = me.account_id
               AND v.status = 'done_pending_pi')                       AS pending_pi,
             (SELECT count(*) FROM v WHERE v.account_id = me.account_id
               AND v.status = 'planned'
               AND v.target_date + v.window_days < CURRENT_DATE)       AS out_of_window,
             (SELECT count(*) FROM ac WHERE ac.account_id = me.account_id)
                                                                       AS acceptance_no_letter,
             (SELECT array_agg(v.actual_date::text) FROM v
               WHERE v.account_id = me.account_id
                 AND v.actual_date IS NOT NULL AND v.edc_status = 'pending')
                                                                       AS edc_dates,
             /* 最久的那一件挂了多少天 —— 三类各取自己的起算日：
                待登记确认与待录 EDC 从**访视完成日**起算（那天起就欠着了），
                超窗从**窗口关闭日**起算，受理从**递交日**起算。 */
             GREATEST(
               (SELECT max(CURRENT_DATE - v.actual_date) FROM v
                 WHERE v.account_id = me.account_id AND v.actual_date IS NOT NULL
                   AND (v.status = 'done_pending_pi' OR v.edc_status = 'pending')),
               (SELECT max(CURRENT_DATE - (v.target_date + v.window_days)) FROM v
                 WHERE v.account_id = me.account_id AND v.status = 'planned'
                   AND v.target_date + v.window_days < CURRENT_DATE),
               (SELECT max(CURRENT_DATE - ac.submitted_on) FROM ac
                 WHERE ac.account_id = me.account_id)
             )                                                         AS oldest_days
        FROM me ORDER BY me.login LIMIT ${add(q.limit + 1)}`, params);

    let items = rows.slice(0, q.limit).map(r => {
      const today = r.today;
      /* 候选行里真正超时的才算。**null 是"不欠"，0 是"今天正好到期"** ——
         `edcDaysLate` 对未超时的返回 null，所以这里数的是非 null 的那些。 */
      const edcOverdue = (r.edc_dates ?? [])
        .filter(d => edcDaysLate(d, false, today) !== null).length;
      const d = {
        pendingPiConfirm: Number(r.pending_pi),
        edcOverdue,
        outOfWindow: Number(r.out_of_window),
        acceptanceNoLetter: Number(r.acceptance_no_letter)
      };
      return {
        accountId: r.account_id, login: r.login, displayName: r.display_name,
        roleKind: r.role_kind, ...d, total: dutyTotal(d),
        /* 一件都不欠时不报"最久 N 天" —— 那个数会来自一条已经办完的行。 */
        oldestDays: dutyTotal(d) === 0 || r.oldest_days === null
          ? null : Number(r.oldest_days)
      };
    });
    if (q.owingOnly) items = items.filter(i => i.total > 0);
    return {
      items,
      nextCursor: rows.length > q.limit ? rows[q.limit - 1]?.login ?? null : null
    };
  }

  async listAssignments(q: {
    limit: number; cursor?: string; studyId?: string;
    studySiteId?: string; accountId?: string; includeEnded?: boolean;
  }) {
    const params: unknown[] = [];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const conds = ["true"];
    if (q.studyId)     conds.push(`st.id = ${add(q.studyId)}`);
    if (q.studySiteId) conds.push(`sa.study_site_id = ${add(q.studySiteId)}`);
    if (q.accountId)   conds.push(`sa.account_id = ${add(q.accountId)}`);
    /* 默认只看在跑的。已结束的那些是**核查视角**的数据
       （「去年三月那次访视谁负责」），不是日常视角的 —— 混在一起，
       "这个中心现在有几个人"这个数在页面上就凑不齐了。 */
    if (!q.includeEnded) conds.push("sa.effective @> CURRENT_DATE");
    /* 游标走 id：本来的排序键（中心编号 + 起始日）会重复 ——
       派工台账里"同一个中心同一天派两个人"是正常的，
       拿一个会重复的键翻页，第二页会漏掉或重复几行。 */
    if (q.cursor)      conds.push(`sa.id > ${add(q.cursor)}`);
    const rows = await this.assignments(conds.join(" AND "), params,
      `ORDER BY sa.id LIMIT ${add(q.limit + 1)}`);
    const page = rows.slice(0, q.limit);
    return { items: page, nextCursor: rows.length > q.limit ? page.at(-1)?.id ?? null : null };
  }

  /** 派工的两端共用的那几步：这个人是谁、这几个中心在不在范围里。
   *
   *  `strict` 只在**派上去**那一端为真。撤下来那一端**必须放宽** ——
   *  最常见的撤下理由就是「他离职了」，而那时账号已经停用；
   *  两端共用同一套判定的话，一个人一走，他名下那几个中心
   *  就再也撤不下来了：系统里永远挂着一个登不进来的人在负责。
   *  （工种同理：有人从 CRA 转岗成 PM，他旧的派工照样要撤得掉。） */
  private async assignable(accountId: string, siteIds: string[], strict = true) {
    const c = ctx();
    const who = await c.client.query<{
      role_kind: string; display_name: string; status: string; gcp_expires_on: Date | null;
    }>(`SELECT st.role_kind, a.display_name, a.status, st.gcp_expires_on
          FROM staff st JOIN account a ON a.id = st.account_id
         WHERE st.account_id = $1`, [accountId]);
    if (!who.rows[0])
      throw new ProblemException("invariant-violated", {
        invariant: "assign-not-staff",
        detail: "这个账号不在员工名册里 —— 派工派的是我方的 CRA / CRC。" +
          "外部方（机构办按所属医院切行、PI 按 study_site.pi_account_id 切行）不走派工。"
      });
    const w = who.rows[0];

    /* 工种从名册取，**不接受传入** —— 请求说 CRC 而名册说 CRA，
       那是一个矛盾，不是一个可选项。而 site_assignment.role_kind 上
       有 CHECK IN ('CRA','CRC')：传进来的话，矛盾会在约束那一层炸，
       报错指不到这里。 */
    if (strict && w.role_kind !== "CRA" && w.role_kind !== "CRC")
      throw new ProblemException("invariant-violated", {
        invariant: "assign-role-kind",
        detail: `${w.display_name} 的工种是 ${w.role_kind}，派不了工 —— ` +
          "派工只对 CRA / CRC 成立，因为只有他们按「被指派的中心」切行。\n" +
          "PM 的范围来自项目归属组（把项目划给他的组：POST /v1/studies/{id}:set-team）；" +
          "QA / DM 看全部；机构办按所属医院；PI 按中心上绑定的研究者账号。"
      });
    if (strict && w.status !== "active")
      throw new ProblemException("invariant-violated", {
        invariant: "assign-disabled-account",
        detail: `${w.display_name} 的账号已停用 —— 派给他等于把中心交给一个登不进来的人`
      });

    /* 中心必须在**派工人自己的**行范围里。RLS 的 WITH CHECK 从
       迁移 0045 起也拦这一条，这里是同一条判定的应用层那一份：
       两处都在，才能同时防住"应用层忘了加条件"和"有人写了裸 SQL"。 */
    const sc = siteScopeSql(principal(), "s", 2);
    const { rows: sites } = await c.client.query<{ id: string; code: string; hospital: string }>(
      /* 按编号排 —— 下面那句「已派到 SS-01、SS-02、SS-03」是给人读的，
         而 ANY(...) 不保证顺序：同一批中心，两次调用可能排出两种样子。 */
      `SELECT s.id, s.code, s.hospital FROM study_site s
        WHERE s.id = ANY($1::uuid[]) AND ${sc.sql}
        ORDER BY s.code`, [siteIds, ...sc.params]);
    const seen = new Set(sites.map(s => s.id));
    const missing = siteIds.filter(id => !seen.has(id));
    /* 范围外与不存在返回同一个 404 —— 区分开就是在确认「它存在，
       只是不归你」，而那个确认本身就是泄漏。 */
    if (missing.length) throw notFound(`${missing.length} 个中心`);
    return { ...w, sites };
  }

  async assign(accountId: string, b: {
    studySiteIds: string[]; since?: string; reason: string;
  }) {
    const c = ctx();
    const today = new Date().toISOString().slice(0, 10);
    const since = b.since ?? today;
    /* 将来的日期不收：一条"下周一生效"的派工在今天看不出任何效果，
       而派工的人会以为已经派好了 —— 他下周一才发现没有。
       补登过去的日期允许：「他上个月就接手了，系统里补一下」是真事。 */
    if (since > today)
      throw new ProblemException("validation-failed", {
        detail: `起始日 ${since} 在将来 —— 派工从落库那一刻就该看得见效果。` +
          "要预排下个月的人手，请到排期那一侧，不要在这里留一条今天不生效的派工。"
      });

    const w = await this.assignable(accountId, b.studySiteIds);

    /* 与**任何**已有派工区间重叠的都要先分开看：
       · 正在跑的 → 跳过（「给他再加一个中心」时另外三个本来就在他名下）
       · 不在跑但区间重叠 → 这是补登日期撞上了他以前负责的那一段，
         静静跳过就成了"派了却没派上"，所以报出来。 */
    const { rows: clash } = await c.client.query<{
      study_site_id: string; code: string; active: boolean; lo: Date; hi: Date | null;
    }>(`SELECT sa.study_site_id, s.code, sa.effective @> CURRENT_DATE AS active,
               lower(sa.effective) AS lo, upper(sa.effective) AS hi
          FROM site_assignment sa JOIN study_site s ON s.id = sa.study_site_id
         WHERE sa.account_id = $1 AND sa.study_site_id = ANY($2::uuid[])
           AND sa.effective && daterange($3::date, NULL, '[)')`,
      [accountId, b.studySiteIds, since]);

    const overlap = clash.filter(r => !r.active);
    if (overlap.length)
      throw new ProblemException("invariant-violated", {
        invariant: "assign-overlaps-past",
        detail: `起始日 ${since} 撞上了 ${w.display_name} 以前在 ` +
          `${overlap.map(r => r.code).join("、")} 上的派工` +
          `（${overlap.map(r => `${day(r.lo)}→${day(r.hi) ?? "至今"}`).join("、")}）——` +
          "同一人对同一中心的派工区间不得重叠，否则「他什么时候开始负责」没有答案。"
      });

    const running = new Set(clash.map(r => r.study_site_id));
    const skipped = w.sites.filter(s => running.has(s.id));
    const fresh = w.sites.filter(s => !running.has(s.id));

    /* 一个都没派成不是"成功了但没变化"。和交接收单那一条同一个道理：
       返回 201 而什么也没发生，点的人会以为派好了。 */
    if (!fresh.length)
      throw new ProblemException("invariant-violated", {
        invariant: "assign-nothing-to-do",
        detail: `${w.display_name} 本来就在跑这 ${skipped.length} 个中心` +
          `（${skipped.map(s => s.code).join("、")}）—— 没有变化就不该留一条审计`
      });

    await c.client.query(
      `INSERT INTO site_assignment (account_id, study_site_id, role_kind, effective)
       SELECT $1, x, $2, daterange($3::date, NULL, '[)')
         FROM unnest($4::uuid[]) AS x`,
      [accountId, w.role_kind, since, fresh.map(s => s.id)]);

    await this.audit.write({
      action: "派工到中心", targetType: "account", targetId: w.display_name,
      before: { sites: skipped.map(s => s.code) },
      after: { sites: fresh.map(s => s.code), roleKind: w.role_kind, since },
      studySiteId: fresh[0]!.id, reason: b.reason });

    /* 被派的人要知道 —— 在此之前他打开系统只会发现多了几个中心，
       没有任何人告诉他为什么。和交接那一条同一个理由。 */
    this.notify.queue({
      accountId,
      subject: `派工：${fresh.length} 个中心现在归你`,
      text: [
        `${w.display_name}，你好：`, "",
        `你被派到以下中心，自 ${since} 起生效：`,
        ...fresh.map(s => `  · ${s.code} ${s.hospital}`), "",
        `原因：${b.reason}`, "",
        "从现在起这些中心的受试者、访视、质疑、药品台账你都看得见，也由你负责。"
      ].join("\n")
    });

    const made = await this.assignments(
      "sa.account_id = $1 AND sa.study_site_id = ANY($2::uuid[]) AND sa.effective @> CURRENT_DATE",
      [accountId, fresh.map(s => s.id)]);

    const gcpLeft = w.gcp_expires_on
      ? daysBetween(new Date(), w.gcp_expires_on) : null;
    return {
      data: made,
      sideEffects: [
        {
          type: "SiteAssignmentChanged" as const,
          summary: `${w.display_name}（${w.role_kind}）已派到 ` +
            `${fresh.map(s => s.code).join("、")} —— ` +
            "他从这一刻起看得见这些中心的受试者与访视" +
            (skipped.length ? `；另 ${skipped.length} 个本来就在他名下，跳过` : ""),
          ref: accountId, studySiteId: fresh[0]!.id
        },
        /* GCP 过期**不拦派工，但必须当场说出来**：拦的话，
           复训正在排期的人就一个中心也接不了；不说的话，
           一个证书已经失效的人被派到中心上，没有任何地方是红的 ——
           而那正是核查会开出来的发现项。 */
        ...(gcpLeft === null || gcpLeft < 0 ? [{
          type: "SiteAssignmentChanged" as const,
          summary: gcpLeft === null
            ? `注意：${w.display_name} 的 GCP 证书没有登记 —— ` +
              "核查时「没有证书」和「证书过期」是同一件事"
            : `注意：${w.display_name} 的 GCP 证书已过期 ${-gcpLeft} 天` +
              `（${day(w.gcp_expires_on)}）—— 过期即不得开展工作。` +
              "派工照做了，但在复训之前他不该出现在中心里。",
          ref: accountId
        }] : [])
      ]
    };
  }

  async endAssignment(accountId: string,
    b: { studySiteIds: string[]; reason: string }) {
    const c = ctx();
    /* 放宽那一端：离职（账号停用）、转岗（工种不再是 CRA / CRC）
       恰恰是最常见的两个撤下理由。 */
    const w = await this.assignable(accountId, b.studySiteIds, false);

    const { rows: live } = await c.client.query<{
      id: string; study_site_id: string; code: string; same_day: boolean;
    }>(`SELECT sa.id, sa.study_site_id, s.code,
               lower(sa.effective) >= CURRENT_DATE AS same_day
          FROM site_assignment sa JOIN study_site s ON s.id = sa.study_site_id
         WHERE sa.account_id = $1 AND sa.study_site_id = ANY($2::uuid[])
           AND sa.effective @> CURRENT_DATE`, [accountId, b.studySiteIds]);

    if (!live.length)
      throw new ProblemException("invariant-violated", {
        invariant: "unassign-nothing-to-do",
        detail: `${w.display_name} 现在一个都不在跑这些中心 —— 没有变化就不该留一条审计`
      });

    /* 今天派、今天撤的**删掉**：它一天都没生效过，
       收口会得到一段零长度的区间，而备案名册上多出一行
       「2026-09-13 → 2026-09-13」，只会让人多问一句"这是什么"。 */
    const sameDay = live.filter(r => r.same_day).map(r => r.id);
    /* 生效过的**收口，不删**：他确实负责过那一段，
       而"去年三月那次访视谁负责"是核查会问的事实。 */
    const older = live.filter(r => !r.same_day).map(r => r.id);
    if (sameDay.length)
      await c.client.query("DELETE FROM site_assignment WHERE id = ANY($1::uuid[])", [sameDay]);
    if (older.length)
      await c.client.query(
        `UPDATE site_assignment
            SET effective = daterange(lower(effective), CURRENT_DATE, '[)')
          WHERE id = ANY($1::uuid[])`, [older]);

    const codes = live.map(r => r.code);
    await this.audit.write({
      action: "从中心撤下", targetType: "account", targetId: w.display_name,
      before: { sites: codes },
      after: { until: new Date().toISOString().slice(0, 10),
               cancelled: live.filter(r => r.same_day).map(r => r.code) },
      studySiteId: live[0]!.study_site_id, reason: b.reason });

    this.notify.queue({
      accountId,
      subject: `派工结束：${codes.length} 个中心不再归你`,
      text: [
        `${w.display_name}，你好：`, "",
        "以下中心的派工已经结束，你从这一刻起看不见它们：",
        ...codes.map(c2 => `  · ${c2}`), "",
        `原因：${b.reason}`, "",
        "如果还有没交代完的事，现在就找接手人讲 ——",
        "要把在组受试者逐例交底的，走「交接」那条路，不要只撤派工。"
      ].join("\n")
    });

    return {
      data: await this.assignments(
        "sa.account_id = $1 AND sa.study_site_id = ANY($2::uuid[])",
        [accountId, b.studySiteIds]),
      sideEffects: [{
        type: "SiteAssignmentChanged" as const,
        summary: `${w.display_name} 已从 ${codes.join("、")} 撤下 —— ` +
          "他从这一刻起看不见这些中心的受试者与访视" +
          (sameDay.length
            ? `；其中 ${sameDay.length} 条是今天派今天撤，一天都没生效过，已删除`
            : ""),
        ref: accountId, studySiteId: live[0]!.study_site_id
      }]
    };
  }

  /* ── 交接 ─────────────────────────────────────────────────────── */

  /** 一批交接单的完整装配 —— **固定 3 条 SQL，与条数无关**。
   *
   *  原来列表是 `for (const r of rows) await this.handover(r.id)`：
   *  每行再发三条查询，20 行就是 61 条。它不报错、不变红，
   *  只是随数据量线性变慢 —— 而 Phase 8b 立的那条守卫
   *  （limit 1 与 limit 50 必须发同样多的 SQL）当时没有覆盖这个端点，
   *  于是"目前没有 N+1"这句话把它漏掉了。现在它也在守卫里。 */
  private async assemble(ids: string[]) {
    if (!ids.length) return [];
    const c = ctx();
    const heads = await c.client.query<{
      id: string; from_account_id: string; from_name: string;
      to_account_id: string; to_name: string; reason: string;
      planned_on: Date; status: string; completed_at: Date | null;
    }>(`SELECT h.id, h.from_account_id, f.display_name AS from_name,
               h.to_account_id, t.display_name AS to_name,
               h.reason, h.planned_on, h.status, h.completed_at
          FROM handover h JOIN account f ON f.id = h.from_account_id
                          JOIN account t ON t.id = h.to_account_id
         WHERE h.id = ANY($1::uuid[])`, [ids]);

    const sites = await c.client.query<{
      handover_id: string; id: string; code: string; hospital: string;
    }>(`SELECT hs.handover_id, s.id, s.code, s.hospital
          FROM handover_site hs JOIN study_site s ON s.id = hs.study_site_id
         WHERE hs.handover_id = ANY($1::uuid[]) ORDER BY s.code`, [ids]);

    const items = await c.client.query<{
      handover_id: string; seq: number; item: string;
      done_at: Date | null; done_by_name: string | null;
    }>(`SELECT hi.handover_id, hi.seq, hi.item, hi.done_at, a.display_name AS done_by_name
          FROM handover_item hi LEFT JOIN account a ON a.id = hi.done_by
         WHERE hi.handover_id = ANY($1::uuid[]) ORDER BY hi.seq`, [ids]);

    /* 按 handover_id 分组。**RLS 可能把某几条挡在外面** —— 那时 heads
       里就没有那一行，而不是给一个空壳：范围之外一律当作不存在。 */
    const byId = <T extends { handover_id: string }>(rs: T[]) => {
      const m = new Map<string, T[]>();
      for (const r of rs) (m.get(r.handover_id) ?? m.set(r.handover_id, []).get(r.handover_id)!).push(r);
      return m;
    };
    const siteMap = byId(sites.rows), itemMap = byId(items.rows);
    const headMap = new Map(heads.rows.map(h => [h.id, h]));

    /* 按传入的 ids 顺序还原 —— 列表的排序在上游那条查询里，
       这里用 Map 取回来的话顺序就丢了。 */
    return ids.flatMap((id) => {
      const h = headMap.get(id);
      if (!h) return [];
      const its = itemMap.get(id) ?? [];
      return [{
        id: h.id,
        fromAccountId: h.from_account_id, fromName: h.from_name,
        toAccountId: h.to_account_id, toName: h.to_name,
        reason: h.reason, plannedOn: day(h.planned_on)!, status: h.status,
        completedAt: iso(h.completed_at),
        sites: (siteMap.get(id) ?? []).map(s => ({ id: s.id, code: s.code, hospital: s.hospital })),
        items: its.map(i => ({
          seq: i.seq, item: i.item, doneAt: iso(i.done_at), doneByName: i.done_by_name })),
        doneCount: its.filter(i => i.done_at).length,
        totalCount: its.length
      }];
    });
  }

  private async handover(id: string) {
    const one = (await this.assemble([id]))[0];
    if (!one) throw notFound("交接单");
    return one;
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
    const items = await this.assemble(rows.slice(0, q.limit).map(r => r.id));
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

    const made = await this.handover(id);

    /* 通知接手人（欠账 D5）。**交接是发起人单方面做的动作** ——
       在此之前接手人完全不知道有这回事：系统里多了一笔单子，
       界面上多了几个中心，但没有任何人告诉他。
       于是"交接"实际发生在微信群里，系统只是事后记账。 */
    this.notify.queue({
      accountId: b.toAccountId,
      subject: `交接给你：${made.sites.length} 个中心（计划 ${b.plannedOn}）`,
      text: [
        `${to.rows[0].name}，你好：`, "",
        `${made.fromName} 发起了一笔交接，计划 ${b.plannedOn} 生效，交给你的是：`,
        ...made.sites.map(x => `  · ${x.code} ${x.hospital}`), "",
        `原因：${b.reason}`, "",
        "交接期间你已经能看到这几个中心的受试者与访视 ——",
        "清单里最要命的一项是「在组受试者逐例交底」，**逐例交底之前先自己核对一遍**。",
        "", "打开中心台的「交接」页逐项确认。"
      ].join("\n")
    });
    return made;
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

    /* 派工转移：原负责人的派工结束于今天，接手人从今天开始。

       **这一段曾经静默失败过，值得记住失败的形状：**
       原来它以调用者的身份去查原负责人的派工，而接手人不在那些行的
       可见范围里 —— 查回 0 行，代码 `continue`，一个中心也没转，
       接口照样回 201：交接单显示「已完成」，两个人都以为交完了，
       实际上谁也没接手。

       现在交给 `app.transfer_handover_assignments()`：授权在函数内部自己判
       （只有当事人双方能触发），于是"放宽"的范围就只有
       「这一个命令、这一笔单子」。
       放宽行范围策略也能让它跑通，但那会波及所有中心相关表 ——
       packages/policy 的等价性测试当场把那条路否掉了（见迁移 0011）。 */
    const t = await c.client.query<{ site_code: string; moved: boolean }>(
      `SELECT site_code, moved FROM app.transfer_handover_assignments($1)`, [id]);
    const moved = t.rows.filter(r => r.moved).map(r => r.site_code);
    /* 原负责人此刻确实可能已经没有某个中心了（同一中心交接过两次，
       或他已被调离）。那种跳过是合理的，但**必须说出来**。 */
    const skipped = t.rows.filter(r => !r.moved).map(r => r.site_code);

    /* 一个中心都没转移，却把交接标成已完成 —— 那不是"完成"，是丢单。
       抛出去让整个请求回滚：状态留在 pending，比留下一个
       「已完成但什么也没发生」的交接单要好得多。 */
    if (t.rows.length > 0 && moved.length === 0)
      throw new ProblemException("invariant-violated", {
        detail: `交接清单已确认，但 ${t.rows.length} 个中心的派工一个也没转移 ——` +
          `原负责人 ${h.fromName} 当前没有这些中心的有效派工。交接未完成。`,
        invariant: "handover-must-move-assignments" });

    await this.audit.write({
      action: "完成交接", targetType: "handover", targetId: id,
      before: { status: "pending" }, after: { status: "completed", moved, skipped },
      studySiteId: h.sites[0]?.id ?? null,
      reason: `${h.fromName} → ${h.toName}：${h.reason}` });

    /* 收单之后**两边都要收到通知**：接手人要知道派工真的转过来了
       （在此之前那只是一段会过期的临时可见性），
       原负责人要知道自己不再对这些中心负责 ——
       "我以为还是我在管"和"我以为已经不归我了"一样贵。
       由谁点的"完成"不重要：两个人都需要这条消息。 */
    const list = moved.length ? moved.join("、") : "（无）";
    this.notify.queue({
      accountId: h.toAccountId,
      subject: `交接已完成：${moved.length} 个中心现在归你`,
      text: [
        `${h.toName}，你好：`, "",
        `${h.fromName} 与你的交接已完成，以下中心的派工已经转到你名下：`,
        `  ${list}`, "",
        ...(skipped.length
          ? [`另有 ${skipped.length} 个中心未转移（${skipped.join("、")}）——`,
             "原负责人当时已经没有它们的有效派工。如果这不符合预期，找项目总监确认。", ""]
          : []),
        "从现在起这些中心的访视、质疑、药品台账都由你负责。"
      ].join("\n")
    });
    this.notify.queue({
      accountId: h.fromAccountId,
      subject: `交接已完成：${moved.length} 个中心已转出`,
      text: [
        `${h.fromName}，你好：`, "",
        `你与 ${h.toName} 的交接已完成，以下中心的派工已经转出：`,
        `  ${list}`, "",
        "你不再看得到这些中心 —— 如果还有没交代完的事，现在就找接手人讲。"
      ].join("\n")
    });

    return {
      data: await this.handover(id),
      sideEffects: [
        ...moved.map(code => ({
          type: "SiteStateChanged" as const,
          summary: `${code} 的派工已由 ${h.fromName} 转至 ${h.toName} —— 双方的可见范围随即改变`
        })),
        /* 部分跳过也要出现在明面上，而不是让人从数目对不上里自己发现 */
        ...(skipped.length ? [{
          type: "SiteStateChanged" as const,
          summary: `${skipped.join("、")} 未转移：${h.fromName} 当前没有这些中心的有效派工`
        }] : [])
      ]
    };
  }
}
