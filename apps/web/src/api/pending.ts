import { useEffect, useState } from "react";
import { pendingCommand, subscribe, type OutboxItem } from "./outbox.js";
import { queueOwner } from "./client.js";

/* 「这一行正在待发」—— 一个给所有写入页共用的问法。
 *
 *  ── 为什么需要它 ────────────────────────────────────────────────────
 *  队列层的去重是全局的（同一条命令重复入队会被折叠），
 *  但**界面上看不看得见**是另一回事：在此之前只有启动清单一页画得出
 *  行内的"待发"，其余写入页断网时只有侧栏那条全局提示。
 *  于是它们还留着"再点一次"的空间 —— 靠 enqueue 折叠兜住，
 *  而兜住不等于不该发生：人点第二次的时候，他以为第一次没成。
 *
 *  `pendingCommand()` 早就写好了，只是**一个调用方都没有** —— 死代码。
 *  这个 hook 把它接上，并且让每个页面用同一种问法，
 *  而不是各自再写一遍"从快照里筛出属于我这一行的那条"。
 */

/** 返回一个查询函数：给操作 id 与路径参数，答"它是不是正躺在待发队列里"。
 *  队列一变就重渲染 —— 断网点一下、恢复联网发出去，行上的字要跟着走。 */
export function usePending(): (
  operationId: string, params?: Record<string, string | number>
) => OutboxItem | undefined {
  const [, bump] = useState(0);
  useEffect(() => subscribe(() => bump(n => n + 1)), []);
  /* 只认**本人**排的那条 —— 共用电脑上队列里可能有上一个人的活。 */
  return (operationId, params) =>
    pendingCommand(operationId, params, queueOwner()?.accountId ?? "\u0000无人");
}
