import { Injectable } from "@nestjs/common";
import {
  reviewBids, scopeCreep, changeDays, CALC_VERSION,
  type BidRecord, type ChangeRecord
} from "@sitedesk/calc";
import { CHANGE_KIND_LABEL } from "@sitedesk/contracts";
import { ctx, principal } from "../../infra/ctx.js";
import { ProblemException, notFound } from "../../infra/problem.js";
import { AuditService } from "../../infra/audit.service.js";

/* ════════════════════════════════════════════════════════════════════
   投标闭环 · 合同变更。

   服务层照旧只做三件事：取数、调 calc、写审计。**这里不出现算术。**

   两张表共用一条主线：没有回写就没有校准。
   报价不回写中标价，「按我们的人天该报多少」就是自说自话；
   变更不记下来，scope creep 只表现为毛利莫名其妙地薄了。
   ════════════════════════════════════════════════════════════════════ */

const day = (v: Date | null) => v ? v.toISOString().slice(0, 10) : null;
const n = (v: string | null) => v === null ? null : Number(v);

/** 丢掉值为 null 的键。**受列权限管辖的字段一律非 nullable** ——
 *  「没有值」和「没有权限」用同一种表达：字段不出现。
 *  （与 cost.service.ts 里的同名函数同一条理由。） */
const omitNull = <T extends Record<string, unknown>>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null)) as Partial<T>;

interface BidRow {
  id: string; code: string; sponsor: string; name: string;
  submitted_on: Date; sites: number; subjects: number;
  our_quote_cents: string; our_person_days: string;
  status: string; decided_on: Date | null;
  winning_price_cents: string | null;
  owner_name: string | null; note: string | null;
}
const BID_COLS = `
  b.id, b.code, b.sponsor, b.name, b.submitted_on, b.sites, b.subjects,
  b.our_quote_cents, b.our_person_days, b.status, b.decided_on,
  b.winning_price_cents, a.display_name AS owner_name, b.note`;
const BID_FROM = `FROM bid b LEFT JOIN account a ON a.id = b.owner_account_id`;

function bidDto(r: BidRow) {
  const quote = Number(r.our_quote_cents);
  const win = n(r.winning_price_cents);
  const personDays = Number(r.our_person_days);
  return {
    id: r.id, code: r.code, sponsor: r.sponsor, name: r.name,
    submittedOn: day(r.submitted_on)!, sites: r.sites, subjects: r.subjects,
    ourQuoteCents: quote, ourPersonDays: personDays,
    daysPerSubject: r.subjects > 0 ? personDays / r.subjects : 0,
    status: r.status, decidedOn: day(r.decided_on),
    /* 成交价未知时**这个键不出现**（不是 null）—— 见上面 omitNull 的注释。 */
    ...omitNull({ winningPriceCents: win }),
    /* gap 不受列权限管辖：它是**比例**，不含金额。
       拿不到价格的人看得到"我们比成交价高 30%"，看不到高了多少钱 ——
       那一条对他有用，而且不泄漏任何绝对数。
       成交价未知时是 null，**不是 0** —— 见 calc 里的同一条注释。 */
    gap: win !== null && win > 0 ? (quote - win) / win : null,
    ownerName: r.owner_name, note: r.note
  };
}
const bidRecord = (r: BidRow): BidRecord => ({
  status: r.status as BidRecord["status"],
  ourQuoteCents: Number(r.our_quote_cents),
  ourPersonDays: Number(r.our_person_days),
  subjects: r.subjects,
  winningPriceCents: n(r.winning_price_cents)
});

