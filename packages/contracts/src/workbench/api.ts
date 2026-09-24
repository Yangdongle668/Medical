import { z } from "zod";
import { define } from "../kernel/registry.js";
import { Uuid, DateOnly, Timestamp, Code } from "../kernel/primitives.js";
import { gated } from "../kernel/fields.js";

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
