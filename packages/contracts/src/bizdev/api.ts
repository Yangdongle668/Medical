import { z } from "zod";
import { define } from "../kernel/registry.js";
import { Uuid, Code, DateOnly, QueryBool } from "../kernel/primitives.js";
import { PageQuery, page } from "../kernel/pagination.js";
import { commandResult } from "../kernel/command.js";
import { CentsNonNeg } from "../kernel/primitives.js";
import {
  Feasibility, FeasibilityAnswers, FeasibilityStatus, FeasibilityCalibration,
  Bid, BidStatus, BidReview, ContractChange, ChangeKind, ChangeStatus, ScopeCreep
} from "./model.js";

const CTX = "bizdev";
const ById = z.object({ id: Uuid });

/* ── 中心可行性调查 ──────────────────────────────────────────────── */

define({
  id: "listFeasibility", method: "get", path: "/v1/feasibility",
  layer: "L1", context: CTX,
  summary: "中心可行性调查",
  description:
    "候选中心的病源、既往入组表现、竞争试验、启动周期 —— 用来决定要不要选它。\n\n" +
    "**外部方一行都看不到。** 这里存的是「我们在评估哪几家医院、各打了多少分、" +
    "谁被拒了」—— 让被比较的医院看见它，是可以直接毁掉合作关系的那种泄漏。\n" +
    "内部按项目切：这个项目下有一个中心是我看得见的，它的可行性调查我就看得见。\n\n" +
    "评分**由服务端算并逐项下发**：同一套口径出现在两个地方迟早分叉，" +
    "而分叉那天，一家医院会因为看哪个页面而得到不同的结论。",
  query: PageQuery.extend({
    studyId: Uuid.optional(),
    status: z.array(FeasibilityStatus).optional(),
    /** 只看「评分不够却入选了」的那些 —— 复盘时第一个要看的就是它们。 */
    overrideOnly: QueryBool.optional(),
    q: z.string().max(64).optional().describe("按医院名筛")
  }),
  response: page(Feasibility)
});

define({
  id: "getFeasibilityCalibration", method: "get", path: "/v1/feasibility/calibration",
  layer: "L1", context: CTX,
  summary: "评分口径的回顾",
  description:
    "入选的中心，当初预测得准不准。\n" +
    "**这是可行性这一页存在的第二个理由** —— 第一个是选址，" +
    "第二个是让选址的口径可被质疑：没有回写就没有校准，" +
    "评分就只是一套自洽的说法。",
  response: FeasibilityCalibration
});

define({
  id: "createFeasibility", method: "post", path: "/v1/feasibility",
  layer: "L1", context: CTX, status: 201, action: "bid",
  summary: "登记一次可行性调查",
  description:
    "同一个项目对同一家医院的同一个科室只能有一份 —— " +
    "重复了就没人知道该看哪一份（数据库直接拒绝）。",
  body: z.object({
    studyId: Uuid,
    hospital: z.string().trim().min(2).max(80),
    city: z.string().trim().min(2).max(40),
    dept: z.string().trim().min(2).max(40),
    piName: z.string().trim().min(2).max(40),
    surveyedOn: DateOnly,
    answers: FeasibilityAnswers
  }),
  response: Feasibility,
  errors: ["invariant-violated"]
});

define({
  id: "decideFeasibility", method: "post", path: "/v1/feasibility/{id}:decide",
  layer: "L2", context: CTX, action: "bid",
  summary: "入选或拒绝一个候选中心",
  description:
    "**系统不阻止低分入选** —— 它拦不住，也不该拦：商务上的取舍" +
    "本来就不归一套评分决定（申办方指定 PI、为赶 FPI 凑中心数，都发生过）。\n\n" +
    "但低于 65 分入选**必须写理由**。半年后复盘「这家怎么会选进来」时，" +
    "有那句话和没有那句话，是完全不同的两次会。\n" +
    "拒绝同样要写：申办方问「为什么没选这家」，「评分不够」不是答案，" +
    "「年就诊 45 例、既往没做过、启动要 147 天」才是。",
  params: ById,
  body: z.object({
    decision: z.enum(["selected", "rejected"]),
    reason: z.string().trim().max(500).optional()
      .describe("低分入选与拒绝时必填，至少 4 个字")
  }),
  response: commandResult(Feasibility),
  errors: ["invariant-violated", "idempotency-key-reused"]
});

