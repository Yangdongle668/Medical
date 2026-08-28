/* ════════════════════════════════════════════════════════════════════
   模块登记表 —— 45 个模块，导航与路由都从这里长出来。

   ── 为什么要有这张表 ──────────────────────────────────────────────
   在此之前侧栏是六项写死的数组。而**谁看得到哪些模块**这件事，
   库里早就有答案了（`role_module`，随 `/v1/me` 一起下发）——
   写死的导航等于把那张表的结论丢掉重猜一遍，而且猜得更少：
   经营层在库里有 19 个模块，界面上只给 6 个。

   于是"老板在组织与权限里勾掉一个模块，导航立刻少一项"这件事，
   原型里成立，这边不成立。这张表把它接回去。

   ── 它不是安全边界 ────────────────────────────────────────────────
   和 role_module 一样：**收敛导航，不是安全边界**。
   安全边界是行 × 列 × 动作那三维，在服务端。
   有人手敲一个没授予的模块路径，页面会打开，但接口一行数据都不给他。
   这正是该有的分工 —— 把可见性做成前端的事，才是真的危险。

   ── 标题与分组照抄原型 ────────────────────────────────────────────
   来源是 `prototype/parts/04-nav.html` 的 `N` / `MOD_GROUP` / `GROUP_ORDER`。
   照抄不是偷懒：原型是冻结的需求基线，两处对不上时错的是这边。
   ════════════════════════════════════════════════════════════════════ */

export const GROUP_ORDER = [
  "我的工作", "项目周期", "现场", "经营", "商务",
  "资源", "财务", "质量", "机构办公室", "研究者", "系统"
] as const;
export type Group = (typeof GROUP_ORDER)[number];

export interface ModuleDef {
  /** role_module.module_key —— 和库里、和原型里是同一个字符串 */
  key: string;
  title: string;
  group: Group;
  /** 路由路径。已经建好的页面沿用原来的路径，免得旧链接与测试一起断。 */
  path: string;
  /** 这一页还没建。导航照出，点进去是一张说明它将来长什么样的页。 */
  todo?: string;
}

/** `todo` 里写的是**这一页要回答什么问题**，不是"敬请期待"。
 *  一句"功能开发中"对用户毫无用处，对接手的人更没用 ——
 *  他要知道的是这一页该有什么，而那件事只有现在写得出来。 */
