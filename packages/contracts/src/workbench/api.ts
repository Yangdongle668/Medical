import { z } from "zod";
import { define } from "../kernel/registry.js";
import { Uuid, DateOnly, Timestamp, Code } from "../kernel/primitives.js";
import { gated } from "../kernel/fields.js";
import { commandResult } from "../kernel/command.js";

/* ════════════════════════════════════════════════════════════════════
   「我的待办」—— 一线首页的数据源。

   ── 为什么要有这个端点 ────────────────────────────────────────────
   CRC 每天要处理的事散在十来个页面上：超窗的访视在「今天」、
   SAE 的 24 小时在「质量与 SAE」底下某个中心的面板里、
   待回复的质疑在「数据质疑」、交接给他的在「交接」、
   过期的批件在「中心文件」……系统里每一样都有，但**没有一处把它们排在一起**。
   于是"今天先做哪件"要他自己去十个页面上翻一遍再心算。

   这个端点只做一件事：把「要你动手的」按紧急程度排成一列。

   ── 它不是一套新的判定 ────────────────────────────────────────────
   每一类待办都由那个模块**自己的列表方法**取出来（服务端直接调用），
   什么算超窗、什么算我的、什么算过期，只有一份定义。
   行范围照常由 RLS 收；受试者类需要 `subjRead`，没有就整类不出现；
   筛选号是单独一个受列权限管辖的字段，标题里不写它。
   ════════════════════════════════════════════════════════════════════ */

const CTX = "workbench";

export const INBOX_KINDS = [
  "sae",            // SAE 还没上报 —— 24 小时时钟在走
  "visit",          // 受试者访视：已超窗 / 今天到期 / 7 天内
  "pi_confirm",     // 访视做完了，PI 签字还没登记
  "edc",            // 访视做完了，EDC 还没录
  "query",          // 指派给我、待回复的数据质疑
  "handover",       // 交接给我的、还没完成的
  "approval",       // 等我审的工时（合成一条）
  "isf",            // 中心文件：缺失 / 过期 / 快过期
  "capa",           // 负责人是我、还没关的整改
  "mvr",            // 我去过现场、报告还没交
  "monitor_visit"   // 我排的监查访视，14 天内
] as const;

export const InboxUrgency = z.enum(["overdue", "today", "soon"]).meta({
  id: "InboxUrgency",
  description: "overdue 已经过了期限；today 今天就是期限（或今天该办）；soon 这几天内要办。"
});

export const InboxItem = z.object({
  kind: z.enum(INBOX_KINDS),
  urgency: InboxUrgency,
  /** 期限是一个日子的（访视窗口、文件到期、报告第 10 天） */
  dueOn: DateOnly.nullable(),
  /** 期限是一个时刻的（SAE 知悉后 24 小时） */
  dueAt: Timestamp.nullable(),
  /** 一句话：这件事是什么。不含筛选号 —— 那是下面单独受管的字段。 */
  title: z.string(),
  /** 第二行：为什么急、还差什么 */
  detail: z.string(),
  studySiteId: Uuid.nullable(),
  siteCode: Code.nullable(),
  screeningNo: gated(z.string(), "subject"),
  /** 只看、不办：这件事归别人办，你要跟进。目前只有 SAE ——
   *  监查员（有 monitor、没有 subjWrite）不是上报人，但 24 小时时钟在他的中心上走，
   *  他得知道、得去催。缺省即 false。 */
  watch: z.boolean().optional(),
  /** 去哪办。`id` 为空的是合成条目（例如「6 条工时待审」）。 */
  ref: z.object({
    type: z.enum(["subject_visit", "quality_event", "data_query", "handover",
                  "timesheet", "isf_item", "monitor_visit"]),
    id: Uuid.nullable()
  })
}).meta({ id: "InboxItem" });

export const Inbox = z.object({
  items: z.array(InboxItem),
  counts: z.object({
    overdue: z.int().min(0), today: z.int().min(0), soon: z.int().min(0)
  }),
  /** 某一类取到了上限、后面还有 —— 那一类要去它自己的页面看全。 */
  truncatedKinds: z.array(z.enum(INBOX_KINDS)),
  generatedAt: Timestamp
}).meta({ id: "Inbox" });