define({
  id: "recordFeasibilityActual", method: "post",
  path: "/v1/feasibility/{id}:actual",
  layer: "L2", context: CTX, action: "bid",
  summary: "回填实际月入组",
  description:
    "**这一条是整套评分唯一能自我修正的地方。** 没有它，评分只是一套自洽的说法，" +
    "而自洽的说法在第一次争议里会被「我觉得这家不错」覆盖掉。\n" +
    "只有已入选的中心谈得上实际入组速度。",
  params: ById,
  body: z.object({ actualRate: z.number().min(0).max(1000) }),
  response: commandResult(Feasibility),
  errors: ["invariant-violated", "idempotency-key-reused"]
});

/* ── 投标与报价闭环 ─────────────────────────────────────────────── */

define({
  id: "listBids", method: "get", path: "/v1/bids", layer: "L1", context: CTX,
  summary: "投标台账",
  description:
    "报出去的价、赢没赢、对手报了多少。**对外部方整表关闭** ——\n" +
    "投标价格落到医院或申办方手里是直接的商业损失。\n" +
    "价格受 `price` 列权限管辖：拿不到那一列的人看得到投了几个标，看不到价。",
  query: PageQuery.extend({
    status: z.array(BidStatus).optional(),
    sponsor: z.string().max(64).optional()
  }),
  response: page(Bid)
});

define({
  id: "getBidReview", method: "get", path: "/v1/bids/review",
  layer: "L1", context: CTX,
  summary: "报价偏差复盘",
  description:
    "**这条端点是报价模型的反馈回路。** 没有它，「按我们的人天该报多少」" +
    "就是自说自话 —— 而「我们是不是系统性报高」永远答不了。\n\n" +
    "两个偏差都给：总体的，和**只看失标的**。后者有用得多 ——" +
    "中标的那些天然贴着成交价（成交价往往就是我们的价）。\n" +
    "样本数一并下发：一个样本算出来的「系统性报高 21%」" +
    "和二十个样本算出来的，不是一回事。",
  response: BidReview
});

define({
  id: "createBid", method: "post", path: "/v1/bids",
  layer: "L1", context: CTX, status: 201, action: "bid",
  summary: "登记一次投标",
  description:
    "报价与当时测算的人天**两个都要记**：只记价格的话，事后没法回答" +
    "「是人天估多了还是费率高了」，而这两条要采取的行动完全不同。",
  body: z.object({
    sponsor: z.string().trim().min(2).max(80),
    name: z.string().trim().min(2).max(120),
    submittedOn: DateOnly,
    sites: z.int().min(1).max(999),
    subjects: z.int().min(1).max(99999),
    ourQuoteCents: CentsNonNeg.min(1),
    ourPersonDays: z.number().min(0.1).max(999999),
    note: z.string().max(500).optional()
  }),
  response: Bid,
  errors: ["invariant-violated"]
});

define({
  id: "decideBid", method: "post", path: "/v1/bids/{id}:decide",
  layer: "L2", context: CTX, action: "bid",
  summary: "回写开标结果",
  description:
    "**这一步不做，前面所有的报价测算都白算。**\n" +
    "中标必须填成交价 —— 那个数就在合同上。\n" +
    "失标可以不填：问不到对方报了多少是常态，而" +
    "**「不知道」不能记成「和我们一样」** —— 后者会把偏差算成 0，" +
    "于是一次输得很惨的标在统计上毫无痕迹。",
  params: ById,
  body: z.object({
    result: z.enum(["won", "lost"]),
    winningPriceCents: CentsNonNeg.min(1).nullable().optional()
      .describe("中标必填；失标可空 —— 空表示问不到，不表示与我方同价"),
    note: z.string().max(500).optional()
  }),
  response: commandResult(Bid),
  errors: ["invariant-violated", "idempotency-key-reused"]
});