interface ChangeRow {
  id: string; code: string;
  study_id: string; study_code: string; study_short: string;
  study_site_id: string | null; site_code: string | null;
  kind: string; raised_on: Date; raised_by_name: string | null;
  what: string; person_days_impact: string; per_subject: boolean;
  amount_cents: string | null; status: string; decided_on: Date | null;
  note: string | null;
  /* 受影响的入组例数：**每次算，不存**。一条「每例多 1.5 人天」的变更
     真正可怕的地方是入组越多白做的越多 —— 存一个数会把它冻在提出那天。 */
  affected_subjects: string;
}
const CHANGE_COLS = `
  c.id, c.code, c.study_id, st.code AS study_code, st.short_name AS study_short,
  c.study_site_id, ss.code AS site_code, c.kind, c.raised_on,
  a.display_name AS raised_by_name, c.what, c.person_days_impact, c.per_subject,
  c.amount_cents, c.status, c.decided_on, c.note,
  (SELECT count(*) FROM subject sj
    WHERE sj.state IN ('enrolled','completed','withdrawn')
      AND (c.study_site_id IS NOT NULL
             AND sj.study_site_id = c.study_site_id
           OR c.study_site_id IS NULL
             AND sj.study_site_id IN (
               SELECT s2.id FROM study_site s2 WHERE s2.study_id = c.study_id))
  ) AS affected_subjects`;
const CHANGE_FROM = `
  FROM contract_change c
  JOIN study st ON st.id = c.study_id
  LEFT JOIN study_site ss ON ss.id = c.study_site_id
  LEFT JOIN account a ON a.id = c.raised_by`;

const changeRecord = (r: ChangeRow): ChangeRecord => ({
  status: r.status as ChangeRecord["status"],
  personDaysImpact: Number(r.person_days_impact),
  perSubject: r.per_subject,
  affectedSubjects: Number(r.affected_subjects),
  amountCents: n(r.amount_cents)
});

@Injectable()
export class BidService {
  constructor(private readonly audit: AuditService) {}

  /** 今天现行的 CRC 人天成本 —— scope creep 折成钱要用它。
   *  **走 `app.rate_on`，不写常量**：调价之后未覆盖工作量的金额要跟着变，
   *  否则那个数会永远停在某一年的费率上。 */
  private async crcDayCost(): Promise<number> {
    const c = ctx();
    const { rows } = await c.client.query<{ day_cost_cents: string }>(
      `SELECT day_cost_cents FROM app.rate_on('CRC', NULL, CURRENT_DATE)`);
    return rows[0] ? Number(rows[0].day_cost_cents) : 0;
  }

  /* ── 投标 ─────────────────────────────────────────────────────── */

  async listBids(q: {
    limit: number; cursor?: string; status?: string[]; sponsor?: string;
  }) {
    const c = ctx();
    const params: unknown[] = [];
    const conds = ["true"];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    if (q.status?.length) conds.push(`b.status = ANY(${add(q.status)}::text[])`);
    if (q.sponsor) conds.push(`b.sponsor ILIKE ${add(`%${q.sponsor}%`)}`);
    if (q.cursor) conds.push(`b.code < ${add(q.cursor)}`);

    const { rows } = await c.client.query<BidRow>(
      `SELECT ${BID_COLS} ${BID_FROM}
        WHERE ${conds.join(" AND ")}
        ORDER BY b.code DESC LIMIT ${add(q.limit + 1)}`, params);
    const items = rows.slice(0, q.limit).map(bidDto);
    return {
      items, nextCursor: rows.length > q.limit ? items.at(-1)?.code ?? null : null
    };
  }

  async bidReview() {
    const c = ctx();
    const { rows } = await c.client.query<BidRow>(`SELECT ${BID_COLS} ${BID_FROM}`);
    return { ...reviewBids(rows.map(bidRecord)), calcVersion: CALC_VERSION };
  }

  private async oneBid(id: string) {
    const c = ctx();
    const { rows } = await c.client.query<BidRow>(
      `SELECT ${BID_COLS} ${BID_FROM} WHERE b.id = $1`, [id]);
    if (!rows[0]) throw notFound("投标");
    return rows[0];
  }