define({
  id: "getMyInbox", method: "get", path: "/v1/me/inbox", layer: "L1", context: CTX,
  summary: "我的待办",
  description:
    "把要当前用户动手的事按紧急程度排成一列：已过期 → 今天 → 这几天。\n" +
    "每一类都由所属模块自己的列表逻辑取出，口径与各自页面一致；" +
    "行范围照常生效，受试者类需要 `subjRead`（没有就整类不出现，不是 403）。\n" +
    "每类至多 20 条；截断的类列在 `truncatedKinds` 里。",
  response: Inbox
});

/* ════════════════════════════════════════════════════════════════════
   全局搜索（Ctrl/⌘ + K）。

   「S-0203 下次什么时候来」「SS-07 是哪家医院」—— 知道编号，不知道它在哪一页。
   只搜两类对象：**中心**（代号 / 医院名）与**受试者**（筛选号）；
   页面名在前端按侧栏模块匹配，不走这里。

   受试者要同时有 `subjRead` 与受试者列权限才搜：没有列权限的人，
   连「有 / 没有这个筛选号」这一点都不该从命中数里读出来。
   搜受试者会像受试者列表一样**记一条访问审计**。
   ════════════════════════════════════════════════════════════════════ */

export const SearchQuery = z.object({
  q: z.string().trim().min(2).max(64)
});

export const SearchHit = z.object({
  type: z.enum(["site", "subject"]),
  id: Uuid,
  /** 中心：代号 + 医院；受试者：所在中心代号。筛选号不写在这里 —— 见下面那一栏 */
  label: z.string(),
  sub: z.string(),
  studySiteId: Uuid,
  screeningNo: gated(z.string(), "subject")
}).meta({ id: "SearchHit" });

define({
  id: "search", method: "get", path: "/v1/search", layer: "L1", context: CTX,
  summary: "全局搜索",
  description:
    "中心按代号 / 医院名、受试者按筛选号，每类至多 5 条。行范围照常生效。\n" +
    "受试者需要 `subjRead` 与受试者列权限，缺一整类不出现（不是 403）。",
  query: SearchQuery,
  response: z.object({ items: z.array(SearchHit) })
});

/* ── 邮件提醒偏好 ──────────────────────────────────────────────────
   两个开关：紧急提醒（SAE 时限、今天关窗的访视）与每日摘要。
   `hasEmail` 告诉人「你根本收不到」—— 没登记邮箱时开关开着也没用，
   而那种"我明明开了为什么没收到"最难自己查。 */
export const NotifyPrefs = z.object({
  digest: z.boolean(),
  urgent: z.boolean(),
  hasEmail: z.boolean().describe("有没有登记收件邮箱；没有的话两个开关都不起作用")
}).meta({ id: "NotifyPrefs" });

export const SetNotifyPrefsBody = z.object({ digest: z.boolean(), urgent: z.boolean() });

define({
  id: "getNotifyPrefs", method: "get", path: "/v1/me/notify-prefs", layer: "L1", context: CTX,
  summary: "我的邮件提醒偏好",
  response: NotifyPrefs
});

define({
  id: "setNotifyPrefs", method: "patch", path: "/v1/me/notify-prefs", layer: "L1", context: CTX,
  summary: "改我的邮件提醒偏好",
  description: "只改自己的。没有这一行时等于两个都开。",
  body: SetNotifyPrefsBody,
  response: NotifyPrefs
});

/* ════════════════════════════════════════════════════════════════════
   导出留痕（W16）。

   导出本身在前端做：按当前筛选条件把列表翻页拉完，拼成 CSV。
   **数据走的是列表接口**，行范围与列权限照常生效 —— 导出的就是他本来看得到的。
   这一条只记"谁在什么时候导出了哪张表、多少行、什么条件"，不传数据本身。
   列表接口每翻一页已经各记一条"查询明细"；这一条是把它们认成一次导出。
   ════════════════════════════════════════════════════════════════════ */

export const EXPORT_LISTS = [
  "subjects", "visits", "queries", "timesheets", "monitorVisits", "qualityEvents"
] as const;

export const RecordExportBody = z.object({
  list: z.enum(EXPORT_LISTS),
  rows: z.int().min(0).max(100_000),
  studySiteId: Uuid.nullable().optional(),
  /** 当时的筛选条件，原样记进审计。只收短字符串 —— 这里不是传数据的地方 */
  filters: z.record(z.string().max(32), z.string().max(128)).optional()
});

define({
  id: "recordExport", method: "post", path: "/v1/exports:record", layer: "L2", context: CTX,
  summary: "登记一次列表导出",
  description:
    "只写审计（哪张表、多少行、什么筛选条件），不传数据本身。行范围照常：" +
    "给了 `studySiteId` 而看不到那个中心时 404。",
  body: RecordExportBody,
  response: commandResult(z.object({ recorded: z.literal(true) })),
  errors: ["idempotency-key-reused"]
});

