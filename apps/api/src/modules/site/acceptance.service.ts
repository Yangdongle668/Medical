import { Injectable } from "@nestjs/common";
import {
  isfVerdict, isfSummary, isfRank, CALC_VERSION, type IsfCategory
} from "@sitedesk/calc";
import { ctx, principal } from "../../infra/ctx.js";
import { ProblemException, notFound } from "../../infra/problem.js";
import { AuditService } from "../../infra/audit.service.js";

/* ════════════════════════════════════════════════════════════════════
   立项受理与中心文件（ISF）。

   ── 受理发生在建档之前 ────────────────────────────────────────────
   所以它挂的是 (study_id, hospital)，不是 study_site ——
   材料先递到医院，受理通过、伦理批下来、合同谈完，中心才进我方台账。
   study_site_id 建档之后回填；空着表示**受理了但中心还没进台账**，
   那正是「建档滞后」在医院这一侧的样子。

   ── ISF 的状态不存，只算 ──────────────────────────────────────────
   库里只有事实（在不在、什么时候到期、还剩几份）。
   存成枚举它会过期：六月标"齐备"的那一项，十月已经是缺项，
   而没有人会回去改 —— 一个存着过期状态的系统，连日历都算不上。
   ════════════════════════════════════════════════════════════════════ */

const day = (v: Date | null) => v ? v.toISOString().slice(0, 10) : null;
const todayStr = () => day(new Date())!;

interface AcRow {
  id: string; code: string; study_id: string; study_code: string;
  drug: string; sponsor_name: string; phase: string;
  hospital: string; study_site_id: string | null; site_code: string | null;
  submitted_by_name: string; submitted_on: Date;
  state: string; origin: string; amend_note: string | null;
  accepted_on: Date | null; accepted_by_name: string | null;
  docs: { seq: number; name: string; present: boolean }[];
}

/* **一个 join 都不内联到 study / client 上。**
   受理发生在建档之前 —— 那时候医院在我方台账里一个中心都没有，
   于是 study 按行策略对它不可见，client 对外部方干脆整个关闭。
   内联 join 过去，这张「给机构办看的表」会对机构办返回空列表：
   一张为对方存在的表，对方看不见。
   项目那几项事实抄在 site_acceptance 自己的列上（迁移 0038）。

   递交人与受理人走 LEFT JOIN + COALESCE：account 同样带行策略，
   而**看不见递交人的名字不该让整条受理消失** ——
   机构办要的是那份材料，不是我方的通讯录。 */
const AC_COLS = `
  a.id, a.code, a.study_id, a.study_code, a.drug, a.sponsor_name, a.phase,
  a.hospital, a.study_site_id, s.code AS site_code,
  COALESCE(sb.display_name, '（递交方）') AS submitted_by_name, a.submitted_on,
  a.state, a.origin, a.amend_note, a.accepted_on, ab.display_name AS accepted_by_name,
  COALESCE((
    SELECT json_agg(json_build_object('seq', d.seq, 'name', d.name, 'present', d.present)
             ORDER BY d.seq)
      FROM acceptance_doc d WHERE d.acceptance_id = a.id), '[]'::json) AS docs`;
const AC_FROM = `
  FROM site_acceptance a
  LEFT JOIN account sb ON sb.id = a.submitted_by
  LEFT JOIN account ab ON ab.id = a.accepted_by
  LEFT JOIN study_site s ON s.id = a.study_site_id`;

interface IsfRow {
  id: string; study_site_id: string; site_code: string; hospital: string;
  category: string; item: string; present: boolean;
  expires_on: Date | null; quantity: number | null; reorder_at: number | null;
  note: string | null; checked_on: Date | null; checked_by_name: string | null;
}
const ISF_COLS = `
  i.id, i.study_site_id, s.code AS site_code, s.hospital,
  i.category, i.item, i.present, i.expires_on, i.quantity, i.reorder_at,
  i.note, i.checked_on, cb.display_name AS checked_by_name`;
const ISF_FROM = `
  FROM isf_item i
  JOIN study_site s ON s.id = i.study_site_id
  LEFT JOIN account cb ON cb.id = i.checked_by`;

@Injectable()
export class AcceptanceService {
  constructor(private readonly audit: AuditService) {}

  private invariant(name: string, detail: string): never {
    throw new ProblemException("invariant-violated", { detail, invariant: name });
  }

