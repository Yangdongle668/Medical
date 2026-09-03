import { z } from "zod";
import { define } from "../kernel/registry.js";
import { Uuid, DateOnly, QueryBool } from "../kernel/primitives.js";
import { PageQuery, page } from "../kernel/pagination.js";
import { commandResult } from "../kernel/command.js";
import {
  Milestone, MilestoneState, MilestonePlanItem, ArAging, Client, CashForecast
} from "./model.js";

const CTX = "finance";
const ById = z.object({ id: Uuid });

/* ── 里程碑 · 结算 ───────────────────────────────────────────────── */

define({
  id: "listMilestones", method: "get", path: "/v1/milestones",
  layer: "L1", context: CTX,
  summary: "里程碑 · 结算",
  description:
    "达成 → 开票 → 回款。**只有已达成的在这张表上** —— " +
    "未来的里程碑是从入组速度推出来的预测，在现金流那一页，不在台账里。\n\n" +
    "默认按**逾期最久**排：一笔挂了 94 天的应收，比今天刚达成的那笔紧急得多。\n" +
    "金额受 `price` 列权限管辖；对外部方整表关闭 —— " +
    "一个中心收了多少钱，医院不该从我们这里看到。",
  query: PageQuery.extend({
    studySiteId: Uuid.optional(),
    studyId: Uuid.optional(),
    clientId: Uuid.optional(),
    state: z.array(MilestoneState).optional(),
    /** 只看已开票未回款的（应收）。 */
    receivableOnly: QueryBool.optional(),
    /** 只看已过到期日的 —— 真正要打电话的那部分。 */
    overdueOnly: QueryBool.optional()
  }),
  response: page(Milestone)
});

define({
  id: "getMilestonePlan", method: "get", path: "/v1/milestones/plan",
  layer: "L1", context: CTX,
  summary: "里程碑计划",
  description:
    "合同额按什么比例分段收。**五段之和必须是 1**，由库里的断言保证 ——" +
    "加一段忘了调别的，收入会凭空多出来一截，而没有任何地方会红。",
  response: z.object({ items: z.array(MilestonePlanItem) })
});

define({
  id: "getArAging", method: "get", path: "/v1/milestones/ar-aging",
  layer: "L1", context: CTX,
  summary: "应收账龄",
  description:
    "**逾期占比比绝对额有用**：500 万里逾期 50 万，和 80 万里逾期 50 万，" +
    "是两种完全不同的处境。两者都给。\n" +
    "逾期超过 60 天的单独算 —— 那不再是催收问题。",
  query: z.object({ clientId: Uuid.optional() }),
  response: ArAging
});

define({
  id: "invoiceMilestone", method: "post", path: "/v1/milestones/{id}:invoice",
  layer: "L2", context: CTX, action: "bid",
  summary: "开票",
  description:
    "到期日由**客户的账期**算出来并落库固化 —— 客户之后改账期，" +
    "历史发票的到期日不该跟着变。\n" +
    "开票日不得早于达成日：开不出那样的票（库里的 CHECK 也不让）。",
  params: ById,
  body: z.object({
    invoicedOn: DateOnly.optional().describe("默认今天"),
    note: z.string().max(500).optional()
  }),
  response: commandResult(Milestone),
  errors: ["invariant-violated", "idempotency-key-reused"]
});

define({
  id: "payMilestone", method: "post", path: "/v1/milestones/{id}:pay",
  layer: "L2", context: CTX, action: "bid",
  summary: "登记回款",
  description:
    "回款日不得早于开票日。**已回款的不能改回去** —— " +
    "钱到账是一件不可撤销的事实，写错了要走冲销，不是改状态。",
  params: ById,
  body: z.object({
    paidOn: DateOnly.optional().describe("默认今天"),
    note: z.string().max(500).optional()
  }),
  response: commandResult(Milestone),
  errors: ["invariant-violated", "idempotency-key-reused"]
});

/* ── 客户档案 ────────────────────────────────────────────────────── */

define({
  id: "listClients", method: "get", path: "/v1/clients",
  layer: "L1", context: CTX,
  summary: "客户档案",
  description:
    "申办方。**比「单中心毛利」更上位的切片** ——\n" +
    "「这个客户欠了我们多少、平均拖多久、在手几个项目」" +
    "是按项目切看不出来的。\n\n" +
    "这也是把 `study.sponsor_name` 从字符串升成一张表的理由（见迁移 0031）：" +
    "按字符串分组算这些数，一次拼写不一致就够毁掉那个数。\n" +
    "对外部方整表关闭 —— 账期、联系人、关系评分都是商业信息。",
  query: PageQuery.extend({ q: z.string().max(64).optional() }),
  response: page(Client)
});

define({
  id: "updateClient", method: "patch", path: "/v1/clients/{id}",
  layer: "L1", context: CTX, action: "manage",
  summary: "改客户档案",
  description:
    "**账期改了不回溯历史发票** —— 已开出去的票，到期日在开票那一刻就固化了。",
  params: ById,
  body: z.object({
    sinceYear: z.int().min(1980).max(2200).nullable().optional(),
    contact: z.string().max(120).nullable().optional(),
    paymentTermsDays: z.int().min(0).max(365).optional(),
    nps: z.int().min(0).max(10).nullable().optional(),
    note: z.string().max(1000).nullable().optional()
  }),
  response: Client,
  errors: ["invariant-violated"]
});

/* ── 现金流 ──────────────────────────────────────────────────────── */

define({
  id: "getCashForecast", method: "get", path: "/v1/cash-forecast",
  layer: "L1", context: CTX,
  summary: "现金流预测",
  description:
    "**系统此前只有后视镜。** 收入按已入组的例数确认、成本按已填的工时 ——" +
    "两者都只回答「已经发生了什么」。\n\n" +
    "而现金是另一回事：人力成本每月刚性支出，回款是里程碑制 + 账期。\n" +
    "一个毛利率 30% 的项目，完全可能在第四个月付不出工资。\n\n" +
    "三样东西必须分开给，混起来这套数就开始骗人：\n" +
    "· **已开票未回款** —— 按到期日落月；\n" +
    "· **预计达成** —— 按入组速度推，达成月 + 账期；\n" +
    "· **记录缺口**（已达成但没进开票队列）—— **单列，不进现金**。" +
    "它不是未来收入，钱本来就该收到了。\n\n" +
    "另给一份压力情景：逾期的再拖 3 个月、预计的延后 1 个月。" +
    "不是悲观 —— 逾期之所以逾期，恰恰是因为对方还没打算付。",
  query: z.object({
    months: z.coerce.number().int().min(1).max(12).optional().describe("默认 6")
  }),
  response: CashForecast
});
