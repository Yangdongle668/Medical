import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { Pool } from "pg";
import type { z } from "zod";
import type { InboxItem } from "@sitedesk/contracts";
import { POOL } from "../../infra/db.js";
import { runAs } from "../../infra/run-as.js";
import { ctx } from "../../infra/ctx.js";
import { emit } from "../../infra/log.js";
import { NotifyService } from "../../infra/notify.js";
import { InboxService } from "./inbox.service.js";

/* ════════════════════════════════════════════════════════════════════
   邮件提醒（迁移 0055 的文件头说了为什么）。

   ── 发什么由待办决定 ───────────────────────────────────────────────
   以收件人本人的身份跑一遍首页待办（runAs + InboxService），
   从里面挑。**不另写一套"什么算急"** —— 否则邮件里说的与首页上看到的对不上。

   ── 两种邮件 ─────────────────────────────────────────────────────
   紧急（到点就发，每件事每个档只发一次）：
     · SAE：知悉后 12 小时、20 小时（还剩 4 小时）、24 小时已过 —— 三个档；
     · 今天关窗的访视：当天一次。
   每日摘要：工作日、本地时间过了 SITEDESK_DIGEST_HOUR（默认 8 点），一天一封；
     没有待办就不发 —— 一封「今天没事」的邮件只会教会人忽略这个发件人。

   ── 去重在库里 ───────────────────────────────────────────────────
   notify_sent 的主键是 (人, 事, 档)。先插入、插进去了才发 ——
   多副本同时跑、进程中途重启，都不会把同一件事发两遍。
   代价是插进去而发送失败时这一档就丢了；投递本身有重试（NotifyService），
   而重复打扰比漏一封更伤这套提醒的信用。

   ── 正文里没有受试者信息 ─────────────────────────────────────────
   待办的标题本来就不写筛选号（它是受列权限管辖的另一栏），
   邮件只用标题、中心代号和链接。邮件会出这套系统的边界，筛选号不该跟着出去。
   ════════════════════════════════════════════════════════════════════ */

type Item = z.infer<typeof InboxItem>;

export interface Plan {
  urgent: { key: string; mark: string; item: Item }[];
  digest: string | null;
}

const H = 3_600_000;

/** 本地的日期、钟点、星期（0 = 周日）。服务端的 new Date() 是 UTC —— 按 UTC 算，
 *  东八区早上八点前的摘要会被当成前一天的。 */
export function localParts(now: Date, tz: string) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hour12: false, weekday: "short"
  }).formatToParts(now);
  const get = (t: string) => f.find(p => p.type === t)?.value ?? "";
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")) % 24,
    weekday: days.indexOf(get("weekday"))
  };
}

/** 纯函数：这一刻该发哪些。 */
export function planReminders(items: readonly Item[], now: Date,
                              opts: { tz: string; digestHour: number }): Plan {
  const local = localParts(now, opts.tz);
  const urgent: Plan["urgent"] = [];
  for (const i of items) {
    if (i.kind === "sae" && i.dueAt && i.ref.id) {
      const left = Date.parse(i.dueAt) - now.getTime();
      const mark = left <= 0 ? "24h" : left <= 4 * H ? "20h" : left <= 12 * H ? "12h" : null;
      if (mark) urgent.push({ key: `sae:${i.ref.id}`, mark, item: i });
    }
    if (i.kind === "visit" && i.urgency === "today" && i.ref.id)
      urgent.push({ key: `visit:${i.ref.id}`, mark: local.date, item: i });
  }
  const workday = local.weekday >= 1 && local.weekday <= 5;
  const digest = workday && local.hour >= opts.digestHour && items.length > 0 ? local.date : null;
  return { urgent, digest };
}

const intervalOf = (env: NodeJS.ProcessEnv) => {
  const raw = env["SITEDESK_REMIND_INTERVAL_MS"]?.trim();
  /* 测试里默认关掉：到点自己跑起来的提醒会在别的测试里凭空多出几封邮件 */
  if (!raw) return env["NODE_ENV"] === "test" ? 0 : 10 * 60_000;
  return /^\d+$/.test(raw) ? Number(raw) : 10 * 60_000;
};

const origin = () =>
  (process.env["SITEDESK_PUBLIC_ORIGIN"] ?? "http://localhost:8080").replace(/\/+$/, "");

const LABEL: Record<string, string> = {
  sae: "SAE", visit: "访视", pi_confirm: "PI 签字", edc: "EDC", query: "质疑", handover: "交接",
  approval: "审批", isf: "文件", capa: "整改", mvr: "监查报告", monitor_visit: "监查访视"
};
const line = (i: Item) =>
  `· [${LABEL[i.kind] ?? i.kind}] ${i.title}${i.siteCode ? `（${i.siteCode}）` : ""} —— ${i.detail}`;