  private acDto(r: AcRow) {
    const docs = r.docs.map(d => ({ seq: d.seq, name: d.name, present: d.present }));
    return {
      id: r.id, code: r.code,
      studyId: r.study_id, studyCode: r.study_code,
      drug: r.drug, sponsorName: r.sponsor_name, phase: r.phase,
      hospital: r.hospital,
      studySiteId: r.study_site_id, siteCode: r.site_code,
      submittedByName: r.submitted_by_name, submittedOn: day(r.submitted_on)!,
      state: r.state, origin: r.origin, amendNote: r.amend_note,
      acceptedOn: day(r.accepted_on), acceptedByName: r.accepted_by_name,
      docs,
      presentDocs: docs.filter(d => d.present).length,
      /* **缺的是哪几份 —— 名字，不是数目。** 补正通知要写的正是这几个名字。 */
      missingDocs: docs.filter(d => !d.present).map(d => d.name)
    };
  }

  async listAcceptances(q: {
    limit: number; cursor?: string; studyId?: string;
    state?: string[]; openOnly?: boolean; id?: string;
  }) {
    const c = ctx();
    const params: unknown[] = [];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const conds = ["true"];
    if (q.id) conds.push(`a.id = ${add(q.id)}`);
    if (q.studyId) conds.push(`a.study_id = ${add(q.studyId)}`);
    if (q.state?.length) conds.push(`a.state = ANY(${add(q.state)})`);
    if (q.openOnly) conds.push(`a.state <> 'accepted'`);
    if (q.cursor) conds.push(`a.id < ${add(q.cursor)}`);

    const { rows } = await c.client.query<AcRow>(
      `SELECT ${AC_COLS} ${AC_FROM}
        WHERE ${conds.join(" AND ")}
        ORDER BY a.submitted_on DESC, a.id DESC LIMIT ${add(q.limit + 1)}`, params);
    const pageRows = rows.slice(0, q.limit);
    return {
      items: pageRows.map(r => this.acDto(r)),
      nextCursor: rows.length > q.limit ? pageRows.at(-1)?.id ?? null : null
    };
  }

  private async oneAcceptance(id: string) {
    const c = ctx();
    const { rows } = await c.client.query<AcRow>(
      `SELECT ${AC_COLS} ${AC_FROM} WHERE a.id = $1`, [id]);
    if (!rows[0]) throw notFound("立项受理");
    return rows[0];
  }

  private async reloadAcceptance(id: string) {
    const one = await this.listAcceptances({ limit: 1, id });
    return one.items[0]!;
  }

  /** 受托方递交立项材料。
   *
   *  **没有这一步，irb_submit 闸门就是一堵墙** —— 新建档的中心永远递不出去，
   *  而 gate.ts 自己写着：一堵墙教会用户的是绕过它。
   *
   *  清单由请求带来。各医院要审的东西不一样（原型那两条就差着一项），
   *  写死在服务端等于替所有医院决定它们该查什么。 */
  async submit(b: { studyId: string; hospital: string; docs: string[] }) {
    const c = ctx();
    const p = principal();

    /* 同名两遍的清单，勾了一个另一个还缺着 —— 而它俩看起来一模一样。 */
    const dup = b.docs.find((d, i) => b.docs.indexOf(d) !== i);
    if (dup)
      this.invariant("acceptance-docs-duplicate",
        `材料清单里「${dup}」出现了两次 —— 勾了一个另一个还缺着，而它俩看起来一样`);

    const { rows: dupe } = await c.client.query<{ code: string; state: string }>(
      `SELECT code, state FROM site_acceptance WHERE study_id = $1 AND hospital = $2`,
      [b.studyId, b.hospital]);
    /* 一家医院在同一个项目上只有一次立项受理。补正重交仍是同一条 ——
       两条的话「这个中心受理号是多少」就有两个答案。 */
    if (dupe[0])
      this.invariant("acceptance-duplicate",
        `${b.hospital} 在这个项目上已经有受理记录 ${dupe[0].code} —— ` +
        `补正重交走的是同一条，不是新开一条`);

    /* 项目得看得见 —— 看不见的项目对本人而言不存在（404，不是 403）。
       项目的这几项事实同时抄到受理行上：递交之后医院要读的是那份材料，
       而它那时候对我方的 study 表还没有任何可见性。 */
    const { rows: st } = await c.client.query<{
      code: string; short_name: string; phase: string; sponsor_name: string;
    }>(`SELECT st.code, st.short_name, st.phase, cl.name AS sponsor_name
          FROM study st JOIN client cl ON cl.id = st.client_id
         WHERE st.id = $1`, [b.studyId]);
    if (!st[0]) throw notFound("项目");
    const study = st[0];

    const year = new Date().getFullYear();
    /* 编号取**当年已用到的最大号 + 1**，不是条数 + 1。
       受理号本来就是稀疏的（原型手上那两条是 038 与 041），
       按条数发号会撞上它们，而撞上之后报的是一句唯一约束。 */
    const { rows } = await c.client.query<{ id: string }>(
      `INSERT INTO site_acceptance (code, study_id, study_code, drug, sponsor_name,
                                    phase, hospital, submitted_by, origin)
       VALUES ('AC-' || $1 || '-' || lpad((
                 SELECT coalesce(max(substring(code from '[0-9]+$')::int), 0) + 1
                   FROM site_acceptance
                  WHERE tenant_id = app.current_tenant_id()
                    AND code LIKE 'AC-' || $1 || '-%')::text, 3, '0'),
               $2, $3, $4, $5, $6, $7, $8, 'in_system')
       RETURNING id`,
      [String(year), b.studyId, study.code, study.short_name, study.sponsor_name,
       study.phase, b.hospital, p.accountId]);
    const id = rows[0]!.id;

    /* **递进去一律未勾** —— 勾是机构办形式审查的动作，
       递交方自己勾完再递，形式审查就没有意义了。 */
    for (const [seq, name] of b.docs.entries())
      await c.client.query(
        `INSERT INTO acceptance_doc (acceptance_id, seq, name, present)
         VALUES ($1, $2, $3, false)`, [id, seq, name]);

    const dto = await this.reloadAcceptance(id);
    await this.audit.write({
      action: "递交立项材料", targetType: "site_acceptance", targetId: dto.code,
      after: { hospital: b.hospital, docs: b.docs.length },
      reason: `向 ${b.hospital} 机构办递交 ${b.docs.length} 项立项材料` });
    return dto;
  }