export const MODULES: ModuleDef[] = [
  /* ── 我的工作 ─────────────────────────────────────────────────── */
  { key: "crc", title: "我的一天", group: "我的工作", path: "/today" },
  { key: "cra", title: "我的一天", group: "我的工作", path: "/today" },
  { key: "pm", title: "团队工作台", group: "我的工作", path: "/pm",
    todo: "本组承接的项目、各中心的入组与偏差、组内谁手上活最满。行范围是 team。" },
  { key: "dm", title: "数据管理工作台", group: "我的工作", path: "/dm",
    todo: "全部项目的质疑总量、超期未回复的、待关闭的。DM 的行范围是 all。" },
  { key: "mysite", title: "我的中心", group: "我的工作", path: "/sites" },
  { key: "mysites", title: "我的中心", group: "我的工作", path: "/sites" },
  { key: "sched", title: "我的日程", group: "我的工作", path: "/sched",
    todo: "未来两周的访视与监查排期，按天铺开，标出同一天撞车的。" },
  { key: "subj", title: "受试者访视窗口", group: "我的工作", path: "/subjects",
    todo: "在组受试者一人一行，最近一次访视的窗口状态。超窗的排在最上面。" },
  { key: "query", title: "数据质疑", group: "我的工作", path: "/queries",
    todo: "EDC 质疑台账：谁提的、待谁回、超期多久。CRC 看本中心，DM 看全部。" },
  { key: "team", title: "我的团队", group: "我的工作", path: "/team",
    todo: "组内成员、各自的中心与在手工时、谁快超载了。" },
  { key: "approve", title: "待我审批", group: "我的工作", path: "/approvals",
    todo: "待审工时、差旅、方案偏离。审批不能审自己填的 —— 那条规则在库里（迁移 0023）。" },

  /* ── 项目周期 ─────────────────────────────────────────────────── */
  { key: "startup", title: "中心启动清单", group: "项目周期", path: "/startup",
    todo: "按中心列启动清单完成度。单个中心的清单页已经有了（/sites/:id/startup），这里是汇总。" },
  { key: "prescreen", title: "预筛登记", group: "项目周期", path: "/prescreen",
    todo: "预筛人数、通过率、失败原因分布 —— 筛选漏斗最上面那一段。" },
  { key: "ethics", title: "伦理事务", group: "项目周期", path: "/ethics",
    todo: "各中心伦理批件的状态与到期日。快到期而没续的要红。" },
  { key: "handover", title: "交接", group: "项目周期", path: "/handovers" },

  /* ── 现场 ─────────────────────────────────────────────────────── */
  { key: "isf", title: "中心文件与物资", group: "现场", path: "/isf",
    todo: "ISF 文件清单与缺件、现场物资库存。" },
  { key: "material", title: "药品与样本", group: "现场", path: "/material",
    todo: "药品发放/回收/销毁的账实核对，样本采集与外送。账实不平的要顶到最上面。" },
  { key: "pay", title: "受试者补偿", group: "现场", path: "/payments",
    todo: "每次访视产生的补偿，按受试者与状态列出。已产生未发放的是重点。" },

  /* ── 经营 ─────────────────────────────────────────────────────── */
  { key: "dash", title: "经营驾驶舱", group: "经营", path: "/dash",
    todo: "在手项目、在组人数、本月确认收入与毛利、需要现在动手的几件事。" },
  { key: "intake", title: "立项与建档", group: "经营", path: "/intake",
    todo: "待受理的立项申请：申办方、适应症、预算、要不要接。" },
  { key: "sites", title: "项目 · 中心台账", group: "经营", path: "/sites" },
  { key: "enr", title: "入组进度", group: "经营", path: "/enr" },
  { key: "screen", title: "筛选漏斗与筛败", group: "经营", path: "/screen" },
  { key: "client", title: "客户", group: "经营", path: "/clients",
    todo: "申办方档案：在手项目、累计合同额、回款情况。" },
  { key: "cash", title: "现金流预测", group: "经营", path: "/cash",
    todo: "未来六个月的收支预测，累计为负的月份要红。" },

  /* ── 商务 ─────────────────────────────────────────────────────── */
  { key: "feas", title: "中心可行性调查", group: "商务", path: "/feas",
    todo: "候选中心的病例量、竞争试验、启动周期，用来决定要不要选它。" },
  { key: "price", title: "报价模型", group: "商务", path: "/price",
    todo: "单例报价的拆解：人天成本、管理费、毛利率。费率卡在 /rate-cards。" },
  { key: "bid", title: "投标与报价闭环", group: "商务", path: "/bid",
    todo: "投出去的标：报价、结果、赢的输的各是什么价位。" },
  { key: "change", title: "合同变更", group: "商务", path: "/change",
    todo: "变更单：从提出到签署，以及它对合同额与毛利的影响。" },

  /* ── 资源 ─────────────────────────────────────────────────────── */
  { key: "staff", title: "派工与产能", group: "资源", path: "/staff" },
  { key: "people", title: "人才梯队", group: "资源", path: "/people",
    todo: "在职情况、能力标签、离职风险 —— 高风险的要提前看见。" },
  { key: "time", title: "工时与差旅", group: "资源", path: "/timesheets" },

  /* ── 财务 ─────────────────────────────────────────────────────── */
  { key: "pnl", title: "成本与毛利", group: "财务", path: "/pnl",
    todo: "按项目/中心的收入、成本、毛利。单个中心的损益页已经有了（/sites/:id/pnl）。" },
  { key: "bill", title: "里程碑 · 结算", group: "财务", path: "/bill",
    todo: "合同里程碑的达成与开票状态，逾期未收的排在前面。" },

  /* ── 质量 ─────────────────────────────────────────────────────── */
  { key: "qa", title: "质量事件与 CAPA", group: "质量", path: "/quality" },
  { key: "mon", title: "监查访视", group: "质量", path: "/monitoring",
    todo: "监查计划与实际、每次访视的发现项、逾期未监查的中心。" },
  { key: "audit", title: "内部稽查", group: "质量", path: "/audit",
    todo: "稽查计划、发现项与关闭情况。" },
  /* capa 与 qa 是同一本台账的两个说法：qa 是"全部质量事件"，
     capa 是"指到我名下要整改的那些"。指向同一页 —— 行范围本来就把
     CRC 收在自己那几个中心上。
     **还差一层**：按负责人再筛一次（原型里 capa 是 own === 本人）。
     没做完不写 todo，是因为 todo 会让整页变成一张说明页，
     而这一页现在是真的能用的；缺的那一层记在这里，别记在用户眼前。 */
  { key: "capa", title: "我的整改", group: "质量", path: "/quality" },
  { key: "trail", title: "审计轨迹", group: "质量", path: "/trail" },

  /* ── 机构办公室（外部） ───────────────────────────────────────── */
  { key: "inst", title: "机构工作台", group: "机构办公室", path: "/inst",
    todo: "本院承接的项目一览。行范围是 hospital，由 account.org_ref 推导。" },
  { key: "instac", title: "立项受理", group: "机构办公室", path: "/inst/intake",
    todo: "递到本院的立项申请，受理与退回。" },
  { key: "instqc", title: "机构质控", group: "机构办公室", path: "/inst/qc",
    todo: "本院发起的质控检查与发现项。" },
  { key: "instreg", title: "人员备案与准入", group: "机构办公室", path: "/inst/registry",
    todo: "研究者与 CRC 的备案状态、GCP 证书有效期。" },

  /* ── 研究者（外部） ───────────────────────────────────────────── */
  { key: "pi", title: "研究者工作台", group: "研究者", path: "/pi",
    todo: "本人担任 PI 的中心、等着他确认的访视。行范围是 pi。" },

  /* ── 系统 ─────────────────────────────────────────────────────── */
  { key: "org", title: "组织与权限", group: "系统", path: "/org" }
];

