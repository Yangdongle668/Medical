import { z } from "zod";

/* ════════════════════════════════════════════════════════════════════
   动作权限 —— 三维权限里的「动作」那一维。

   放在 kernel 而不是 identity 下，与 `kernel/fields.ts` 对称：
   端点注册表要用它给 `action` 定型，而 registry 是 kernel 的东西。

   **这份清单必须与库里的 `action_key` 表逐一一致**，由 db/test 双向断言钉住。

   它曾经落后了五个动作（`subjRead` / `subjWrite` / `piConfirm` /
   `timeWrite` / `rateWrite`）。端点上照常写着 `action: "timeWrite"`，
   守卫也照常在强制，所以运行时看不出任何异常 ——
   漏掉的是**类型与契约文档**这一侧，症状有两个：

   ① `GET /v1/me` 的响应里带着 schema 里不存在的取值 ——
      拿 OpenAPI 做校验的调用方会判它不合法，而服务端自己不会报错；
   ② `updateRolePermissions` 的 `allowedActions` 用的是同一个枚举，
      于是**这五个动作根本没法通过 API 授予** ——
      权限管理界面少了五行，而不是报错。

   两个症状都不会自己响。只有断言防得住。
   ════════════════════════════════════════════════════════════════════ */

export const ACTION_KEYS = [
  "accept", "advance", "approve", "audit", "bid", "capaWrite", "closeQ", "closeQA",
  "ethics", "isfWrite", "manage", "monitor", "piConfirm", "raiseQ", "rateWrite",
  "subjRead", "subjWrite", "timeWrite"
] as const;

export const ActionKey = z.enum(ACTION_KEYS).meta({ id: "ActionKey" });
export type ActionKey = (typeof ACTION_KEYS)[number];

/** 十八个动作的中文名。**放在契约里，与 ACTION_KEYS 并排** ——
 *
 *  上一版这份表在前端（`apps/web/src/features/org/api.ts`），只有 13 条。
 *  「组织与权限」的动作矩阵是按它出列的，于是 `accept` / `audit` /
 *  `capaWrite` / `isfWrite` / `monitor` **在界面上没有那一格**：
 *  管理员想给 QA 加内部稽查、给 CRC 加监查访视，点不到，也不报错。
 *
 *  这正是本文件开头记的那次事故的翻版 —— 那次是契约枚举落后五个，
 *  这次是前端的副本落后五个。症状一样：**少了几行，而不是报错。**
 *
 *  下面的 Record 用 ActionKey 定型：漏一个动作编译不过，
 *  而不是等到有人发现界面上少了一列。 */
export const ACTION_LABEL: Record<ActionKey, string> = {
  accept: "受理立项材料（机构）",
  advance: "推进中心阶段",
  approve: "审批工时 / 差旅 / 偏离",
  audit: "发起内部稽查",
  bid: "维护报价与投标",
  capaWrite: "填写质量整改措施",
  closeQ: "关闭数据质疑",
  closeQA: "关闭质量事件",
  ethics: "递交伦理事务",
  isfWrite: "维护中心文件与物资",
  manage: "管理人员与权限",
  monitor: "排期与执行监查访视",
  piConfirm: "PI 确认访视",
  raiseQ: "发起数据质疑",
  rateWrite: "维护费率卡",
  subjRead: "查看受试者明细",
  subjWrite: "登记受试者与访视",
  timeWrite: "填报与作废工时"
};