/* ════════════════════════════════════════════════════════════════════
   批量导入（W17）：先试运行，再逐行执行。

   只收 CSV（Excel「另存为 → CSV UTF-8」）。不解析 xlsx：
   那需要引入一个体积大、历史上出过原型污染与 zip 炸弹问题的解析库，
   而一线手里的模板本来就是我们给的那一份。

   ── 两步 ────────────────────────────────────────────────────────
   · `:preview` 不写任何东西：逐行说"可导入 / 为什么不行"。
   · `:commit` 逐行执行，每行各自成败（行级 SAVEPOINT）—— 第 7 行筛选号重复
     不会连累其他 49 行；结果逐行返回。整个请求带幂等键，重发不会建两遍；
     再传一次同一份文件，已建的行会在试运行里标成"已存在"。
   ════════════════════════════════════════════════════════════════════ */

export const ImportCsvBody = z.object({
  /** 整个 CSV 文件的文本（UTF-8，可带 BOM）。至多 500 行数据 */
  csv: z.string().min(1).max(60_000)
});

export const ImportPrescreenBody = ImportCsvBody.extend({ studySiteId: Uuid });

export const ImportRow = z.object({
  /** 文件里的行号（表头是第 1 行） */
  line: z.int().min(2),
  status: z.enum(["ok", "error", "done", "failed"])
    .describe("试运行：ok 可导入 / error 不行；执行：done 已建 / failed 没建成"),
  /** 这一行要做（或做了）什么，给人看的一句话。不含筛选号 —— 那一栏单独给、受列权限管 */
  summary: z.string(),
  error: z.string().nullable(),
  screeningNo: gated(z.string(), "subject"),
  /** 建成了的对象 id（执行后才有） */
  ref: Uuid.nullable()
}).meta({ id: "ImportRow" });

export const ImportResult = z.object({
  rows: z.array(ImportRow),
  ok: z.int().min(0).describe("试运行：可导入的行数；执行：建成的行数"),
  bad: z.int().min(0).describe("试运行：不能导入的行数；执行：没建成的行数")
}).meta({ id: "ImportResult" });

define({
  id: "previewPrescreenImport", method: "post", path: "/v1/imports/prescreen:preview",
  layer: "L2", context: CTX, action: "subjWrite",
  summary: "预筛登记批量导入 · 试运行",
  description:
    "列：`筛选号`（空着 = 按中心自动发号）、`知情签署日`（YYYY-MM-DD，可空；" +
    "填了就一并登记签署，进入筛选期并排出筛选期访视）。\n" +
    "**不写任何东西**，逐行返回能不能导、为什么不能。",
  body: ImportPrescreenBody,
  response: commandResult(ImportResult),
  errors: ["not-found", "idempotency-key-reused"]
});

define({
  id: "commitPrescreenImport", method: "post", path: "/v1/imports/prescreen:commit",
  layer: "L2", context: CTX, action: "subjWrite",
  summary: "预筛登记批量导入 · 执行",
  description: "逐行执行，每行各自成败；结果逐行返回。与单条登记走同一套校验与审计。",
  body: ImportPrescreenBody,
  response: commandResult(ImportResult),
  errors: ["not-found", "idempotency-key-reused"]
});

define({
  id: "previewAccountImport", method: "post", path: "/v1/imports/accounts:preview",
  layer: "L2", context: CTX, action: "manage",
  summary: "人员账号批量创建 · 试运行",
  description:
    "列：`登录名`、`姓名`、`角色`（代号或名称）、`级别`、`城市`、`GCP证书到期日`（可空）、`分组`（可空）。\n" +
    "只建内部账号，建号的同时登记员工名册（级别 / 城市必填）；不设口令 —— 本人走一次性链接或单点登录进来。\n" +
    "**不写任何东西**，逐行返回能不能建、为什么不能。",
  body: ImportCsvBody,
  response: commandResult(ImportResult),
  errors: ["idempotency-key-reused"]
});

define({
  id: "commitAccountImport", method: "post", path: "/v1/imports/accounts:commit",
  layer: "L2", context: CTX, action: "manage",
  summary: "人员账号批量创建 · 执行",
  description: "逐行执行，每行各自成败；与单个建号走同一套校验与审计。",
  body: ImportCsvBody,
  response: commandResult(ImportResult),
  errors: ["idempotency-key-reused"]
});
