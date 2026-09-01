import { call } from "../../api/client.js";

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
  state: string;
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

export const STATE_LABEL: Record<string, string> = {
  prescreen: "预筛", screening: "筛选中", enrolled: "已入组",
  screen_failed: "筛败", withdrawn: "已脱落", completed: "已出组"
};
/** 还在流程里的 —— 这几种才有"下一次访视"。 */
export const OPEN_STATES = ["prescreen", "screening", "enrolled"];

export const listSubjects = (q: Record<string, unknown> = {}) =>
  call<{ items: Subject[] }>("listSubjects", { query: { limit: 200, ...q } });

export const createSubject = (studySiteId: string, screeningNo: string) =>
  call<Subject>("createSubject", { body: { studySiteId, screeningNo } });

export const signIcf = (id: string, signedOn: string) =>
  call<{ data: Subject }>("signIcf", { params: { id }, body: { signedOn } });

export const screenFail = (id: string, reason: string, failedOn: string, note?: string) =>
  call<{ data: Subject }>("screenFailSubject",
    { params: { id }, body: { reason, failedOn, ...(note ? { note } : {}) } });

export const enroll = (id: string, randomizationNo: string, enrolledOn: string) =>
  call<{ data: Subject }>("enrollSubject",
    { params: { id }, body: { randomizationNo, enrolledOn } });

export const listPayments = (unpaid: boolean) =>
  call<{ items: Payment[] }>("listSubjectPayments",
    { query: { limit: 200, ...(unpaid ? { unpaid: true } : {}) } });

export const pay = (id: string, paidOn: string, receiptRef: string) =>
  call<{ data: Payment }>("paySubjectPayment",
    { params: { id }, body: { paidOn, receiptRef } });

export const today = () => new Date().toISOString().slice(0, 10);

/** 「筛选号看不看得到」由**数据**回答，不由角色判断 ——
 *  后端把无权限的字段删掉了，这里就少一列，仅此而已。 */
export const anonymous = (s: { screeningNo?: string }) => s.screeningNo === undefined;
