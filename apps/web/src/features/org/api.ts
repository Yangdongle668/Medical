import { z } from "zod";
import { Account as AccountSchema } from "@sitedesk/contracts";
import { call } from "../../api/client.js";

/* 「组织与权限」用到的读写。集中在这里而不是散在组件里 ——
   这一页有三个视角，每个视角改完都要把另外两个的计数刷新，
   取数散开的话，"改完角色人员数没变"这类不一致会一处一处地长出来。 */

export interface Role {
  id: string; code: string; name: string; isExternal: boolean;
  rowRule: string; visibleFields: string[]; allowedActions: string[]; modules: string[];
}
export interface Team {
  id: string; code: string; name: string;
  lead: { id: string; displayName: string } | null;
  memberCount: number; studyCount: number;
}
/* 账号的形状**来自契约**，不在这里再写一份接口 ——
   写一份的代价刚刚付过：服务端给 Account 加了「进得来吗」那两个字段，
   而前端这份副本不会因此报错，只会永远看不见它们。 */
export type Account = z.infer<typeof AccountSchema>;

export const listAccounts = () =>
  call<{ items: Account[] }>("listAccounts", { query: { limit: 200 } });
export const listRoles = () => call<{ items: Role[] }>("listRoles");
export const listTeams = () => call<{ items: Team[] }>("listTeams");

export const createAccount = (b: {
  login: string; displayName: string; roleId: string;
  teamId?: string | null; orgRef?: string | null;
}) => call<Account>("createAccount", { body: b });

export const updateAccount = (id: string, b: {
  roleId?: string; teamId?: string | null; orgRef?: string | null; reason: string;
}) => call<Account>("updateAccount", { params: { id }, body: b });

export const disableAccount = (id: string, reason: string) =>
  call("disableAccount", { params: { id }, body: { reason } });

export const enableAccount = (id: string, reason: string) =>
  call("enableAccount", { params: { id }, body: { reason } });

export const setAccountPassword = (id: string, password: string, reason: string) =>
  call("setAccountPassword", { params: { id }, body: { password, reason } });

export const createTeam = (b: { code: string; name: string; leadAccountId?: string | null }) =>
  call<Team>("createTeam", { body: b });

export const updateRole = (id: string, b: {
  rowRule?: string; visibleFields?: string[]; allowedActions?: string[];
  modules?: string[]; reason: string;
}) => call<Role>("updateRolePermissions", { params: { id }, body: b });

/** 行范围规则的说明。和数据库 row_rule 表、契约里的 RowRule 是同一套。 */
export const ROW_RULE: Record<string, string> = {
  all: "全部中心", team: "本组承接的项目", assigned: "被指派的中心",
  hospital: "本院承接的项目", pi: "本人担任研究者的中心", none: "无数据范围"
};
/** 需要 orgRef 才切得出行的那条规则 —— 没有它，人登得进来一行都看不到。 */
export const NEEDS_ORG_REF = "hospital";

/* 动作与列的中文名都来自契约 —— **这里不再抄一份**。
   抄的那份曾经只有 13 条（契约有 18），于是权限矩阵上
   `accept` / `audit` / `capaWrite` / `isfWrite` / `monitor` 没有那一格：
   管理员想给 QA 加内部稽查，点不到，也不报错。
   契约里的 ACTION_LABEL 用 ActionKey 定型，漏一个编译不过。 */
export { ACTION_LABEL, FIELD_LABEL } from "@sitedesk/contracts";
