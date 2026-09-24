import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { CreateAccountBody, DateOnly, ImportRow, STAFF_LEVELS, type EXPORT_LISTS } from "@sitedesk/contracts";
import { ctx } from "../../infra/ctx.js";
import { AuditService } from "../../infra/audit.service.js";
import { ProblemException, notFound } from "../../infra/problem.js";
import { readTable, type Column, type TableRow } from "../../infra/csv.js";
import { ClinicalService } from "../clinical/clinical.service.js";
import { IdentityService } from "../identity/identity.service.js";

/* ════════════════════════════════════════════════════════════════════
   导出留痕与批量导入（W16 / W17）。

   ── 导入不另写一套校验 ─────────────────────────────────────────────
   每一行调的就是单条登记 / 单个建号那个方法：状态机、发号、审计、
   唯一性全是同一份。试运行也是**真跑一遍**，只是每行跑完就
   ROLLBACK TO SAVEPOINT —— 这样"试运行说能导、执行时却不行"只剩
   两次之间别人改了数据这一种情况，而不是两套判定对不上。

   每行一个 SAVEPOINT：第 7 行出错只回滚第 7 行，事务照常可用。
   回滚的那一行排进 afterCommit 的动作（通知之类）也一并撤掉 ——
   否则试运行会真的发出邮件。
   ════════════════════════════════════════════════════════════════════ */

type Out = z.infer<typeof ImportRow>;
interface Done { summary: string; screeningNo?: string | null; ref: string }

const LIST_LABEL: Record<(typeof EXPORT_LISTS)[number], string> = {
  subjects: "受试者", visits: "访视", queries: "数据质疑",
  timesheets: "工时", monitorVisits: "监查访视", qualityEvents: "质量事件"
};

const PRESCREEN_COLS = [
  { key: "no", label: "筛选号" },
  { key: "icf", label: "知情签署日" }
] as const satisfies readonly Column<string>[];

const ACCOUNT_COLS = [
  { key: "login", label: "登录名", required: true },
  { key: "name", label: "姓名", required: true },
  { key: "role", label: "角色", required: true },
  { key: "level", label: "级别", required: true },
  { key: "city", label: "城市", required: true },
  { key: "gcp", label: "GCP证书到期日" },
  { key: "team", label: "分组" }
] as const satisfies readonly Column<string>[];

/** 一行先过的那几道（格式、文件内重复）。给出原因就不再执行这一行。 */
type Check<K extends string> = (r: TableRow<K>) => string | null;

@Injectable()
export class IoService {
  constructor(
    private readonly audit: AuditService,
    private readonly clinical: ClinicalService,
    private readonly identity: IdentityService
  ) {}

  async recordExport(b: {
    list: (typeof EXPORT_LISTS)[number]; rows: number;
    studySiteId?: string | null; filters?: Record<string, string>;
  }) {
    if (b.studySiteId) {
      const s = await ctx().client.query(`SELECT 1 FROM study_site WHERE id = $1`, [b.studySiteId]);
      if (!s.rowCount) throw notFound("中心");
    }
    await this.audit.write({
      action: `导出${LIST_LABEL[b.list]}列表`, targetType: "export", targetId: b.list,
      after: { rows: b.rows, filters: b.filters ?? {} }, studySiteId: b.studySiteId ?? null
    });
    return { data: { recorded: true as const }, sideEffects: [] };
  }

  /* ── 预筛登记 ─────────────────────────────────────────────────── */

  async prescreen(b: { csv: string; studySiteId: string }, dry: boolean) {
    const site = await ctx().client.query(`SELECT 1 FROM study_site WHERE id = $1`, [b.studySiteId]);
    if (!site.rowCount) throw notFound("中心");
    const rows = readTable(b.csv, PRESCREEN_COLS);
    const seen = new Set<string>();
    const check: Check<"no" | "icf"> = r => {
      const { no, icf } = r.cells;
      if (no.length > 32) return "筛选号最长 32 个字符";
      if (no) {
        if (seen.has(no)) return "与文件里前面某一行的筛选号重复";
        seen.add(no);
      }
      if (icf && !DateOnly.safeParse(icf).success) return `知情签署日「${icf}」不是 YYYY-MM-DD 格式的日期`;
      return null;
    };
    return this.run(rows, dry, check, async r => {
      const { no, icf } = r.cells;
      const s = await this.clinical.createSubject({
        studySiteId: b.studySiteId, ...(no ? { screeningNo: no } : {}) });
      if (icf) await this.clinical.signIcf(s.id, { signedOn: icf });
      return {
        summary: (icf ? `登记预筛，并登记知情签署（${icf}）` : "登记预筛") + (no ? "" : "，筛选号自动发"),
        /* 试运行里自动发的号会随回滚作废，下一行会再拿到同一个号 —— 不显示，免得看着像撞号 */
        screeningNo: no || (dry ? null : s.screeningNo ?? null),
        ref: s.id
      };
    }, r => r.cells.icf ? "登记预筛，并登记知情签署" : "登记预筛");
  }