@Injectable()
export class RemindService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    @Inject(POOL) private readonly pool: Pool,
    private readonly inbox: InboxService,
    private readonly notify: NotifyService
  ) {}

  onModuleInit() {
    const every = intervalOf(process.env);
    if (!every) { emit("info", "remind", "邮件提醒未开启（SITEDESK_REMIND_INTERVAL_MS=0 或测试环境）"); return; }
    const arm = (d: number) => {
      this.timer = setTimeout(() => {
        void this.tick().finally(() => { if (!this.stopped) arm(every); });
      }, d);
      this.timer.unref?.();
    };
    /* 与清理任务同一个理由错开：多副本同时启动时不要在同一秒抢锁 */
    arm(30_000 + Math.floor(Math.random() * 60_000));
    emit("info", "remind", "邮件提醒已启动", { everyMs: every });
  }

  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** 跑一轮。返回这一轮给多少人发了紧急 / 摘要（测试与日志用）。 */
  async tick(now = new Date()): Promise<{ skipped: boolean; urgent: number; digest: number }> {
    const tz = process.env["SITEDESK_TZ"] ?? "Asia/Shanghai";
    const digestHour = Number(process.env["SITEDESK_DIGEST_HOUR"] ?? 8);
    /* 会话级咨询锁：一轮里要开很多个事务（每人一个），事务级锁撑不过第一个人 */
    const lock = await this.pool.connect();
    let urgentSent = 0, digestSent = 0;
    try {
      const { rows: got } = await lock.query<{ ok: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext('sitedesk.remind')) AS ok");
      if (!got[0]?.ok) return { skipped: true, urgent: 0, digest: 0 };
      try {
        const { rows } = await lock.query<{ account_id: string; digest: boolean; urgent: boolean }>(
          "SELECT account_id, digest, urgent FROM app.notify_recipients()");
        for (const r of rows) {
          try {
            const sent = await runAs(this.pool, r.account_id, "remind",
              () => this.forOne(r, now, { tz, digestHour }));
            urgentSent += sent.urgent ? 1 : 0;
            digestSent += sent.digest ? 1 : 0;
          } catch (e) {
            /* 一个人的待办取不出来，不该让后面的人都收不到 */
            emit("error", "remind", "这个人的提醒没跑成",
              { accountId: r.account_id, err: e instanceof Error ? e.message : String(e) });
          }
        }
      } finally {
        await lock.query("SELECT pg_advisory_unlock(hashtext('sitedesk.remind'))");
      }
    } finally { lock.release(); }
    if (urgentSent || digestSent)
      emit("info", "remind", "这一轮发了提醒", { urgent: urgentSent, digest: digestSent });
    return { skipped: false, urgent: urgentSent, digest: digestSent };
  }

  /* ── 偏好（请求里调，身份就是请求的那个人） ─────────────────────── */
  async prefs() {
    const c = ctx();
    const { rows } = await c.client.query<{ digest: boolean; urgent: boolean; has_email: boolean }>(
      `SELECT coalesce(p.digest, true) AS digest, coalesce(p.urgent, true) AS urgent,
              EXISTS (SELECT 1 FROM app.login_destination(app.current_account_id()) d
                       WHERE d.channel = 'email') AS has_email
         FROM (SELECT 1) one
         LEFT JOIN notify_pref p ON p.account_id = app.current_account_id()`);
    const r = rows[0]!;
    return { digest: r.digest, urgent: r.urgent, hasEmail: r.has_email };
  }

  async setPrefs(b: { digest: boolean; urgent: boolean }) {
    await ctx().client.query(
      `INSERT INTO notify_pref (account_id, tenant_id, digest, urgent)
       VALUES (app.current_account_id(), app.current_tenant_id(), $1, $2)
       ON CONFLICT (account_id) DO UPDATE SET digest = EXCLUDED.digest, urgent = EXCLUDED.urgent`,
      [b.digest, b.urgent]);
    return this.prefs();
  }

  /** 在收件人本人的身份下：取待办 → 算该发什么 → 先占位再发。 */
  private async forOne(r: { account_id: string; digest: boolean; urgent: boolean },
                       now: Date, opts: { tz: string; digestHour: number }) {
    const box = await this.inbox.mine();
    const plan = planReminders(box.items, now, opts);
    const want = [
      ...(r.urgent ? plan.urgent.map(u => ({ key: u.key, mark: u.mark })) : []),
      ...(r.digest && plan.digest ? [{ key: "digest", mark: plan.digest }] : [])
    ];
    if (!want.length) return { urgent: false, digest: false };

    const { rows: claimed } = await ctx().client.query<{ item_key: string; mark: string }>(
      `INSERT INTO notify_sent (account_id, tenant_id, item_key, mark)
       SELECT $1, app.current_tenant_id(), k, m FROM unnest($2::text[], $3::text[]) AS x(k, m)
       ON CONFLICT DO NOTHING RETURNING item_key, mark`,
      [r.account_id, want.map(w => w.key), want.map(w => w.mark)]);
    const got = new Set(claimed.map(c => `${c.item_key}|${c.mark}`));

    const urgentNow = plan.urgent.filter(u => r.urgent && got.has(`${u.key}|${u.mark}`));
    if (urgentNow.length) {
      const sae = urgentNow.filter(u => u.item.kind === "sae").length;
      this.notify.queue({
        accountId: r.account_id,
        subject: sae ? `【紧急】${sae} 条 SAE 的 24 小时时限` : `【今天】${urgentNow.length} 次访视今天关窗`,
        text: [
          "下面这些事有时限，现在就要处理：", "",
          ...urgentNow.map(u => line(u.item)), "",
          `打开待办：${origin()}/today`, "",
          "（不想收这类邮件：待办页右上角「提醒设置」。）"
        ].join("\n")
      });
    }

    const digestNow = !!plan.digest && r.digest && got.has(`digest|${plan.digest}`);
    if (digestNow) {
      const { counts } = box;
      this.notify.queue({
        accountId: r.account_id,
        subject: `今天的待办：${counts.overdue} 件已过期，${counts.today} 件今天要办`,
        text: [
          `已过期 ${counts.overdue} 件 · 今天 ${counts.today} 件 · 这几天 ${counts.soon} 件。`, "",
          ...box.items.slice(0, 10).map(line),
          ...(box.items.length > 10 ? [`……还有 ${box.items.length - 10} 件`] : []), "",
          `打开待办：${origin()}/today`, "",
          "（不想收每日摘要：待办页右上角「提醒设置」。）"
        ].join("\n")
      });
    }
    return { urgent: urgentNow.length > 0, digest: digestNow };
  }
}
