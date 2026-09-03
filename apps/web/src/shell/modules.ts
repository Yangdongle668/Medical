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
  { key: "pm", title: "团队工作台", group: "我的工作", path: "/pm" },
  { key: "dm", title: "数据管理工作台", group: "我的工作", path: "/dm" },
  { key: "mysite", title: "我的中心", group: "我的工作", path: "/sites" },
  { key: "mysites", title: "我的中心", group: "我的工作", path: "/sites" },
  { key: "sched", title: "我的日程", group: "我的工作", path: "/sched" },
  { key: "subj", title: "受试者访视窗口", group: "我的工作", path: "/subjects" },
  { key: "query", title: "数据质疑", group: "我的工作", path: "/queries" },
  { key: "team", title: "我的团队", group: "我的工作", path: "/team" },
  { key: "approve", title: "待我审批", group: "我的工作", path: "/approvals" },

  /* ── 项目周期 ─────────────────────────────────────────────────── */
  { key: "startup", title: "中心启动清单", group: "项目周期", path: "/startup" },
  { key: "prescreen", title: "预筛登记", group: "项目周期", path: "/prescreen" },
  { key: "ethics", title: "伦理事务", group: "项目周期", path: "/ethics" },
  { key: "handover", title: "交接", group: "项目周期", path: "/handovers" },

  /* ── 现场 ─────────────────────────────────────────────────────── */
  { key: "isf", title: "中心文件与物资", group: "现场", path: "/isf",
    todo: "ISF 文件清单与缺件、现场物资库存。" },
  { key: "material", title: "药品与样本", group: "现场", path: "/material" },
  { key: "pay", title: "受试者补偿", group: "现场", path: "/payments" },

  /* ── 经营 ─────────────────────────────────────────────────────── */
  { key: "dash", title: "经营驾驶舱", group: "经营", path: "/dash" },
  { key: "intake", title: "立项与建档", group: "经营", path: "/intake" },
  { key: "sites", title: "项目 · 中心台账", group: "经营", path: "/sites" },
  { key: "enr", title: "入组进度", group: "经营", path: "/enr" },
  { key: "screen", title: "筛选漏斗与筛败", group: "经营", path: "/screen" },
  { key: "client", title: "客户", group: "经营", path: "/clients" },
  { key: "cash", title: "现金流预测", group: "经营", path: "/cash" },

  /* ── 商务 ─────────────────────────────────────────────────────── */
  { key: "feas", title: "中心可行性调查", group: "商务", path: "/feas" },
  { key: "price", title: "报价模型", group: "商务", path: "/price" },
  { key: "bid", title: "投标与报价闭环", group: "商务", path: "/bid" },
  { key: "change", title: "合同变更", group: "商务", path: "/change" },

  /* ── 资源 ─────────────────────────────────────────────────────── */
  { key: "staff", title: "派工与产能", group: "资源", path: "/staff" },
  { key: "people", title: "人才梯队", group: "资源", path: "/people" },
  { key: "time", title: "工时与差旅", group: "资源", path: "/timesheets" },

  /* ── 财务 ─────────────────────────────────────────────────────── */
  { key: "pnl", title: "成本与毛利", group: "财务", path: "/pnl" },
  { key: "bill", title: "里程碑 · 结算", group: "财务", path: "/bill" },

  /* ── 质量 ─────────────────────────────────────────────────────── */
  { key: "qa", title: "质量事件与 CAPA", group: "质量", path: "/quality" },
  { key: "mon", title: "监查访视", group: "质量", path: "/monitoring" },
  { key: "audit", title: "内部稽查", group: "质量", path: "/audit" },
  /* capa 与 qa 是同一本台账的两个说法：qa 是"全部质量事件"，
     capa 是"指到我名下要整改的那些"。指向同一页 —— 行范围本来就把
     CRC 收在自己那几个中心上。
     **还差一层**：按负责人再筛一次（原型里 capa 是 own === 本人）。
     没做完不写 todo，是因为 todo 会让整页变成一张说明页，
     而这一页现在是真的能用的；缺的那一层记在这里，别记在用户眼前。 */
  { key: "capa", title: "我的整改", group: "质量", path: "/quality" },
  { key: "trail", title: "审计轨迹", group: "质量", path: "/trail" },

  /* ── 机构办公室（外部） ───────────────────────────────────────── */
  { key: "inst", title: "机构工作台", group: "机构办公室", path: "/inst" },
  { key: "instac", title: "立项受理", group: "机构办公室", path: "/inst/intake",
    todo: "递到本院的立项申请，受理与退回。" },
  { key: "instqc", title: "机构质控", group: "机构办公室", path: "/inst/qc" },
  { key: "instreg", title: "人员备案与准入", group: "机构办公室", path: "/inst/registry" },

  /* ── 研究者（外部） ───────────────────────────────────────────── */
  { key: "pi", title: "研究者工作台", group: "研究者", path: "/pi" },

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