  /* ── 人员账号 ─────────────────────────────────────────────────── */

  async accounts(b: { csv: string }, dry: boolean) {
    const rows = readTable(b.csv, ACCOUNT_COLS);
    const c = ctx();
    const roles = (await c.client.query<{ id: string; code: string; name: string; is_external: boolean }>(
      `SELECT id, code, name, is_external FROM role`)).rows;
    const teams = (await c.client.query<{ id: string; code: string; name: string }>(
      `SELECT id, code, name FROM team`)).rows;
    /* 角色名称写成「临床协调员 CRC」，表里填「临床协调员」也认 */
    const role = (v: string) => roles.find(x => x.code.toLowerCase() === v.toLowerCase() ||
      x.name === v || x.name.replace(/\s*[A-Za-z]+$/, "").trim() === v);
    const team = (v: string) => teams.find(x => x.code.toLowerCase() === v.toLowerCase() || x.name === v);

    const seen = new Set<string>();
    type K = (typeof ACCOUNT_COLS)[number]["key"];
    const bodyOf = (r: TableRow<K>) => ({
      login: r.cells.login, displayName: r.cells.name, roleId: role(r.cells.role)?.id ?? "",
      teamId: r.cells.team ? team(r.cells.team)?.id ?? null : null,
      staff: { level: r.cells.level, city: r.cells.city, gcpExpiresOn: r.cells.gcp || null }
    });
    const check: Check<K> = r => {
      const { login, role: rv, level, team: tv } = r.cells;
      if (seen.has(login)) return "与文件里前面某一行的登录名重复";
      if (login) seen.add(login);
      const ro = role(rv);
      if (!ro) return `没有叫「${rv}」的角色（填角色代号或名称，如 crc / 临床协调员）`;
      if (ro.is_external) return `「${ro.name}」是外部方角色 —— 外部方账号请在账号台账里单个建（要选所属机构）`;
      if (!(STAFF_LEVELS as readonly string[]).includes(level))
        return `级别「${level}」不在 ${STAFF_LEVELS.join(" / ")} 里`;
      if (tv && !team(tv)) return `没有叫「${tv}」的分组`;
      const p = CreateAccountBody.safeParse(bodyOf(r));
      if (!p.success) {
        const i = p.error.issues[0]!;
        const col = i.path[0] === "login" ? "登录名" : i.path[0] === "displayName" ? "姓名"
          : i.path.includes("gcpExpiresOn") ? "GCP证书到期日" : i.path.includes("city") ? "城市" : String(i.path.join("."));
        return `${col}：${i.message}`;
      }
      return null;
    };
    return this.run(rows, dry, check, async r => {
      const a = await this.identity.createAccount(bodyOf(r));
      const ro = role(r.cells.role)!;
      return { summary: `新建账号 ${a.login}（${ro.name} · ${r.cells.level} · ${r.cells.city}）`, ref: a.id };
    }, r => `新建账号 ${r.cells.login}`);
  }

  /* ── 逐行执行 ─────────────────────────────────────────────────── */

  private async run<K extends string>(
    rows: TableRow<K>[], dry: boolean, check: Check<K>,
    exec: (r: TableRow<K>) => Promise<Done>,
    /** 这一行没跑到 exec 时，summary 里说它原本要做什么 */
    intent: (r: TableRow<K>) => string
  ) {
    const c = ctx();
    const out: Out[] = [];
    for (const r of rows) {
      const bad = check(r);
      if (bad) {
        out.push({ line: r.line, status: dry ? "error" : "failed", summary: intent(r),
          error: bad, ref: null });
        continue;
      }
      const hooks = c.afterCommit.length;
      await c.client.query("SAVEPOINT import_row");
      try {
        const d = await exec(r);
        if (dry) {
          await c.client.query("ROLLBACK TO SAVEPOINT import_row");
          c.afterCommit.length = hooks;
        } else await c.client.query("RELEASE SAVEPOINT import_row");
        out.push({ line: r.line, status: dry ? "ok" : "done",
          summary: d.summary,
          error: null, ...(d.screeningNo ? { screeningNo: d.screeningNo } : {}), ref: dry ? null : d.ref });
      } catch (e) {
        await c.client.query("ROLLBACK TO SAVEPOINT import_row");
        c.afterCommit.length = hooks;
        out.push({ line: r.line, status: dry ? "error" : "failed", summary: intent(r),
          error: rowError(e), ref: null });
      }
    }
    const ok = out.filter(r => r.status === "ok" || r.status === "done").length;
    return { data: { rows: out, ok, bad: out.length - ok }, sideEffects: [] };
  }
}

/** 一行为什么没成。业务上的拒绝（422 / 409 / 404）原话给人看；
 *  库里的唯一约束翻成人话；其余的是缺陷，照常抛出去（500），不在这里吞掉。 */
function rowError(e: unknown): string {
  if (e instanceof ProblemException) return e.message;
  if ((e as { code?: string }).code === "23505") return "库里已经有这一条了（重复）";
  throw e;
}
