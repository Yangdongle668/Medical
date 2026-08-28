import { Injectable } from "@nestjs/common";
import { canSeeSite, siteScopeSql } from "@sitedesk/policy";
import { ctx, principal } from "../../infra/ctx.js";
import { ProblemException, notFound } from "../../infra/problem.js";
import { AuditService } from "../../infra/audit.service.js";
import { hashPassword, passwordProblem } from "../../auth/password.js";


interface AccountRow {
  id: string; login: string; display_name: string; is_external: boolean;
  org_ref: string | null; status: string; joined_on: Date | null;
  disabled_at: Date | null; disabled_reason: string | null; last_login_at: Date | null;
  role_id: string; role_code: string; role_name: string; role_external: boolean;
  team_id: string | null; team_code: string | null; team_name: string | null;
}
const ACCOUNT_COLS = `
  a.id, a.login, a.display_name, a.is_external, a.org_ref, a.status, a.joined_on,
  a.disabled_at, a.disabled_reason, a.last_login_at,
  r.id AS role_id, r.code AS role_code, r.name AS role_name, r.is_external AS role_external,
  t.id AS team_id, t.code AS team_code, t.name AS team_name`;
const ACCOUNT_FROM = `account a JOIN role r ON r.id = a.role_id LEFT JOIN team t ON t.id = a.team_id`;
const iso = (v: Date | null) => v ? v.toISOString() : null;
const day = (v: Date | null) => v ? v.toISOString().slice(0, 10) : null;

/** 副作用信封。和 clinical 那边同一个形状 —— 前端只认 type 与 summary。 */
interface Effect {
  type: string; summary: string;
  ref?: string; amountCents?: number; studySiteId?: string;
}

const toAccount = (r: AccountRow) => ({
  id: r.id, login: r.login, displayName: r.display_name,
  role: { id: r.role_id, code: r.role_code, name: r.role_name, isExternal: r.role_external },
  team: r.team_id ? { id: r.team_id, code: r.team_code!, name: r.team_name! } : null,
  isExternal: r.is_external, orgRef: r.org_ref, status: r.status,
  joinedOn: day(r.joined_on), disabledAt: iso(r.disabled_at),
  disabledReason: r.disabled_reason, lastLoginAt: iso(r.last_login_at)
});

@Injectable()
export class IdentityService {
  constructor(private readonly audit: AuditService) {}

  async me() {
    const c = ctx(), p = principal();
    const { rows } = await c.client.query<AccountRow>(
      `SELECT ${ACCOUNT_COLS} FROM ${ACCOUNT_FROM} WHERE a.id = $1`, [p.accountId]);
    /* 一条查询把两个数一起数出来。原来是两条，而且第一条**把全部
       中心 id 取了回来**只为了拿它的行数 —— 那正是 visibleSiteIds
       那颗炸弹的引信：中心多了之后，这个请求既慢又大。 */
    const sc = siteScopeSql(p, "s");
    const { rows: agg } = await c.client.query<{ sites: string; studies: string }>(
      `SELECT count(*) AS sites, count(DISTINCT s.study_id) AS studies
         FROM study_site s WHERE ${sc.sql}`, sc.params);
    const nSites = Number(agg[0]!.sites), nStudies = Number(agg[0]!.studies);

    const label = p.rowRule === "all"
      ? `全公司 ${nStudies} 个项目 · ${nSites} 个中心`
      : p.rowRule === "none" ? "无数据范围"
      : `${nSites} 个中心 · ${nStudies} 个项目`;

    /* 自己那一行。RLS 已经把它限在本人 —— 这里不必再带 account_id 条件，
       但还是带上：策略是防线，条件是意图，两者说的是同一件事时才对得起读者。 */
    const { rows: pw } = await c.client.query<{ is_initial: boolean }>(
      `SELECT is_initial FROM auth_password WHERE account_id = $1`, [p.accountId]);

    return {
      account: toAccount(rows[0]!),
      scopeLabel: label,
      permissions: {
        rowRule: p.rowRule, fields: [...p.fields],
        actions: [...p.actions], modules: [...p.modules]
      },
      credentials: {
        hasPassword: pw.length > 0,
        passwordIsInitial: pw[0]?.is_initial ?? false
      }
    };
  }

