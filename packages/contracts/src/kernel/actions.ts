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
