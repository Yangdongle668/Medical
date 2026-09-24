import { Injectable } from "@nestjs/common";
import {
  isfVerdict, isfSummary, isfRank, CALC_VERSION, type IsfCategory
} from "@sitedesk/calc";
import { ctx, principal } from "../../infra/ctx.js";
import { ProblemException, notFound } from "../../infra/problem.js";
import { AuditService } from "../../infra/audit.service.js";
import { nextCode } from "../../infra/code.js";
import { keysetCond, keysetCol, keysetNext, type Keyset } from "../../infra/keyset.js";
import { todayLocal } from "../../infra/clock.js";

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
const todayStr = () => todayLocal();   // 业务时区的今天（infra/clock.ts）—— 不是服务器的 UTC 今天

interface AcRow {
  id: string; code: string; study_id: string; study_code: string;
  drug: string; sponsor_name: string; phase: string;
  hospital: string; study_site_id: string | null; site_code: string | null;
  submitted_by_name: string; submitted_on: Date;
  state: string; origin: string; amend_note: string | null;
  accepted_on: Date | null; accepted_by_name: string | null;
  docs: { seq: number; name: string; present: boolean }[];
  /** 意向函的元信息。**永远不带 bytes** —— 台账是逐页翻的，
   *  而那份 PDF 只在有人点开时才要（内容走 getLetter 那条端点）。 */
  letter: { filename: string; contentType: string; sizeBytes: number;
            uploadedAt: string; uploadedByName: string } | null;
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
      FROM acceptance_doc d WHERE d.acceptance_id = a.id), '[]'::json) AS docs,
  /* 意向函**只取元信息**：filename / 大小 / 谁传的。
     bytes 那一列一个字节都不进这条查询 —— 受理台账一页二十行，
     每行捎上几百 KB 的 PDF，那一次请求就废了。
     （注释里不写反引号 —— 它会把这个模板字符串就地截断。） */
  (SELECT json_build_object(
            'filename', l.filename, 'contentType', l.content_type,
            'sizeBytes', l.size_bytes, 'uploadedAt', l.uploaded_at,
            'uploadedByName', COALESCE(ub.display_name, '（本方）'))
     FROM acceptance_letter l
     LEFT JOIN account ub ON ub.id = l.uploaded_by
    WHERE l.acceptance_id = a.id) AS letter`;
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

/** 立项受理：递交日新的在前，同日 id 降序。 */
const ACCEPTANCE_KEYSET: Keyset = { key: "a.submitted_on", type: "date", dir: "desc", idDir: "desc", id: "a.id" };

@Injectable()
export class AcceptanceService {
  constructor(private readonly audit: AuditService) {}

  private invariant(name: string, detail: string): never {
    throw new ProblemException("invariant-violated", { detail, invariant: name });
  }

  /** 「今天」**问库要**，不在 JS 里从 UTC 的此刻切。
   *
   *  `new Date().toISOString().slice(0,10)` 给的是 UTC 那一天，而落库用的是
   *  `CURRENT_DATE`（库会话的时区）。两者在东八区每天早上差着八个小时 ——
   *  七点上工的 CRC 填今天的日期递交，会被判成「在将来」而拒掉，
   *  而报错说的是一件他看着明明没做错的事。
   *
   *  前端那一侧有一条守卫盯着同一件事（apps/web/test/dates.test.ts），
   *  服务端这一侧靠的是"跟落库用的是同一个源"。 */
  private async today(): Promise<string> {
    const { rows } = await ctx().client.query<{ d: string }>(
      "SELECT CURRENT_DATE::text AS d");
    return rows[0]!.d;
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
      letter: r.letter,
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
    if (q.cursor) conds.push(keysetCond(ACCEPTANCE_KEYSET, q.cursor, add));

    const { rows } = await c.client.query<AcRow & { cursor_key: string }>(
      `SELECT ${keysetCol(ACCEPTANCE_KEYSET)}, ${AC_COLS} ${AC_FROM}
        WHERE ${conds.join(" AND ")}
        ORDER BY a.submitted_on DESC, a.id DESC LIMIT ${add(q.limit + 1)}`, params);
    const pageRows = rows.slice(0, q.limit);
    return {
      items: pageRows.map(r => this.acDto(r)),
      nextCursor: keysetNext(rows, q.limit)
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
  async submit(b: {
    studyId: string; hospital: string; docs?: string[]; submittedOn?: string;
    acceptedOn?: string; letter?: { filename: string; contentBase64: string };
  }) {
    const c = ctx();
    const p = principal();
    const docs = b.docs ?? [];

    /* 递交日期收得下**过去**，收不下将来。一线常常是过两天才回系统里补登，
       默认成今天的话「递交日期」这一栏就成了「登记日期」——
       而那几天差额恰恰是伦理排期要算的。 */
    const today = await this.today();
    const submittedOn = b.submittedOn ?? today;
    if (submittedOn > today)
      throw new ProblemException("validation-failed", {
        detail: `递交日期 ${submittedOn} 在将来 —— 这一栏记的是「哪天递出去的」，` +
          "还没递的不用先登记"
      });

    /* ── 一步填完的那一支 ────────────────────────────────────────────
       给了受理日期，这条受理**建出来就是已受理的** —— 不经过
       「形式审查中」，也不等机构办在本系统里点任何东西。
       院方的机构办不是这套系统的用户，一线手里拿着的就是那张意见函。 */
    if (b.acceptedOn) {
      if (b.acceptedOn > today)
        throw new ProblemException("validation-failed", {
          detail: `收到受理意见函的日期 ${b.acceptedOn} 在将来 —— ` +
            "这一栏记的是「哪天拿到的」，还没拿到的留空就行"
        });
      if (b.acceptedOn < submittedOn)
        this.invariant("acceptance-letter-before-submit",
          `收到日期 ${b.acceptedOn} 早于递交日期 ${submittedOn} —— ` +
          "受理意见函不会比材料先到");
    }
    /* 没有日期的一份 PDF，台账上挂在哪一行都说不清。 */
    if (b.letter && !b.acceptedOn)
      throw new ProblemException("validation-failed", {
        detail: "传了受理意见函却没填收到日期 —— 两样要一起给；" +
          "纸还没到手就两样都留空，拿到之后回来补登"
      });
    /* 先解一遍，**在 INSERT 之前** —— 文件不合格时这条受理不该被建出来。 */
    const bytes = AcceptanceService.readLetter(b.letter);

    /* 同名两遍的清单，勾了一个另一个还缺着 —— 而它俩看起来一模一样。 */
    const dup = docs.find((d, i) => docs.indexOf(d) !== i);
    if (dup)
      this.invariant("acceptance-docs-duplicate",
        `材料清单里「${dup}」出现了两次 —— 勾了一个另一个还缺着，而它俩看起来一样`);

    /* 一家医院在同一个项目上只有一次立项受理（迁移 0038 的唯一约束）。
       补正重交仍是同一条 —— 两条的话「这个中心受理号是多少」就有两个答案。

       ── 这句查询**不能带行策略** ────────────────────────────────────
       原来它是一句普通的 SELECT，于是行规则为 `assigned` 的 CRA / CRC
       看不见别人递的那一条（那时 study_site_id 还是空的，
       app.site_visible 判不出来）—— pre-check 查回 0 行、一路放行，
       最后撞在唯一约束上，而 pg 的 23505 落到兜底分支就是 **500**。

       一句"服务内部错误"教会用户的是重试，而重试一万次结果都一样。
       `app.acceptance_for`（迁移 0049）只回答这一个问题：
       这个(项目, 医院)上有没有、编号多少、谁递的。 */
    const { rows: dupe } = await c.client.query<{
      code: string; submitted_by_name: string; submitted_on: Date;
    }>("SELECT * FROM app.acceptance_for($1, $2)", [b.studyId, b.hospital]);
    if (dupe[0])
      this.invariant("acceptance-duplicate",
        `${b.hospital} 在这个项目上已经有一条受理记录：${dupe[0].code}` +
        `（${dupe[0].submitted_by_name} 于 ${day(dupe[0].submitted_on)} 递交）。\n` +
        "补正重交走的是同一条，不是新开一条 —— " +
        "这条记录可能不在你的可见范围里（受理是在建档之前发生的，" +
        "那时还没有中心可以按派工切行），所以你在受理台账上看不到它。" +
        "要跟进它，找递交人或项目总监。");

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

    /* 编号由 app.next_code 发（迁移 0043）。这里原来自己拼 ——
       它是全仓库唯一一处**取对了**的（max + 1，因为受理号本来就稀疏：
       演示数据里那两条是 038 与 041），而另外三处仍在按条数发号。
       一处知道、别处不知道，正是编号该由一个函数统一发的理由。
       顺带修掉它剩下的那半个问题：那句 max 是在 RLS 下数的。 */
    const { rows } = await c.client.query<{ id: string }>(
      `INSERT INTO site_acceptance (code, study_id, study_code, drug, sponsor_name,
                                    phase, hospital, submitted_by, origin, submitted_on,
                                    state, accepted_on)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'in_system', $9::date, $10, $11::date)
       RETURNING id`,
      [await nextCode("acceptance"), b.studyId, study.code, study.short_name,
       study.sponsor_name, study.phase, b.hospital, p.accountId,
       submittedOn, b.acceptedOn ? "accepted" : "review", b.acceptedOn ?? null]);
    const id = rows[0]!.id;

    /* **递进去一律未勾** —— 勾是机构办形式审查的动作，
       递交方自己勾完再递，形式审查就没有意义了。 */
    for (const [seq, name] of docs.entries())
      await c.client.query(
        `INSERT INTO acceptance_doc (acceptance_id, seq, name, present)
         VALUES ($1, $2, $3, false)`, [id, seq, name]);

    if (bytes) await this.putLetter(id, b.letter!.filename, bytes);

    const dto = await this.reloadAcceptance(id);
    await this.audit.write({
      action: b.acceptedOn ? "登记立项递交与受理" : "登记立项材料递交",
      targetType: "site_acceptance", targetId: dto.code,
      after: { hospital: b.hospital, docs: docs.length, submittedOn,
               ...(b.acceptedOn ? { acceptedOn: b.acceptedOn, letter: !!bytes } : {}) },
      /* 清单为空是正常的 —— 多数医院的机构办不在本系统里，
         那张清单没有第二个人来勾（见迁移 0048）。审计里照实说。 */
      reason: b.acceptedOn
        ? `${submittedOn} 向 ${b.hospital} 递交立项材料，${b.acceptedOn} 收到受理意见函` +
          (bytes ? "（扫描件已上传）" : "（扫描件待补）")
        : `${submittedOn} 向 ${b.hospital} 递交立项材料，受理意见函待登记` });
    return dto;
  }

  /* ── 一线的第二个日期：拿到立项受理意向函 ────────────────────────
     `acceptSite` 是**机构办在本系统里点下「予以受理」**那条路。
     多数医院的机构办不在这个系统里（迁移 0038 自己写着这句话），
     于是那条路空着，而一线手里已经拿着那张纸了。

     这一条就是那张纸落库的地方：一个日期 + 一份 PDF。
     **受理人不必填** —— 医院那边是谁受理的，由那份意向函回答；
     填一个下拉框里挑出来的名字是编的（迁移 0048 为此放松了约束）。
     谁在系统里登记的，进审计轨迹 —— 那两件事本来就不该混。 */

  /** PDF 的上限。契约里也写着，这里是第二道 —— 两处都在，
   *  才防得住"有人绕过前端直接打接口"。库里还有第三道（CHECK）。 */
  private static readonly LETTER_MAX = 10 * 1024 * 1024;

  /** 把传上来的 base64 解成字节，并把三道判定走一遍。
   *
   *  **递交（一步填完）与补登共用这一个** —— 两处各写一份，
   *  "多大算大""认不认扩展名"迟早会有两个答案，而分叉的那天
   *  一条路收下的文件另一条路打不开。 */
  private static readLetter(
    f?: { filename: string; contentBase64: string }
  ): Buffer | null {
    if (!f) return null;
    /* base64 解出来才知道真实大小。**按解出来的判**，不按字符串长度 ——
       base64 比原文大三分之一，拿字符串长度当大小会把一份 7.5 MB 的
       PDF 报成"超过 10 MB"，而报错里那个数字对不上人看到的文件大小。 */
    const bytes = Buffer.from(f.contentBase64, "base64");
    if (!bytes.length)
      throw new ProblemException("validation-failed", {
        detail: "文件内容是空的 —— base64 解出来一个字节都没有" });
    if (bytes.length > AcceptanceService.LETTER_MAX)
      throw new ProblemException("validation-failed", {
        detail: `文件 ${(bytes.length / 1048576).toFixed(1)} MB，超过 10 MB 上限 —— ` +
          "受理意向函是一页扫描件，这么大通常是扫描分辨率调得太高"
      });
    /* **认一下它是不是真的 PDF。** 只看扩展名或 contentType 的话，
       传上来的可能是任何东西，而下载的人拿到一个打不开的文件时，
       第一反应是"系统坏了"。PDF 的前五个字节是 %PDF-。 */
    if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-")
      throw new ProblemException("validation-failed", {
        detail: "这不是一个 PDF 文件（开头不是 %PDF-）—— " +
          "受理意向函请传扫描件的 PDF；改个扩展名不会让它变成 PDF"
      });
    return bytes;
  }

  /** 把一份意向函写进去（覆盖前一份）。递交与补登共用。 */
  private async putLetter(id: string, filename: string, bytes: Buffer) {
    await ctx().client.query(
      `INSERT INTO acceptance_letter
         (acceptance_id, filename, bytes, size_bytes, uploaded_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (acceptance_id) DO UPDATE
         SET filename = EXCLUDED.filename, bytes = EXCLUDED.bytes,
             size_bytes = EXCLUDED.size_bytes,
             uploaded_by = EXCLUDED.uploaded_by, uploaded_at = now()`,
      [id, filename.trim(), bytes, bytes.length, principal().accountId]);
  }

  async recordLetter(id: string, b: {
    receivedOn: string;
    file?: { filename: string; contentBase64: string };
  }) {
    const c = ctx();
    const p = principal();
    const a = await this.oneAcceptance(id);
    this.refuseRegistered(a, "登记受理意向函");

    const today = await this.today();
    if (b.receivedOn > today)
      throw new ProblemException("validation-failed", {
        detail: `收到日期 ${b.receivedOn} 在将来 —— 这一栏记的是「哪天拿到的」，` +
          "还没拿到的不用先登记"
      });
    if (b.receivedOn < day(a.submitted_on)!)
      this.invariant("acceptance-letter-before-submit",
        `收到日期 ${b.receivedOn} 早于递交日期 ${day(a.submitted_on)} —— ` +
        "受理意向函不会比材料先到");

    const bytes = AcceptanceService.readLetter(b.file);

    const before = { acceptedOn: day(a.accepted_on), hasLetter: !!a.letter };

    await c.client.query(
      `UPDATE site_acceptance
          SET state = 'accepted', accepted_on = $2::date
        WHERE id = $1`, [id, b.receivedOn]);

    if (bytes) await this.putLetter(id, b.file!.filename, bytes);

    await this.audit.write({
      action: "登记受理意向函", targetType: "site_acceptance", targetId: a.code,
      before, after: { acceptedOn: b.receivedOn, hasLetter: !!bytes || before.hasLetter },
      studySiteId: a.study_site_id ?? undefined,
      /* 记的是**谁登记的**，不是谁受理的 —— 后者在那张纸上。 */
      reason: `${a.hospital} 的受理意向函，${b.receivedOn} 收到` +
        (bytes ? `，已上传扫描件（${(bytes.length / 1024).toFixed(0)} KB）` : "（扫描件待补）") });

    const dto = await this.reloadAcceptance(id);
    return {
      data: dto,
      sideEffects: [{
        type: "SiteAccepted" as const,
        summary: `${a.code} 已受理（${b.receivedOn} 收到意向函）` +
          (bytes ? "" : " —— **扫描件还没传**，核查要看的是那张纸，别忘了补上") +
          (a.study_site_id
            ? "；该中心现在可以推进到「伦理递交」"
            : "；这个中心还没建档 —— 建档之后这条受理会自动挂上去"),
        ref: a.id,
        ...(a.study_site_id ? { studySiteId: a.study_site_id } : {})
      }]
    };
  }

  /** 取意向函原件。**这一条单独走**，因为它返回的是 PDF 字节而不是 JSON ——
   *  而台账那条查询一个字节都不带它。 */
  async letter(id: string) {
    /* 先过一次受理本身：行策略在那条上（acceptance_letter 的策略跟着父行走），
       而**范围外与不存在返回同一个 404** —— 区分开就是在确认「它存在」。 */
    await this.oneAcceptance(id);
    const { rows } = await ctx().client.query<{
      filename: string; content_type: string; bytes: Buffer;
    }>(`SELECT filename, content_type, bytes FROM acceptance_letter
         WHERE acceptance_id = $1`, [id]);
    if (!rows[0]) throw notFound("受理意向函");
    return rows[0];
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