  async createBid(b: {
    sponsor: string; name: string; submittedOn: string;
    sites: number; subjects: number;
    ourQuoteCents: number; ourPersonDays: number; note?: string;
  }) {
    const c = ctx();
    const p = principal();
    const year = b.submittedOn.slice(0, 4);
    /* 编号在**库里**数，不在应用里数：应用里"读一次 count 再加一"要两个
       往返，中间隔着整个网络延迟。放进一条 INSERT 之后窗口收窄到一条语句。

       **但它不是完全无竞态的** —— 两个并发事务仍可能读到同一个 count。
       真正挡住重号的是 `UNIQUE (tenant_id, code)`：撞上了是一次插入被拒，
       不是两条一样的编号。这个取舍是有意的：重号的代价是台账对不上，
       而偶尔一次"请重试"是可以接受的。要彻底消掉竞态得按年开序列，
       而那会在跨年时带来另一类麻烦。 */
    const { rows } = await c.client.query<{ id: string }>(
      `INSERT INTO bid (code, sponsor, name, submitted_on, sites, subjects,
                        our_quote_cents, our_person_days, owner_account_id, note)
       VALUES ('B-' || $1 || '-' || lpad((
                 SELECT count(*) + 1 FROM bid
                  WHERE tenant_id = app.current_tenant_id()
                    AND code LIKE 'B-' || $1 || '-%')::text, 2, '0'),
               $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [year, b.sponsor, b.name, b.submittedOn, b.sites, b.subjects,
       b.ourQuoteCents, b.ourPersonDays, p.accountId, b.note ?? null]);

    const dto = bidDto(await this.oneBid(rows[0]!.id));
    await this.audit.write({
      action: "登记投标", targetType: "bid", targetId: dto.code,
      after: { sponsor: dto.sponsor, quoteCents: dto.ourQuoteCents }, reason: null });
    return dto;
  }

  async decideBid(id: string, b: {
    result: "won" | "lost"; winningPriceCents?: number | null; note?: string;
  }) {
    const c = ctx();
    const before = await this.oneBid(id);
    if (before.status !== "pending")
      throw new ProblemException("invariant-violated", {
        detail: `${before.code} 已经出过结果了（${before.status === "won" ? "中标" : "失标"}）` });

    const win = b.winningPriceCents ?? null;
    /* **中标必须知道自己签了多少** —— 那个数就在合同上。
       失标可以不知道对方的价：问不到是常态，
       而「不知道」不能记成「和我们一样」。 */
    if (b.result === "won" && win === null)
      throw new ProblemException("invariant-violated", {
        detail: "中标必须填成交价 —— 那个数就在合同上。" +
          "不填的话，这一标就永远进不了报价偏差统计" });

    await c.client.query(
      `UPDATE bid SET status = $2, decided_on = CURRENT_DATE,
              winning_price_cents = $3,
              note = coalesce($4, note)
        WHERE id = $1`, [id, b.result, win, b.note ?? null]);

    await this.audit.write({
      action: b.result === "won" ? "投标中标" : "投标失标",
      targetType: "bid", targetId: before.code,
      before: { status: before.status },
      after: { status: b.result, winningPriceCents: win },
      reason: b.note ?? null });

    const data = bidDto(await this.oneBid(id));
    const sideEffects: { type: "BidDecided"; summary: string; ref?: string }[] = [];
    if (data.gap !== null && Math.abs(data.gap) >= 0.15)
      sideEffects.push({
        type: "BidDecided",
        summary: data.gap > 0
          ? `我们比成交价高 ${(data.gap * 100).toFixed(0)}% —— ` +
            "去「报价偏差复盘」看看是不是系统性的，而不是这一标特殊"
          : `我们比成交价低 ${(-data.gap * 100).toFixed(0)}% —— ` +
            "报低了同样要查：可能漏算了筛败或驻场 FTE",
        ref: data.id
      });
    else if (b.result === "lost" && win === null)
      sideEffects.push({
        type: "BidDecided",
        summary: "没有成交价，这一标不进偏差统计 —— " +
          "「不知道对方报了多少」不会被当成「和我们一样」",
        ref: data.id
      });
    return { data, sideEffects };
  }

  /* ── 合同变更 ─────────────────────────────────────────────────── */

  private changeDto(r: ChangeRow, crcDay: number) {
    const rec = changeRecord(r);
    const total = changeDays(rec);
    return {
      id: r.id, code: r.code,
      study: { id: r.study_id, code: r.study_code, shortName: r.study_short },
      studySiteId: r.study_site_id, siteCode: r.site_code,
      kind: r.kind,
      kindLabel: CHANGE_KIND_LABEL[r.kind as keyof typeof CHANGE_KIND_LABEL] ?? r.kind,
      raisedOn: day(r.raised_on)!, raisedByName: r.raised_by_name,
      what: r.what,
      personDaysImpact: Number(r.person_days_impact),
      perSubject: r.per_subject,
      affectedSubjects: Number(r.affected_subjects),
      totalPersonDays: total,
      /* 已签署的不算白做 —— 哪怕金额是 0：那是谈过之后的决定。
         两个金额字段都走 omitNull：受列权限管辖的键不能是 null。 */
      ...omitNull({
        uncoveredCents: r.status === "signed" ? null : Math.round(total * crcDay),
        settledCents: n(r.amount_cents)
      }),
      status: r.status, decidedOn: day(r.decided_on), note: r.note
    };
  }

  async listChanges(q: {
    limit: number; cursor?: string; studyId?: string; studySiteId?: string;
    status?: string[]; uncoveredOnly?: boolean;
  }) {
    const c = ctx();
    const params: unknown[] = [];
    const conds = ["true"];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    if (q.studyId) conds.push(`c.study_id = ${add(q.studyId)}`);
    if (q.studySiteId) conds.push(`c.study_site_id = ${add(q.studySiteId)}`);
    if (q.status?.length) conds.push(`c.status = ANY(${add(q.status)}::text[])`);
    /* 「没有对应金额」= 没签署。三种都算：还没提、提了没签、明确不给钱。 */
    if (q.uncoveredOnly) conds.push(`c.status <> 'signed'`);
    if (q.cursor) conds.push(`c.code < ${add(q.cursor)}`);

    const [{ rows }, crcDay] = await Promise.all([
      c.client.query<ChangeRow>(
        `SELECT ${CHANGE_COLS} ${CHANGE_FROM}
          WHERE ${conds.join(" AND ")}
          ORDER BY c.code DESC LIMIT ${add(q.limit + 1)}`, params),
      this.crcDayCost()
    ]);
    const items = rows.slice(0, q.limit).map(r => this.changeDto(r, crcDay));
    return {
      items, nextCursor: rows.length > q.limit ? items.at(-1)?.code ?? null : null
    };
  }

  async scopeCreep() {
    const c = ctx();
    const [{ rows }, crcDay] = await Promise.all([
      c.client.query<ChangeRow>(`SELECT ${CHANGE_COLS} ${CHANGE_FROM}`),
      this.crcDayCost()
    ]);
    return {
      ...scopeCreep(rows.map(changeRecord), crcDay),
      calcVersion: CALC_VERSION
    };
  }

  private async oneChange(id: string) {
    const c = ctx();
    const { rows } = await c.client.query<ChangeRow>(
      `SELECT ${CHANGE_COLS} ${CHANGE_FROM} WHERE c.id = $1`, [id]);
    if (!rows[0]) throw notFound("变更单");
    return rows[0];
  }

  async createChange(b: {
    studyId: string; studySiteId?: string | null; kind: string;
    raisedOn: string; what: string; personDaysImpact: number;
    perSubject: boolean; note?: string;
  }) {
    const c = ctx();
    const p = principal();
    /* 中心必须属于这个项目。**跨表校验，库里拦不住**，所以在这里。
       不校验的话，一条挂错项目的变更会被算进另一个项目的 scope creep，
       而那个数正是用来跟申办方谈钱的。 */
    if (b.studySiteId) {
      const ok = await c.client.query(
        `SELECT 1 FROM study_site WHERE id = $1 AND study_id = $2`,
        [b.studySiteId, b.studyId]);
      if (!ok.rowCount) throw new ProblemException("invariant-violated", {
        detail: "这个中心不属于该项目 —— 变更单挂错项目会算进别人的未覆盖工作量" });
    }
    const year = b.raisedOn.slice(0, 4);
    const { rows } = await c.client.query<{ id: string }>(
      `INSERT INTO contract_change (
         code, study_id, study_site_id, kind, raised_on, raised_by, what,
         person_days_impact, per_subject, note)
       VALUES ('CR-' || $1 || '-' || lpad((
                 SELECT count(*) + 1 FROM contract_change
                  WHERE tenant_id = app.current_tenant_id()
                    AND code LIKE 'CR-' || $1 || '-%')::text, 3, '0'),
               $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [year, b.studyId, b.studySiteId ?? null, b.kind, b.raisedOn, p.accountId,
       b.what, b.personDaysImpact, b.perSubject, b.note ?? null]);

    const crcDay = await this.crcDayCost();
    const dto = this.changeDto(await this.oneChange(rows[0]!.id), crcDay);
    await this.audit.write({
      action: "登记合同变更", targetType: "contract_change", targetId: dto.code,
      after: { kind: dto.kindLabel, personDays: dto.totalPersonDays },
      studySiteId: dto.studySiteId ?? undefined, reason: null });
    return dto;
  }

  async settleChange(id: string, b: {
    status: "submitted" | "signed" | "rejected";
    settledCents?: number | null; note?: string;
  }) {
    const c = ctx();
    const before = await this.oneChange(id);
    if (before.status === "signed" || before.status === "rejected")
      throw new ProblemException("invariant-violated", {
        detail: `${before.code} 已经了结了（${before.status === "signed" ? "已签署" : "未获批"}）` });
    if (b.status === "submitted" && before.status !== "draft")
      throw new ProblemException("invariant-violated", {
        detail: `${before.code} 已经提交过了` });

    /* **签署必须填金额，哪怕是 0。**
       0 是「谈过了，对方不给钱，我们认了」，不填是「还没谈」——
       前者是决策，后者是欠账，而只有后者该出现在未覆盖工作量里。 */
    const amount = b.settledCents ?? null;
    if (b.status === "signed" && amount === null)
      throw new ProblemException("invariant-violated", {
        detail: "签署必须填金额，哪怕是 0 —— " +
          "0 表示「谈过了，对方不给钱」，不填表示「还没谈」，两者差别极大" });

    await c.client.query(
      `UPDATE contract_change
          SET status = $2,
              decided_on = CASE WHEN $2 IN ('signed','rejected')
                                THEN CURRENT_DATE ELSE NULL END,
              amount_cents = CASE WHEN $2 = 'signed' THEN $3 ELSE amount_cents END,
              note = coalesce($4, note)
        WHERE id = $1`, [id, b.status, amount, b.note ?? null]);

    await this.audit.write({
      action: `变更单转为「${LABEL[b.status]}」`,
      targetType: "contract_change", targetId: before.code,
      before: { status: before.status },
      after: { status: b.status, settledCents: amount },
      studySiteId: before.study_site_id ?? undefined,
      reason: b.note ?? null });

    const crcDay = await this.crcDayCost();
    const data = this.changeDto(await this.oneChange(id), crcDay);
    /* 未获批要当场把「白做多少」说出来 —— 它是下次报价该加进去的成本，
       而事后没人会去翻这张台账。 */
    const sideEffects = b.status === "rejected"
      ? [{
          type: "ScopeCreepRecorded" as const,
          summary: `${data.kindLabel}未获批 —— ` +
            `${data.totalPersonDays.toFixed(1)} 人天没有对应金额。` +
            "下次报价时这就是该加进去的成本",
          ref: data.id,
          /* 已签署的那一支没有这个键（走了 omitNull），
             所以判的是 undefined 而不是 null。 */
          ...(typeof data.uncoveredCents === "number"
            ? { amountCents: Math.abs(data.uncoveredCents) } : {})
        }]
      : [];
    return { data, sideEffects };
  }
}

const LABEL: Record<string, string> = {
  submitted: "已提交", signed: "已签署", rejected: "未获批"
};
