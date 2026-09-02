/* ════════════════════════════════════════════════════════════════════
   mock 身份。`?as=inst` 换一个人看同一套页面。

   ── 为什么外部两个身份必须在这里 ──────────────────────────────────
   这四页（研究者工作台 / 机构工作台 / 机构质控 / 人员备案）
   存在的全部理由是**行范围比内部窄**：
   PI 只看自己签字的中心，机构办只看本院。

   "窄"这件事，只有真的换过去看一眼才发现得了 ——
   少了哪几行、哪个按钮点不动、哪一列整个不画。
   mock 里扮不了外部角色，那四页就只是画得出来，一句话也说不出。

   ── 与迁移 0026 逐字同源 ──────────────────────────────────────────
   actions / fields / modules 三项抄的是 `app.provision_tenant()` 里的
   角色目录。抹平任何一条，界面上最要紧的差别就在 mock 上消失了，
   而真库上一登录就撞见。
   ════════════════════════════════════════════════════════════════════ */

import type { FieldKey, ActionKey } from "@sitedesk/contracts";

export const MOCK_ROLES = ["crc", "cra", "boss", "dm", "inst", "pi"] as const;
export type MockRole = (typeof MOCK_ROLES)[number];

export interface MockIdentity {
  id: string; login: string; name: string;
  role: { id: string; code: string; name: string };
  isExternal: boolean;
  /** 外部方的机构归属。`hospital` 行范围按它匹配医院名。 */
  orgRef: string | null;
  rowRule: string;
  /* 用契约的键类型，不用 string[]：拼错一个字段名要在**编译期**红，
     而不是等到 maskFields 悄悄少删一列。 */
  fields: readonly FieldKey[];
  actions: readonly ActionKey[];
  modules: readonly string[];
}

export const IDENTITIES: Record<MockRole, MockIdentity> = {
  crc: {
    id: "a-wutong", login: "wutong", name: "吴桐",
    role: { id: "r-crc", code: "crc", name: "临床协调员 CRC" },
    isExternal: false, orgRef: null,
    rowRule: "assigned", fields: ["subject"],
    actions: ["ethics", "subjRead", "subjWrite", "timeWrite"],
    /* **module_key，不是路径。** 这里曾经写的是 ["today","sites",…]，
       而真接口给的是 role_module 里的键 —— 两者恰好长得像，
       所以在导航还是写死数组的时候看不出区别。侧栏改成按模块出之后，
       一份路径清单会让 mock 模式下的导航整个空掉。 */
    modules: ["crc", "mysite", "startup", "sched", "subj", "prescreen", "ethics",
      "query", "capa", "isf", "material", "pay", "handover", "time"]
  },
  /* **监查员 CRA。** 它是唯一握着 `monitor` 的一线角色 ——
     排监查、登记到现场、提交监查报告三件事，只有换到这个身份才点得动。
     行范围 assigned 在 mock 上演不出来（没有派工表），
     所以它看到的是全部中心 —— 这一点写在 visibleSiteIds 那里。 */
  cra: {
    id: "a-linmin", login: "linmin", name: "林敏",
    role: { id: "r-cra", code: "cra", name: "临床监查员 CRA" },
    isExternal: false, orgRef: null,
    rowRule: "assigned", fields: ["subject"],
    actions: ["monitor", "raiseQ", "subjRead", "timeWrite"],
    modules: ["cra", "mysites", "mon", "query", "screen", "feas", "material",
      "time", "qa", "capa", "trail"]
  },
  /* **数据管理 DM。** 它是这套角色里唯一握着 closeQ 的人 ——
     「中心回复了不等于问题解决了」这句话，只有换到这个身份才看得见：
     CRC 身上有回复框没有关闭键，DM 身上反过来。
     少了它，数据质疑那两页就只剩"画得出来"。 */
  dm: {
    id: "a-miaoqing", login: "miaoqing", name: "苗青",
    role: { id: "r-dm", code: "dm", name: "数据管理 DM" },
    isExternal: false, orgRef: null,
    rowRule: "all", fields: ["subject"],
    actions: ["closeQ", "raiseQ", "subjRead"],
    modules: ["dm", "query", "screen", "trail"]
  },
  boss: {
    id: "a-lingyuan", login: "lingyuan", name: "凌远",
    role: { id: "r-boss", code: "boss", name: "经营层" },
    isExternal: false, orgRef: null,
    rowRule: "all", fields: ["cost", "margin", "price", "staff"],
    actions: ["advance", "approve", "bid", "manage", "rateWrite",
      "subjRead", "timeWrite"],
    modules: ["dash", "intake", "sites", "enr", "screen", "client", "cash", "bid",
      "change", "staff", "people", "time", "pnl", "bill", "qa", "mon", "price",
      "org", "trail"]
  },
  /* 机构办：**一个动作**（关闭质量事件），没有 subjRead ——
     所以受试者那几条端点对他会 403，界面上一个都不能碰。 */
  inst: {
    id: "a-zhanghm", login: "zhanghm", name: "张慧敏",
    role: { id: "r-inst", code: "inst", name: "机构办（外部）" },
    isExternal: true, orgRef: "北京协和医院",
    rowRule: "hospital", fields: ["subject"],
    actions: ["closeQA"],
    modules: ["inst", "instac", "instqc", "instreg"]
  },
  /* PI：也是一个动作（确认访视）。他有 subjRead，
     所以看得到筛选号 —— 那是他自己中心的受试者。 */
  pi: {
    id: "a-chenguod", login: "chenguod", name: "陈国栋",
    role: { id: "r-pi", code: "pi", name: "研究者 PI（外部）" },
    isExternal: true, orgRef: "北京协和医院",
    rowRule: "pi", fields: ["subject"],
    actions: ["piConfirm", "subjRead"],
    modules: ["pi", "qa"]
  }
};