  /** 系统外登记的受理**不是一条待办**，是一条既成事实的存根。
   *  在它上面勾材料、发补正、再受理一次，都是在改一件已经发生过的事 ——
   *  而它的受理通知在几年前的医院里，本系统改不动。 */
  private refuseRegistered(a: AcRow, what: string): void {
    if (a.origin === "registered")
      this.invariant("acceptance-registered-readonly",
        `${a.code} 是系统外受理的登记存根（${day(a.accepted_on)} 已受理），` +
        `不能在这里${what} —— 它记的是一件已经发生过的事`);
  }

  async setDoc(id: string, seq: number, b: { present: boolean }) {
    const c = ctx();
    const a = await this.oneAcceptance(id);
    this.refuseRegistered(a, "勾材料清单");
    /* 受理通知发出去了，清单还能改，那张通知就不再对应任何一份材料。 */
    if (a.state === "accepted")
      this.invariant("acceptance-frozen",
        `${a.code} 已受理，材料清单不能再改 —— 受理通知已经发出去了`);
    const r = await c.client.query(
      `UPDATE acceptance_doc SET present = $3 WHERE acceptance_id = $1 AND seq = $2`,
      [id, seq, b.present]);
    if (!r.rowCount) throw notFound("立项材料");
    return { data: await this.reloadAcceptance(id), sideEffects: [] as never[] };
  }

  async accept(id: string) {
    const c = ctx();
    const p = principal();
    const a = await this.oneAcceptance(id);
    this.refuseRegistered(a, "再受理一次");
    if (a.state === "accepted")
      this.invariant("acceptance-already", `${a.code} 已经受理过了`);

    /* **材料不齐不予受理**，而且要列出缺的那几份的名字 ——
       一句"材料不齐"会让递交方把八份重寄一遍，而重寄之后缺的还是那两份。 */
    const missing = a.docs.filter(d => !d.present).map(d => d.name);
    if (missing.length)
      this.invariant("acceptance-docs-missing",
        `尚缺 ${missing.length} 项材料，不予受理：${missing.join("、")}`);

    await c.client.query(
      `UPDATE site_acceptance
          SET state = 'accepted', accepted_on = CURRENT_DATE, accepted_by = $2
        WHERE id = $1`, [id, p.accountId]);
    await this.audit.write({
      action: "予以受理", targetType: "site_acceptance", targetId: a.code,
      before: { state: a.state }, after: { state: "accepted" },
      reason: `${a.hospital} 立项材料齐备`,
      studySiteId: a.study_site_id ?? undefined });

    return {
      data: await this.reloadAcceptance(id),
      sideEffects: [{
        type: "SiteAccepted",
        summary: `${a.code} 已受理并转伦理审查 —— ` +
          (a.study_site_id
            ? "该中心现在可以推进到「伦理递交」"
            : "**该中心还没进台账** —— 受理了但没建档，成本已经在发生"),
        ref: id
      }]
    };
  }

  async requestAmend(id: string, b: { reason: string }) {
    const c = ctx();
    const a = await this.oneAcceptance(id);
    this.refuseRegistered(a, "发补正通知");
    if (a.state === "accepted")
      this.invariant("acceptance-already", `${a.code} 已经受理，不能再发补正通知`);
    await c.client.query(
      `UPDATE site_acceptance SET state = 'amend', amend_note = $2 WHERE id = $1`,
      [id, b.reason]);
    await this.audit.write({
      action: "发出补正通知", targetType: "site_acceptance", targetId: a.code,
      before: { state: a.state }, after: { state: "amend" }, reason: b.reason,
      studySiteId: a.study_site_id ?? undefined });

    const missing = a.docs.filter(d => !d.present).map(d => d.name);
    return {
      data: await this.reloadAcceptance(id),
      sideEffects: [{
        type: "AcceptanceAmendRequested",
        summary: `已向 ${a.submitted_by_name} 发出补正通知` +
          (missing.length ? `：${missing.join("、")}` : ""),
        ref: id
      }]
    };
  }