/* ── 合同变更 ───────────────────────────────────────────────────── */

define({
  id: "listContractChanges", method: "get", path: "/v1/contract-changes",
  layer: "L1", context: CTX,
  summary: "合同变更台账",
  description:
    "亏损第一大原因是入组延迟，**第二大就是 scope creep 没有变更单**。\n" +
    "就算最终要不到钱也必须记下来 —— 下次报价时这就是该加进去的成本。\n\n" +
    "`affectedSubjects` 与 `totalPersonDays` 都是**算出来的，不存**：" +
    "一条「每例多 1.5 人天」的变更真正可怕的地方是入组越多白做的越多，" +
    "存一个数会把它冻在提出那天。",
  query: PageQuery.extend({
    studyId: Uuid.optional(),
    studySiteId: Uuid.optional(),
    status: z.array(ChangeStatus).optional(),
    /** 只看没有对应金额的 —— 这一页真正要盯的就是它们。 */
    uncoveredOnly: QueryBool.optional()
  }),
  response: page(ContractChange)
});

define({
  id: "getScopeCreep", method: "get", path: "/v1/contract-changes/scope-creep",
  layer: "L1", context: CTX,
  summary: "未覆盖的工作量",
  description:
    "已经在做、但没有对应金额的活，折成人天和钱。\n" +
    "三种都算：**还没提、提了没签、明确不给钱**。已签署的不算 ——" +
    "哪怕金额是 0：那是谈过之后的决定，不是欠账。",
  response: ScopeCreep
});

define({
  id: "createContractChange", method: "post", path: "/v1/contract-changes",
  layer: "L1", context: CTX, status: 201, action: "bid",
  summary: "登记一张变更单",
  description:
    "**先记下来，再去谈。** 顺序反过来的话，谈不成的那些就永远不进系统，" +
    "而它们恰恰是最该被记住的 —— 下次报价时要加进去的正是它们。",
  body: z.object({
    studyId: Uuid,
    studySiteId: Uuid.nullable().optional()
      .describe("为空 = 全项目的变更（周期延长、中心增减）"),
    kind: ChangeKind,
    raisedOn: DateOnly,
    what: z.string().trim().min(4).max(500),
    personDaysImpact: z.number().min(-99999).max(99999),
    perSubject: z.boolean(),
    note: z.string().max(500).optional()
  }),
  response: ContractChange,
  errors: ["invariant-violated"]
});

define({
  id: "settleContractChange", method: "post",
  path: "/v1/contract-changes/{id}:settle",
  layer: "L2", context: CTX, action: "bid",
  summary: "推进变更单",
  description:
    "提交 → 签署 / 未获批。\n" +
    "**签署必须填金额，哪怕是 0。** 0 和不填差别极大：" +
    "0 是「谈过了，对方不给钱，我们认了」，不填是「还没谈」——" +
    "前者是决策，后者是欠账，而只有后者该出现在未覆盖工作量里。",
  params: ById,
  body: z.object({
    status: z.enum(["submitted", "signed", "rejected"]),
    settledCents: z.number().int().min(-99999999999).max(99999999999)
      .nullable().optional()
      .describe("签署必填（可为 0 或负数）；其余状态忽略"),
    note: z.string().max(500).optional()
  }),
  response: commandResult(ContractChange),
  errors: ["invariant-violated", "idempotency-key-reused"]
});

/* 报价模型**没有端点**。
   它是一套纯算式（`@sitedesk/calc` 的 `quote()`），输入是滑块上的参数，
   费率来自现行费率卡（`listRateCards`），历史基线来自 `listPnl` ——
   两条端点都已经有了。

   为它再开一条 `POST /v1/quote` 只会让同一套口径有两个入口，
   而计算引擎独立成一层的理由正是"前后端共用同一份实现"。
   真要落库的是**报出去的价**（投标），不是每一次拖动滑块。 */
export const _bizdevContext = CTX;
