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
export interface Account {
  id: string; login: string; displayName: string;
  role: { id: string; code: string; name: string; isExternal: boolean };
  team: { id: string; code: string; name: string } | null;
  isExternal: boolean; orgRef: string | null;
  status: "active" | "disabled";
  joinedOn: string | null; disabledAt: string | null; disabledReason: string | null;
  lastLoginAt: string | null;
}

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

export const FIELD_LABEL: Record<string, string> = {
  cost: "成本与人天", margin: "毛利与利润率", price: "报价与合同金额",
  subject: "受试者筛选号", staff: "员工薪资口径"
};
export const ACTION_LABEL: Record<string, string> = {
  approve: "审批工时 / 差旅 / 偏离", closeQA: "关闭质量事件",
  raiseQ: "发起数据质疑", closeQ: "关闭数据质疑",
  advance: "推进中心阶段", manage: "管理人员与权限",
  bid: "维护报价与投标", ethics: "递交伦理事务",
  subjRead: "查看受试者明细", subjWrite: "登记受试者与访视",
  piConfirm: "PI 确认访视", timeWrite: "填报与作废工时", rateWrite: "维护费率卡"
};