const BY_KEY = new Map(MODULES.map(m => [m.key, m]));
export const moduleOf = (key: string): ModuleDef | undefined => BY_KEY.get(key);

/** 把 `/v1/me` 给的模块清单排成侧栏。
 *
 *  两件事在这里发生，都不该散到组件里去：
 *  ① **同一个路径去重**。crc 与 cra 都叫「我的一天」都指向 /today，
 *     mysite / mysites / sites 都指向 /sites —— 一个人同时拿到两把钥匙时
 *     （管理员就是），侧栏不该出现两行一模一样的链接。
 *  ② 库里没见过的 module_key 直接丢掉，不报错。那通常是有人在
 *     组织与权限里手敲了一个键，或者原型加了模块而这边还没跟上；
 *     两种情况都不该让侧栏崩掉。 */
export function navFor(moduleKeys: readonly string[]): { group: Group; items: ModuleDef[] }[] {
  const seenPath = new Set<string>();
  const byGroup = new Map<Group, ModuleDef[]>();
  for (const key of moduleKeys) {
    const m = BY_KEY.get(key);
    if (!m || seenPath.has(m.path)) continue;
    seenPath.add(m.path);
    byGroup.set(m.group, [...(byGroup.get(m.group) ?? []), m]);
  }
  return GROUP_ORDER
    .filter(g => byGroup.has(g))
    .map(g => ({ group: g, items: byGroup.get(g)! }));
}
