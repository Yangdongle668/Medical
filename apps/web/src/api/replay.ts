import { call, ApiError, type OperationId } from "./client.js";
import { head, markSent, markRetry, markFailed, snapshot } from "./outbox.js";

/* ════════════════════════════════════════════════════════════════════
   重放 —— 把发件箱按**原顺序**发出去。

   三条规矩：

   ① **严格 FIFO，不许跳过。**
      「勾完第 3 项任务」和「完成这次访视」是有先后的：
      跳过前者直接发后者，服务端会以为任务没勾完而拒绝 ——
      而那次拒绝看起来像业务规则出了问题，其实是顺序被打乱了。

   ② **网络错误 / 5xx → 留在队头**，下次再来。
      服务器还没接住，重发是对的。

   ③ **4xx → 挪进「需要处理」，让后面的继续走。**
      一条超窗未填原因的访视永远不会自己变成功，堵在队头就把后面
      所有的活一起卡住了。但也不能悄悄丢 ——
      那是一次真实发生过的工作，人得知道它没进系统。

   重放用的是**入队时落盘的那把幂等键**。服务端认得它：
   同键同体重放会返回首次的结果，不会产生第二次副作用。
   所以"我到底发出去没有"这个问题，不需要用户来判断。
   ════════════════════════════════════════════════════════════════════ */

let running = false;

/** 把队列尽量清空。返回本轮成功发出的条数。
 *  同一时刻只允许一个重放在跑 —— 两个并发会打乱顺序。 */
export async function drain(me: { accountId: string } | null): Promise<number> {
  if (running || !me) return 0;
  running = true;
  let sent = 0;
  try {
    for (;;) {
      const item = head();
      if (!item) break;
      /* 不是本人就停下 —— 也不丢弃。等他自己回来发。 */
      if (item.accountId !== me.accountId) break;

      try {
        await call(item.operationId as OperationId, {
          ...(item.params ? { params: item.params } : {}),
          ...(item.query ? { query: item.query } : {}),
          ...(item.body !== undefined ? { body: item.body } : {}),
          idempotencyKey: item.idempotencyKey,
          /* 重放通道：失败就是失败，不再入队 —— 否则它会自我复制 */
          noQueue: true
        });
        markSent(item.seq);
        sent++;
      } catch (e) {
        if (e instanceof ApiError && e.problem.status >= 400 && e.problem.status < 500) {
          markFailed(item.seq, {
            code: e.problem.code, title: e.problem.title,
            ...(e.problem.detail ? { detail: e.problem.detail } : {}),
            at: new Date().toISOString()
          });
          continue;                       // 挪走了，接着发后面的
        }
        markRetry(item.seq);
        break;                            // 网络或 5xx：留在队头，下次再来
      }
    }
  } finally { running = false; }
  return sent;
}

/** 何时重放：恢复联网时、启动时、以及人手动点的时候。
 *  返回解绑函数 —— shell 卸载时要摘掉监听。 */
export function startReplay(getMe: () => { accountId: string } | null): () => void {
  const go = () => { void drain(getMe()); };
  window.addEventListener("online", go);
  /* 只在有待发时才起轮询：没有队列就不该有后台活动。
     30 秒一次 —— `online` 事件在某些环境里不可靠（代理、captive portal），
     它是兜底，不是主路径。 */
  const timer = window.setInterval(() => {
    if (snapshot().pending.length) go();
  }, 30_000);
  go();
  return () => {
    window.removeEventListener("online", go);
    window.clearInterval(timer);
  };
}