  /* ── 中心文件与物资 ────────────────────────────────────────── */

  private isfDto(r: IsfRow, today: string) {
    const v = isfVerdict({
      category: r.category as IsfCategory,
      present: r.present,
      expiresOn: day(r.expires_on),
      /* lead_days 由列上覆盖；空则用类别默认（在 calc 里）。 */
      leadDays: null,
      quantity: r.quantity, reorderAt: r.reorder_at
    }, today);
    return {
      id: r.id, studySiteId: r.study_site_id, siteCode: r.site_code,
      hospital: r.hospital, category: r.category, item: r.item,
      present: r.present, expiresOn: day(r.expires_on),
      quantity: r.quantity, reorderAt: r.reorder_at,
      note: r.note, checkedOn: day(r.checked_on), checkedByName: r.checked_by_name,
      ...v
    };
  }

  async isfBoard(q: { studySiteId?: string; category?: string[]; openOnly?: boolean }) {
    const c = ctx();
    const params: unknown[] = [];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const conds = ["true"];
    if (q.studySiteId) conds.push(`i.study_site_id = ${add(q.studySiteId)}`);
    if (q.category?.length) conds.push(`i.category = ANY(${add(q.category)})`);

    const { rows } = await c.client.query<IsfRow>(
      `SELECT ${ISF_COLS} ${ISF_FROM} WHERE ${conds.join(" AND ")}`, params);

    const today = todayStr();
    let items = rows.map(r => this.isfDto(r, today));
    /* 齐备率按**全部清单**算，不按筛过之后的 —— 只看不齐备的那一栏时，
       齐备率会变成 0%，而那个数字毫无意义。 */
    const summary = { ...isfSummary(items), calcVersion: CALC_VERSION };
    if (q.openOnly) items = items.filter(i => i.status !== "ok");
    /* 缺失与过期排最前，其次临期（越近越前），再次库存不足，齐备在最后。 */
    items.sort((a, b) => isfRank(a) - isfRank(b)
      || a.siteCode.localeCompare(b.siteCode)
      || a.item.localeCompare(b.item));
    return { items, summary };
  }

  async updateIsf(id: string, b: {
    present?: boolean; expiresOn?: string | null;
    quantity?: number | null; note?: string;
  }) {
    const c = ctx();
    const p = principal();
    const { rows } = await c.client.query<{
      id: string; item: string; study_site_id: string; present: boolean;
      expires_on: Date | null; quantity: number | null; reorder_at: number | null;
    }>(`SELECT id, item, study_site_id, present, expires_on, quantity, reorder_at
          FROM isf_item WHERE id = $1`, [id]);
    if (!rows[0]) throw notFound("中心文件");
    const old = rows[0];

    const present = b.present ?? old.present;
    const expiresOn = b.expiresOn !== undefined ? b.expiresOn : day(old.expires_on);
    /* 不在的东西没有到期日（库上的 CHECK 也拦）—— 在这里先说清楚，
       比让人看见一条约束名有用。 */
    if (!present && expiresOn)
      this.invariant("isf-missing-has-expiry",
        `${old.item} 标为缺失，就不该还有到期日 —— 先决定它到底在不在`);
    /* 只有库存没有补货线，「少到多少算少」没有答案。 */
    if (b.quantity != null && old.reorder_at === null)
      this.invariant("isf-stock-needs-reorder",
        `${old.item} 没有补货线 —— 填了库存也判不出够不够`);

    await c.client.query(
      `UPDATE isf_item
          SET present = $2, expires_on = $3, quantity = $4,
              note = COALESCE($5, note),
              checked_on = CURRENT_DATE, checked_by = $6
        WHERE id = $1`,
      [id, present, expiresOn, b.quantity !== undefined ? b.quantity : old.quantity,
       b.note ?? null, p.accountId]);

    await this.audit.write({
      action: "更新中心文件", targetType: "isf_item", targetId: old.item,
      before: { present: old.present, expiresOn: day(old.expires_on),
                quantity: old.quantity },
      after: { present, expiresOn, quantity: b.quantity ?? old.quantity },
      reason: b.note ?? `核对 ${old.item}`,
      studySiteId: old.study_site_id });

    return {
      data: await this.isfBoard({ studySiteId: old.study_site_id }),
      sideEffects: [] as never[]
    };
  }
}