  async listAccounts(q: { limit: number; cursor?: string; status?: string; roleCode?: string; q?: string }) {
    const c = ctx();
    const params: unknown[] = [];
    const conds: string[] = ["true"];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    if (q.status)   conds.push(`a.status = ${add(q.status)}`);
    if (q.roleCode) conds.push(`r.code = ${add(q.roleCode)}`);
    if (q.q)        conds.push(`(a.display_name ILIKE ${add("%" + q.q + "%")} OR a.login ILIKE $${params.length})`);
    if (q.cursor)   conds.push(`a.login > ${add(q.cursor)}`);
    const { rows } = await c.client.query<AccountRow>(
      `SELECT ${ACCOUNT_COLS} FROM ${ACCOUNT_FROM}
        WHERE ${conds.join(" AND ")} ORDER BY a.login LIMIT ${add(q.limit + 1)}`, params);
    const items = rows.slice(0, q.limit).map(toAccount);
    return { items, nextCursor: rows.length > q.limit ? items.at(-1)!.login : null };
  }

  async createAccount(b: {
    login: string; displayName: string; roleId: string;
    teamId?: string | null; orgRef?: string | null;
  }) {
    const c = ctx();
    const role = await c.client.query<{ is_external: boolean }>(
      `SELECT is_external FROM role WHERE id = $1`, [b.roleId]);
    if (!role.rows[0]) throw notFound("角色");
    try {
      const { rows } = await c.client.query<{ id: string }>(
        `INSERT INTO account (login, display_name, role_id, team_id, is_external, org_ref)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [b.login, b.displayName, b.roleId, b.teamId ?? null,
         role.rows[0].is_external, b.orgRef ?? null]);
      await this.audit.write({ action: "新增账号", targetType: "account", targetId: b.login,
        after: { login: b.login, displayName: b.displayName } });
      const out = await c.client.query<AccountRow>(
        `SELECT ${ACCOUNT_COLS} FROM ${ACCOUNT_FROM} WHERE a.id = $1`, [rows[0]!.id]);
      return toAccount(out.rows[0]!);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/account_scope_resolvable|org_ref/.test(msg))
        throw new ProblemException("invariant-violated", {
          detail: "该角色按「本院承接的项目」切行，必须填写 orgRef，否则账号能登录却一行数据都看不到",
          invariant: "row-scope-resolvable" });
      if (/duplicate key/.test(msg))
        throw new ProblemException("validation-failed", { detail: `登录名 ${b.login} 已存在` });
      throw e;
    }
  }

  async disableAccount(id: string, reason: string) {
    const c = ctx();
    const cur = await c.client.query<AccountRow>(
      `SELECT ${ACCOUNT_COLS} FROM ${ACCOUNT_FROM} WHERE a.id = $1`, [id]);
    const acc = cur.rows[0];
    if (!acc) throw notFound("账号");
    if (acc.id === principal().accountId)
      throw new ProblemException("validation-failed", { detail: "不能停用自己的账号" });

    /* 仍带着中心的人不能直接停用：那些中心会失去负责人而无人察觉 */
    const held = await c.client.query<{ code: string }>(
      `SELECT s.code FROM site_assignment sa JOIN study_site s ON s.id = sa.study_site_id
        WHERE sa.account_id = $1 AND sa.effective @> CURRENT_DATE ORDER BY s.code`, [id]);
    if (held.rowCount) {
      /* 已经有一笔待完成的交接单时，提示改为「去完成它」而不是「去发起」——
         否则用户会重复发起第二笔。 */
      const pend = await c.client.query<{ id: string }>(
        `SELECT id FROM handover WHERE from_account_id = $1 AND status = 'pending' LIMIT 1`, [id]);
      const open = pend.rows[0];
      throw new ProblemException("gate-not-satisfied", {
        detail: open
          ? `${acc.display_name} 仍负责 ${held.rowCount} 个中心，且已有一笔待完成的交接单（${open.id}）`
          : `${acc.display_name} 仍负责 ${held.rowCount} 个中心，请先发起交接`,
        unmet: held.rows.map(r => ({
          code: "site-still-assigned",
          message: open ? `${r.code} 的交接尚未完成` : `${r.code} 尚未交接`,
          module: "handover" })) });
    }

    await c.client.query(
      `UPDATE account SET status='disabled', disabled_at=now(), disabled_reason=$2 WHERE id=$1`,
      [id, reason]);
    await this.audit.write({ action: "停用账号", targetType: "account", targetId: acc.login,
      before: { status: "active" }, after: { status: "disabled" }, reason });
    const out = await c.client.query<AccountRow>(
      `SELECT ${ACCOUNT_COLS} FROM ${ACCOUNT_FROM} WHERE a.id = $1`, [id]);
    return {
      data: toAccount(out.rows[0]!),
      sideEffects: [{ type: "SiteStateChanged" as const,
        summary: `${acc.display_name} 的会话已全部失效`, ref: id }]
    };
  }

  /** 改账号的角色 / 分组 / 所属机构。**登录名与姓名不在这里改** ——
   *  登录名是审计轨迹里的那个标识，改掉等于把历史记录指向别人。 */
  async updateAccount(id: string, b: {
    roleId?: string; teamId?: string | null; orgRef?: string | null; reason: string;
  }) {
    const c = ctx();
    const cur = await c.client.query<AccountRow>(
      `SELECT ${ACCOUNT_COLS} FROM ${ACCOUNT_FROM} WHERE a.id = $1`, [id]);
    if (!cur.rows[0]) throw notFound("账号");
    const before = toAccount(cur.rows[0]);

    /* is_external 跟着角色走，不由调用方传：一个"外部账号 + 内部角色"的
       组合在库里是能存下的，而它的意思没有人说得清。 */
    let isExternal = before.isExternal;
    if (b.roleId) {
      const role = await c.client.query<{ is_external: boolean }>(
        `SELECT is_external FROM role WHERE id = $1`, [b.roleId]);
      if (!role.rows[0]) throw notFound("角色");
      isExternal = role.rows[0].is_external;
    }

    const sets: string[] = [], params: unknown[] = [id];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    if (b.roleId) { sets.push(`role_id = ${add(b.roleId)}`, `is_external = ${add(isExternal)}`); }
    if (b.teamId !== undefined) sets.push(`team_id = ${add(b.teamId)}`);
    if (b.orgRef !== undefined) sets.push(`org_ref = ${add(b.orgRef)}`);
    if (!sets.length) return before;

    try {
      await c.client.query(`UPDATE account SET ${sets.join(", ")} WHERE id = $1`, params);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      /* 触发器 account_scope_resolvable 拦下的那种：改成 hospital 规则的角色
         却没有 org_ref —— 人登得进来，一行数据都看不到，且没有任何提示。 */
      if (/account_scope_resolvable|org_ref/.test(msg))
        throw new ProblemException("invariant-violated", {
          detail: "该角色按「本院承接的项目」切行，必须同时给出 orgRef，" +
                  "否则这个账号登得进来却一行数据都看不到",
          invariant: "row-scope-resolvable" });
      throw e;
    }

    const out = await c.client.query<AccountRow>(
      `SELECT ${ACCOUNT_COLS} FROM ${ACCOUNT_FROM} WHERE a.id = $1`, [id]);
    const after = toAccount(out.rows[0]!);
    /* 改角色是权限变更 —— 「谁把谁调成了什么」是核查必查项。
       审计里带上前后两个角色，光记一个 account id 事后读不出发生了什么。 */
    await this.audit.write({
      action: b.roleId && b.roleId !== before.role.id ? "调整账号角色" : "调整账号归属",
      targetType: "account", targetId: before.login,
      before: { role: before.role.code, team: before.team?.code ?? null, orgRef: before.orgRef },
      after: { role: after.role.code, team: after.team?.code ?? null, orgRef: after.orgRef },
      reason: b.reason });
    return after;
  }

  /** 启用。**派工不会跟着回来** —— 见契约里那段说明。 */
  async enableAccount(id: string, reason: string) {
    const c = ctx();
    const cur = await c.client.query<AccountRow>(
      `SELECT ${ACCOUNT_COLS} FROM ${ACCOUNT_FROM} WHERE a.id = $1`, [id]);
    const acc = cur.rows[0];
    if (!acc) throw notFound("账号");
    if (acc.status === "active")
      return { data: toAccount(acc), sideEffects: [] as Effect[] };

    await c.client.query(
      `UPDATE account SET status='active', disabled_at=NULL, disabled_reason=NULL WHERE id=$1`,
      [id]);
    await this.audit.write({ action: "启用账号", targetType: "account", targetId: acc.login,
      before: { status: "disabled" }, after: { status: "active" }, reason });
    const out = await c.client.query<AccountRow>(
      `SELECT ${ACCOUNT_COLS} FROM ${ACCOUNT_FROM} WHERE a.id = $1`, [id]);
    const held = await c.client.query<{ n: string }>(
      `SELECT count(*) AS n FROM site_assignment
        WHERE account_id = $1 AND effective @> CURRENT_DATE`, [id]);
    return {
      data: toAccount(out.rows[0]!),
      sideEffects: [{
        type: "AccountEnabled",
        summary: Number(held.rows[0]!.n) === 0
          /* 说出来，因为这正是启用之后最容易被误以为已经恢复的那件事 */
          ? `${acc.display_name} 已恢复登录，但他名下目前没有中心 —— 停用时交接出去的不会自动回来`
          : `${acc.display_name} 已恢复登录，名下 ${held.rows[0]!.n} 个中心`,
        ref: id
      }] as Effect[]
    };
  }

  /** 管理员给别人设一个初始口令。**不能给自己设** —— 那绕过了验旧口令那道门。 */
  async setAccountPassword(id: string, password: string, reason: string) {
    const c = ctx();
    const bad = passwordProblem(password);
    if (bad) throw new ProblemException("validation-failed", { detail: bad });

    const cur = await c.client.query<AccountRow>(
      `SELECT ${ACCOUNT_COLS} FROM ${ACCOUNT_FROM} WHERE a.id = $1`, [id]);
    const acc = cur.rows[0];
    if (!acc) throw notFound("账号");
    if (acc.id === principal().accountId)
      throw new ProblemException("validation-failed", {
        detail: "改自己的口令请走「改口令」，那条要验当前口令 —— " +
                "从这里走等于绕过它，而会话被偷走时那道门是唯一的一道" });

    /* 标成初始口令：本人登录后顶上挂红条，改掉才消失，而且翻不回去。
       "管理员知道别人的口令"是个短期状态，这个标记是让它保持短期的唯一办法。 */
    await c.client.query(`SELECT app.set_password($1, $2, true)`,
      [id, await hashPassword(password)]);
    /* 换了口令，之前的会话一律作废：设初始口令的场景要么是新人入职，
       要么是账号出了事 —— 两种都不该让旧会话继续开着。

       **必须走 app.revoke_sessions**，不能直接 UPDATE：auth_session 的策略是
       「只看得到自己那些」，管理员那句 UPDATE 会匹配到 0 行而不报错 ——
       口令换了、旧会话还开着，而接口返回 204。见迁移 0027。 */
    await c.client.query(`SELECT app.revoke_sessions($1, $2)`,
      [id, "管理员重设了口令"]);
    /* **口令本身一个字都不进审计。** 记的是"谁给谁设过"，不是设成了什么。 */
    await this.audit.write({ action: "重设账号口令", targetType: "account",
      targetId: acc.login, after: { passwordIsInitial: true }, reason });
  }

  async listTeams() {
    const c = ctx();
    const { rows } = await c.client.query<{
      id: string; code: string; name: string;
      lead_id: string | null; lead_name: string | null;
      members: string; studies: string;
    }>(`SELECT t.id, t.code, t.name,
               l.id AS lead_id, l.display_name AS lead_name,
               (SELECT count(*) FROM account a WHERE a.team_id = t.id
                  AND a.status = 'active') AS members,
               (SELECT count(*) FROM team_study ts WHERE ts.team_id = t.id) AS studies
          FROM team t LEFT JOIN account l ON l.id = t.lead_account_id
         ORDER BY t.code`);
    return { items: rows.map(r => ({
      id: r.id, code: r.code, name: r.name,
      lead: r.lead_id ? { id: r.lead_id, displayName: r.lead_name! } : null,
      memberCount: Number(r.members), studyCount: Number(r.studies) })) };
  }

  async createTeam(b: { code: string; name: string; leadAccountId?: string | null }) {
    const c = ctx();
    try {
      const { rows } = await c.client.query<{ id: string }>(
        `INSERT INTO team (code, name, lead_account_id) VALUES ($1,$2,$3) RETURNING id`,
        [b.code, b.name, b.leadAccountId ?? null]);
      await this.audit.write({ action: "新建分组", targetType: "team", targetId: b.code,
        after: { code: b.code, name: b.name } });
      const one = (await this.listTeams()).items.find(t => t.id === rows[0]!.id)!;
      return one;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/duplicate key/.test(msg))
        throw new ProblemException("validation-failed", { detail: `分组代号 ${b.code} 已存在` });
      throw e;
    }
  }

  async listRoles() {
    const c = ctx();
    const { rows } = await c.client.query<{
      id: string; code: string; name: string; is_external: boolean; row_rule: string;
      fields: string[]; actions: string[]; modules: string[];
    }>(`SELECT r.id, r.code, r.name, r.is_external, r.row_rule,
          coalesce((SELECT array_agg(f.field_key) FROM role_field f
                     WHERE f.role_id=r.id AND f.visible),'{}') AS fields,
          coalesce((SELECT array_agg(x.action_key) FROM role_action x
                     WHERE x.role_id=r.id AND x.allowed),'{}') AS actions,
          coalesce((SELECT array_agg(m.module_key ORDER BY m.sort_order) FROM role_module m
                     WHERE m.role_id=r.id),'{}') AS modules
        FROM role r ORDER BY r.code`);
    return { items: rows.map(r => ({
      id: r.id, code: r.code, name: r.name, isExternal: r.is_external,
      rowRule: r.row_rule, visibleFields: r.fields,
      allowedActions: r.actions, modules: r.modules })) };
  }

  async updateRole(id: string, b: {
    rowRule?: string; visibleFields?: string[]; allowedActions?: string[];
    modules?: string[]; reason: string;
  }) {
    const c = ctx();
    const before = (await this.listRoles()).items.find(r => r.id === id);
    if (!before) throw notFound("角色");

    if (b.rowRule) await c.client.query(`UPDATE role SET row_rule=$2 WHERE id=$1`, [id, b.rowRule]);
    if (b.visibleFields) {
      await c.client.query(`UPDATE role_field SET visible=false WHERE role_id=$1`, [id]);
      for (const f of b.visibleFields)
        await c.client.query(
          `INSERT INTO role_field (role_id, field_key, visible) VALUES ($1,$2,true)
           ON CONFLICT (role_id, field_key) DO UPDATE SET visible=true`, [id, f]);
    }
    if (b.allowedActions) {
      await c.client.query(`UPDATE role_action SET allowed=false WHERE role_id=$1`, [id]);
      for (const a of b.allowedActions)
        await c.client.query(
          `INSERT INTO role_action (role_id, action_key, allowed) VALUES ($1,$2,true)
           ON CONFLICT (role_id, action_key) DO UPDATE SET allowed=true`, [id, a]);
    }
    if (b.modules) {
      await c.client.query(`DELETE FROM role_module WHERE role_id=$1`, [id]);
      for (const [i, m] of b.modules.entries())
        await c.client.query(
          `INSERT INTO role_module (role_id, module_key, sort_order) VALUES ($1,$2,$3)`, [id, m, i]);
    }
    const after = (await this.listRoles()).items.find(r => r.id === id)!;
    await this.audit.write({ action: "调整角色权限", targetType: "role", targetId: before.code,
      before, after, reason: b.reason });
    return after;
  }

  async listAudit(q: {
    limit: number; cursor?: string; studySiteId?: string; actorLogin?: string;
    targetType?: string; targetId?: string; sensitiveOnly?: boolean; since?: string;
  }) {
    const c = ctx();
    const params: unknown[] = [];
    const conds: string[] = ["true"];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    if (q.studySiteId)  conds.push(`e.study_site_id = ${add(q.studySiteId)}`);
    if (q.actorLogin)   conds.push(`e.actor_login = ${add(q.actorLogin)}`);
    if (q.targetType)   conds.push(`e.target_type = ${add(q.targetType)}`);
    if (q.targetId)     conds.push(`e.target_id = ${add(q.targetId)}`);
    if (q.sensitiveOnly) conds.push(`e.is_sensitive`);
    if (q.since)        conds.push(`e.at >= ${add(q.since)}`);
    if (q.cursor)       conds.push(`e.id < ${add(q.cursor)}`);
    const { rows } = await c.client.query<{
      id: string; at: Date; actor_account_id: string | null; actor_login: string;
      actor_role_code: string; action: string; target_type: string; target_id: string;
      before_value: unknown; after_value: unknown; study_site_id: string | null;
      reason: string | null; is_sensitive: boolean;
    }>(`SELECT * FROM audit_entry e WHERE ${conds.join(" AND ")}
         ORDER BY e.at DESC, e.id DESC LIMIT ${add(q.limit + 1)}`, params);
    const items = rows.slice(0, q.limit).map(r => ({
      id: r.id, at: r.at.toISOString(), actorLogin: r.actor_login,
      actorRoleCode: r.actor_role_code, action: r.action,
      targetType: r.target_type, targetId: r.target_id,
      before: r.before_value ?? null, after: r.after_value ?? null,
      studySiteId: r.study_site_id, reason: r.reason, isSensitive: r.is_sensitive
    }));
    return { items, nextCursor: rows.length > q.limit ? items.at(-1)!.id : null };
  }
}
