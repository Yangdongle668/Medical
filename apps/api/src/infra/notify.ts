import { Injectable } from "@nestjs/common";
import { ctx } from "./ctx.js";
import { emit } from "./log.js";
import { LoginDelivery, type Channel } from "./login-delivery.js";

/* ════════════════════════════════════════════════════════════════════
   业务通知（欠账 D5：交接不发通知）。

   ── 为什么交接必须发通知 ──────────────────────────────────────────
   交接是**发起人单方面做的动作**：他填了表单、勾了清单、点了发起。
   而接手人在此之前完全不知道有这回事 —— 系统里多了一笔单子，
   界面上多了几个中心，但没有任何人告诉他。

   于是"交接"这件事实际发生的地方是微信群，系统只是事后记账。
   而记账这件事的价值，恰恰依赖于它和现实同步。

   ── 三条边界 ──────────────────────────────────────────────────────
   ① **发不出去不影响命令成功。** 通知失败就是通知失败，
      它不该让一笔已经写进库的交接回滚 —— 那是拿一个更小的问题
      去制造一个更大的问题。
   ② **在提交之后发。** 事务里发的话，人可能在数据落库之前就点进来，
      看到一个还不存在的东西。
   ③ **收件地址由服务端解析。** 与登录链接同一条规矩：
      只认 `auth_identity` 里登记的那个。
   ════════════════════════════════════════════════════════════════════ */

export interface Notice {
  /** 收件人账号 */
  accountId: string;
  subject: string;
  text: string;
}

@Injectable()
export class NotifyService {
  constructor(private readonly delivery: LoginDelivery) {}

  /** 排一条通知，**在本次事务提交之后**送出去。
   *
   *  收件地址在**这里**（事务里）就查好，钩子里只剩"发"这一件事。
   *  这不是优化：`afterCommit` 跑的时候连接已经归还了，
   *  在钩子里查库会拿到一个已经不属于自己的 client ——
   *  而那种错只在通知这条路径上出现，日志里看到的是"提交后的动作失败"，
   *  指不到是谁写错了。
   *
   *  不返回 Promise 给调用方 await —— 那会让业务代码有机会
   *  "等通知发完再返回"，而那正是不该发生的耦合。 */
  queue(n: Notice): void {
    const c = ctx();
    const pending = this.destination(n.accountId);
    c.afterCommit.push(async () => {
      try {
        const dest = await pending;
        if (!dest) {
          /* 没登记地址：运维该去补的一件事，而它在响应里看不见 ——
             不写日志的话，"某个人从来收不到通知"就没有任何线索。 */
          emit("warn", "notify", "收件人没有登记收件地址，通知未发出",
            { accountId: n.accountId, subject: n.subject });
          return;
        }
        const how = await this.delivery.notify({
          channel: dest.channel, to: dest.address, subject: n.subject, text: n.text
        });
        if (how === "no-transport")
          emit("warn", "notify", "没有配置对应的投递通道，通知未发出",
            { channel: dest.channel, subject: n.subject });
      } catch (e) {
        /* 通知失败不该让一笔已经写进库的业务动作回滚。
           这里吞掉异常，但**必须留声音** —— 静默失败等于没有通知系统。 */
        emit("error", "notify", "通知投递失败",
          { subject: n.subject, err: e instanceof Error ? e.message : String(e) });
      }
    });
  }

  /** 收件地址只认库里登记的那个（与登录链接同源）。 */
  private async destination(
    accountId: string
  ): Promise<{ channel: Channel; address: string } | null> {
    /* 走 owner 权限的函数：收件人未必在发起人的行范围里，
       而 auth_identity 的 RLS 只放行本人。 */
    const { rows } = await ctx().client.query<{ channel: Channel; address: string }>(
      "SELECT channel, address FROM app.login_destination($1)", [accountId]);
    return rows[0] ?? null;
  }
}
