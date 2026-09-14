import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { boot, resetDb, as, type Caller } from "./harness.js";

/* ════════════════════════════════════════════════════════════════════
   一线履职：该登记的登记了没有。

   ── 这一条端点为什么存在 ──────────────────────────────────────────
   迁移 0048 与 0050 把立项受理与 PI 确认从「等院外的人在本系统里点一下」
   改成了「由院内的人带着日期登记进来」。那一步把风险换了个地方：

     原来卡住的是**别人不点** —— 看得见，因为它明晃晃地卡在那里；
     现在卡住的是**自己人没登记** —— 看不见，因为它只是没有发生。

   一件没发生的事不会出现在任何列表上，除非有人专门去数。
   而团队工作台按中心排、经营驾驶舱按问题类型排，两者都不按人排。

   ── 这一组钉四件事 ────────────────────────────────────────────────
   ① 数出来的是真的（和直接查库的结果对得上）；
   ② **行范围原样生效** —— PM 数的是本组的，比经营层少；
   ③ 外部方一行都没有；
   ④ 办掉一件，这个人的数跟着降 —— 否则这张表会一直催一件已经办完的事，
      而那正是让人学会忽略它的最快方式。
   ════════════════════════════════════════════════════════════════════ */

let app: INestApplication;
let boss: Caller, pm: Caller, admin: Caller, inst: Caller, pi: Caller;

beforeAll(async () => {
  resetDb(); app = await boot();
  boss = await as(app, "lingyuan");
  pm   = await as(app, "hanxue");
  admin = await as(app, "admin");
  inst = await as(app, "zhanghm");
  pi   = await as(app, "chenguod");
}, 180_000);
afterAll(async () => { await app?.close(); });

interface Duty {
  accountId: string; login: string; displayName: string; roleKind: string;
  pendingPiConfirm: number; edcOverdue: number; outOfWindow: number;
  acceptanceNoLetter: number; total: number; oldestDays: number | null;
}
const list = async (c: Caller, q = "") => {
  const r = await c.get(`/v1/registration-duties?limit=100${q}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.items as Duty[];
};
const sum = (d: Duty[]) => d.reduce((n, x) => n + x.total, 0);

describe("一线履职：按人排，不按中心", () => {
  it("只列在职的 CRC / CRA —— PM、QA、DM 不在这张表上", async () => {
    const items = await list(boss);
    expect(items.length).toBeGreaterThan(0);
    /* 这张表问的是"一线登记了没有"。PM 不登记访视，QA 不登记受理 ——
       把他们列进来，每一行都是 0，而 0 会把真正欠着的那几行淹掉。 */
    expect([...new Set(items.map(i => i.roleKind))].sort()).toEqual(["CRA", "CRC"]);
  });

  it("四类各自数得对，且 total 就是它们的和", async () => {
    const items = await list(boss);
    for (const i of items) {
      expect(i.total).toBe(
        i.pendingPiConfirm + i.edcOverdue + i.outOfWindow + i.acceptanceNoLetter);
      /* **一件都不欠时不许报「最久 N 天」** —— 那个数只可能来自
         一条已经办完的行，而它会让一个清白的人排到最上面。 */
      if (i.total === 0) expect(i.oldestDays, `${i.login} 不欠却报了天数`).toBeNull();
      else expect(i.oldestDays).not.toBeNull();
    }
    expect(sum(items), "演示库里应当有人欠着 —— 全 0 的话这一组测不到东西")
      .toBeGreaterThan(0);
  });

  it("**行范围原样生效**：PM 数的是本组的，比经营层少", async () => {
    const all = await list(boss);
    const mine = await list(pm);
    /* 人还是那些人（`staff` 是人事账，不按中心切），
       但**数是按各自看得见的中心数出来的**。
       两边一样多的话，说明这几个 count 没有走 RLS —— 那是一个
       会安静泄漏的口子：PM 会看到别组中心上的欠账。 */
    expect(sum(mine)).toBeLessThan(sum(all));
    expect(sum(mine)).toBeGreaterThan(0);
  });

  it("外部方一行都没有 —— 员工名册对他们整表关闭", async () => {
    expect(await list(inst)).toEqual([]);
    expect(await list(pi)).toEqual([]);
  });

  it("owingOnly 筛掉不欠的，而默认**不筛** —— 没有分母的比例说明不了什么", async () => {
    const all = await list(boss);
    const owing = await list(boss, "&owingOnly=true");
    expect(owing.every(i => i.total > 0)).toBe(true);
    expect(owing.length).toBeLessThan(all.length);
    /* 分母要留着：「十个人里两个欠着」和「两个人里两个欠着」
       是两件完全不同的事，而只列欠债的那张表说不出这个区别。 */
    expect(sum(owing)).toBe(sum(all));
  });

  it("办掉一件，这个人的数跟着降", async () => {
    /* 一直催一件已经办完的事，是让人学会忽略这张表的最快方式。

       **先挑访视、再回头找人**，不是反过来。反过来写的第一版是
       以 CRC 的身份去列访视的 —— 而他的行范围是 `assigned`，
       只看得到自己被派到的那几个中心，于是永远找不到别人名下的那一条，
       报的却是「找不到待确认的访视」，听起来像是演示数据的问题。 */
    const vs = await boss.get("/v1/subject-visits?limit=1&status=done_pending_pi");
    expect(vs.status).toBe(200);
    const v = (vs.body.items as { id: string; subjectId: string }[])[0];
    expect(v, "演示库里应当有待登记 PI 确认的访视").toBeTruthy();

    /* 这一条归谁 —— 就是 `subject.crc_account_id` 那个人，
       也正是这张表按人归的依据。 */
    const s = await boss.get(`/v1/subjects/${v!.subjectId}`);
    expect(s.status).toBe(200);
    const who = s.body.crcName as string;
    const before = (await list(boss)).find(i => i.displayName === who);
    expect(before, `${who} 应当出现在履职表上`).toBeTruthy();
    expect(before!.pendingPiConfirm).toBeGreaterThan(0);

    /* **用 admin 登记，不用 boss。** 经营层没有 `piConfirm` ——
       那是有意的：登记访视是一线的活，经营层看的是有没有人在登记。
       第一版这里写的是 boss，报 403，而那个 403 恰好证明了权限是对的。 */
    const done = await admin.post(`/v1/subject-visits/${v!.id}:confirm`, {},
      { "Idempotency-Key": crypto.randomUUID() });
    expect(done.status, JSON.stringify(done.body)).toBe(201);

    const after = (await list(boss)).find(i => i.accountId === before!.accountId)!;
    expect(after.pendingPiConfirm).toBe(before!.pendingPiConfirm - 1);
    expect(after.total).toBe(before!.total - 1);
  });
});
