import { call } from "../../api/client.js";
import type { SUBJECT_STATES } from "@sitedesk/contracts";

/** 受试者状态的键 —— 契约里那个枚举的类型。 */
type SubjectState = (typeof SUBJECT_STATES)[number];

/* 受试者相关的读写。四页共用（受试者窗口 / 预筛登记 / 补偿 / 中心详情）——
   分散在各页各写一份的话，"筛选号有没有权限"这类判断会各判各的。 */

export interface Visit {
  id: string; seq: number; visitCode: string; visitLabel: string;
  targetDate: string; windowFrom: string; windowTo: string;
  daysLeft: number; outOfWindow: boolean;
}
export interface Subject {
  id: string; studySiteId: string; siteCode: string;
  /** 受列权限管辖：**没权限时这个字段不在**，不是 null。 */
  screeningNo?: string;
  randomized: boolean; randomizationNo?: string;
  /** **用契约的类型，不用 `string`** —— 状态中文名表是
   *  `Record<SubjectState, string>`，`string` 索引它编译不过；
   *  而把表放宽成 `Record<string, string>` 就等于放弃了"少一个状态
   *  编译就红"这件事。窄的是这一头，不是那一头。 */
  state: SubjectState;
  icfSignedOn: string | null; enrolledOn: string | null; exitedOn: string | null;
  screenFailReason: string | null; withdrawReason: string | null;
  crcName: string | null;
  visitsDone: number; visitsPlanned: number;
  nextVisit: Visit | null;
}

export interface Payment {
  id: string; studySiteId: string; siteCode: string;
  subjectId: string; screeningNo?: string;
  visitId: string | null; visitLabel: string | null;
  amountCents: number; dueOn: string;
  paidOn: string | null; receiptRef: string | null; ageDays: number;
}

/* 状态中文名从契约来，**这里不另抄一份** —— 它有第三个读者了
   （mock 的补排访视也要说「受试者当前是「预筛」」）。 */
export { SUBJECT_STATE_LABEL as STATE_LABEL } from "@sitedesk/contracts";
/** 还在流程里的 —— 这几种才有"下一次访视"。 */
export const OPEN_STATES = ["prescreen", "screening", "enrolled"];

export const listSubjects = (q: Record<string, unknown> = {}) =>
  call<{ items: Subject[] }>("listSubjects", { query: { limit: 200, ...q } });

/** 筛选号省略即由服务端按中心发号（SS-16-P001）。 */
export const createSubject = (studySiteId: string, screeningNo?: string) =>
  call<Subject>("createSubject", {
    body: { studySiteId, ...(screeningNo ? { screeningNo } : {}) } });

export const signIcf = (id: string, signedOn: string) =>
  call<{ data: Subject }>("signIcf", { params: { id }, body: { signedOn } });

export const screenFail = (id: string, reason: string, failedOn: string, note?: string) =>
  call<{ data: Subject }>("screenFailSubject",
    { params: { id }, body: { reason, failedOn, ...(note ? { note } : {}) } });

export const enroll = (id: string, randomizationNo: string, enrolledOn: string) =>
  call<{ data: Subject }>("enrollSubject",
    { params: { id }, body: { randomizationNo, enrolledOn } });

/** 补排一次访视。**不带 seq —— 服务端按 SOA 算"该排的下一次"。**
 *
 *  界面自己算这个数的话，界面就得有一份 SOA 的规则，而那正是两份规则
 *  各走各的开始。这里只发"给他补排"，排哪一次由唯一有 SOA 的那一侧说。 */
export const scheduleVisit = (id: string) =>
  call<{ data: Visit; sideEffects: { summary: string }[] }>(
    "scheduleSubjectVisit", { params: { id }, body: {} });

export const listPayments = (unpaid: boolean) =>
  call<{ items: Payment[] }>("listSubjectPayments",
    { query: { limit: 200, ...(unpaid ? { unpaid: true } : {}) } });

export const pay = (id: string, paidOn: string, receiptRef: string) =>
  call<{ data: Payment }>("paySubjectPayment",
    { params: { id }, body: { paidOn, receiptRef } });

/* today 住在 shell/dates.ts —— 和 daysSince 在一起。
   日期这类东西散成两份，迟早有一份用的是本地时区、另一份用 UTC。 */
export { today } from "../../shell/dates.js";

/** 「筛选号看不看得到」由**数据**回答，不由角色判断 ——
 *  后端把无权限的字段删掉了，这里就少一列，仅此而已。 */
export const anonymous = (s: { screeningNo?: string }) => s.screeningNo === undefined;
