import { allEndpoints } from "@sitedesk/contracts";

/* ════════════════════════════════════════════════════════════════════
   发件箱 —— CRC 在医院地下室没有信号。

   这是本项目从一开始就写在需求里的场景，而在 Phase 7 之前，
   它的表现是**最糟的那一种**：`fetch` 抛出网络错误，页面的
   `catch (e) { if (e instanceof ApiError) … else throw e }` 把它再抛出去，
   落进一个没人接的 promise —— 按钮从"提交中…"弹回来，
   没有报错，没有提示，那次访视就这么没了。
   **静默丢失比报错糟得多**：报错至少会让人再点一次。

   ── 三条设计决定 ────────────────────────────────────────────────

   ① **只排 L2。**
      L2 命令按契约必须带幂等键，所以重放是安全的。
      L1 的那几个 POST（建档、发起交接、填工时、开费率卡）**没有**幂等键 ——
      把它们排进队列，一次重放就可能变成两条记录。
      这条线不是省事，是契约本来就画好的：能重放的才排队。

   ② **幂等键在「尝试之前」生成并落盘，重放时用同一把。**
      client 里那个兜底生成的 `crypto.randomUUID()` 只防"忘了传"；
      防不了重复提交 —— 每次重放都换一把新键，服务端看到的就是
      两条不同的命令。**这是整个 Phase 7 的关键一行。**

   ③ **按账号隔离。**
      令牌存在 sessionStorage（关掉标签页就断开，因为医院示教室那台
      机器上一个人是谁没人说得准），而队列必须活得比标签页久 ——
      于是必然出现"A 排了队、A 的会话没了、B 登录了"这种局面。
      把 A 的命令用 B 的会话发出去，审计轨迹上就成了 B 做的。
      所以每条都记 accountId，**不是本人就不发**，也不丢弃 ——
      丢弃等于把人家的活删了。等 A 回来自己发。
   ════════════════════════════════════════════════════════════════════ */

const KEY = "sitedesk.outbox";
/** 只有 L2 才允许入队 —— 由契约判定，不靠调用方自觉。 */
/* 能进发件箱的端点。
 *
 *  判据不是"是不是 L2"，是**能不能带幂等键** —— 那才是重放安全的前提。
 *  原来这里只放 L2，于是 L1 的那几个创建端点（填工时、建受试者、
 *  建交接单）在断网时进不了队列：人做的活抛个错就没了。
 *  现在它们也带键了（服务端那侧是可选的幂等外壳，见 infra/command.ts），
 *  所以一起放进来。
 *
 *  auth 的几个端点除外：排一次登录没有意义，而且登录**本来就不该**被重放。
 *  GET 也不在里面 —— 读操作重放的是读，不需要队列。 */
const QUEUEABLE = new Set(allEndpoints()
  .filter(e => e.layer === "L2" || (e.method !== "get" && e.context !== "auth"))
  .map(e => e.id));

export interface OutboxItem {
  /** 单调递增，决定重放顺序。先勾任务再完成访视，顺序错了就不是同一件事。 */
  seq: number;
  accountId: string;
  accountName: string;
  operationId: string;
  params?: Record<string, string | number>;
  query?: Record<string, unknown>;
  body?: unknown;
  /** **落盘的那一把**。重放必须用它，不能重新生成。 */
  idempotencyKey: string;
  /** 面向人的一句话：发件箱里要看得出这条是什么，而不是一个 operationId */
  label: string;
  createdAt: string;
  attempts: number;
  /** 服务端明确拒绝（4xx）时记下来，并从待发队列挪进"需要处理"。
   *
   *  `hint` 是**针对离线这件事**的一句话。服务端的原话（title/detail）
   *  说的是"版本冲突"，它不知道这条命令在队列里躺了两个小时 ——
   *  而那两个小时才是用户需要的上下文：不是他填错了，是这中间有人动过。 */
  failure?: {
    code: string; title: string; detail?: string; at: string;
    hint?: string; queuedMs?: number;
  };
}

interface Snapshot { pending: OutboxItem[]; failed: OutboxItem[] }

const EMPTY: Snapshot = { pending: [], failed: [] };

function read(): Snapshot {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const v = JSON.parse(raw) as Snapshot;
    return { pending: v.pending ?? [], failed: v.failed ?? [] };
  } catch {
    /* 隐私模式下 localStorage 会抛；解析失败也走这里。
       退回空队列 —— 但**不清空存储**：那可能是别人的活。 */
    return EMPTY;
  }
}

function write(s: Snapshot) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); }
  catch { /* 存不下就只在内存里活着，刷新即失效 —— 已经比静默丢失好 */ }
  emit(s);
}

/* ── 订阅：侧栏的待发数量要跟着变 ───────────────────────────────── */
type Listener = (s: Snapshot) => void;
const listeners = new Set<Listener>();
const emit = (s: Snapshot) => { for (const f of listeners) f(s); };

export function subscribe(f: Listener): () => void {
  listeners.add(f);
  f(read());
  return () => { listeners.delete(f); };
}

export const snapshot = (): Snapshot => read();

let seqCounter = 0;
/** 单调序号：用时间戳打底，同一毫秒内再递增，保证同一次会话里严格有序。 */
function nextSeq(): number {
  const now = Date.now();
  seqCounter = now > seqCounter ? now : seqCounter + 1;
  return seqCounter;
}

/** 同一条命令是否已经在待发队列里。
 *
 *  「同一条」= 同一个人 + 同一个 operationId + 同样的 params/query/body。
 *  用 JSON.stringify 比：这些对象都由同一段代码拼出来，键序是稳定的；
 *  真要跨版本比较得排序键，但那是过度设计 —— 队列活不过一次发布。 */
function sameCommand(a: Pick<OutboxItem, "accountId" | "operationId" | "params" | "query" | "body">,
                     b: typeof a): boolean {
  const j = (v: unknown) => JSON.stringify(v ?? null);
  return a.accountId === b.accountId
    && a.operationId === b.operationId
    && j(a.params) === j(b.params)
    && j(a.query) === j(b.query)
    && j(a.body) === j(b.body);
}

/** 待发队列里这条命令的那一项（给界面用：行上要显示"待发"）。
 *
 *  `accountId` 不是可选的装饰：共用电脑上队列里可能躺着**上一个人**的活，
 *  把它显示成"你刚勾的"是骗人 —— 而他会以为自己已经做过了。
 *  给了就只认那个人的，不给就不过滤（调用方自己清楚为什么）。 */
export function pendingCommand(
  operationId: string,
  params?: Record<string, string | number>,
  accountId?: string
): OutboxItem | undefined {
  return read().pending.find(i =>
    i.operationId === operationId
    && (accountId === undefined || i.accountId === accountId)
    && JSON.stringify(i.params ?? null) === JSON.stringify(params ?? null));
}

/** 入队。返回落盘的那一条 —— 调用方据此告诉用户"已排队"。
 *
 *  **重复入队会被折叠。** 断网时人最自然的动作是：勾一下没反应，再勾一下。
 *  两次点击就是两条命令、两把不同的幂等键 —— 服务端看到的是两件事，
 *  而幂等键**保护不了这种重复**：它防的是"同一条命令发了两遍",
 *  防不了"生成了两条命令"。第二条在这个例子里被
 *  conflict-version 挡下（清单项已完成），看起来还行；
 *  换成一条可以合法重复的命令，那就是实实在在的两笔。
 *
 *  所以判重放在入队这一层：待发队列里已有同一条命令时，
 *  返回原来那一条（连同它原来的幂等键），不新增。
 *  已经挪进"需要处理"的不算 —— 那条需要人来决定，
 *  重新发起是一次新的尝试。 */
export function enqueue(input: {
  accountId: string; accountName: string;
  operationId: string; label: string;
  params?: Record<string, string | number>;
  query?: Record<string, unknown>;
  body?: unknown;
  idempotencyKey: string;
}): OutboxItem {
  if (!QUEUEABLE.has(input.operationId))
    throw new Error(`${input.operationId} 不能进发件箱 —— ` +
      "只有带得了幂等键的写入才能重放，否则一次重放就可能记两笔");

  const s = read();
  const dup = s.pending.find(i => sameCommand(i, input));
  if (dup) return dup;

  const item: OutboxItem = {
    seq: nextSeq(), createdAt: new Date().toISOString(), attempts: 0, ...input
  };
  write({ ...s, pending: [...s.pending, item].sort((a, b) => a.seq - b.seq) });
  return item;
}

/** 队头 —— 严格 FIFO，不许跳过。 */
export const head = (): OutboxItem | undefined => read().pending[0];

export function markSent(seq: number) {
  const s = read();
  write({ ...s, pending: s.pending.filter(i => i.seq !== seq) });
}

/** 网络或 5xx：留在队头，只累加尝试次数。 */
export function markRetry(seq: number) {
  const s = read();
  write({
    ...s,
    pending: s.pending.map(i => i.seq === seq ? { ...i, attempts: i.attempts + 1 } : i)
  });
}

/** 服务端明确拒绝（4xx）：挪进"需要处理"，让后面的继续走。
 *
 *  为什么不堵死整条队列：一条超窗未填原因的访视永远不会自己变成功，
 *  堵在队头就把后面所有的活一起卡住了。
 *  为什么也不能悄悄丢：那是一次真实发生过的工作，人得知道它没进系统。 */
export function markFailed(
  seq: number, failure: NonNullable<OutboxItem["failure"]>
) {
  const s = read();
  const item = s.pending.find(i => i.seq === seq);
  if (!item) return;
  write({
    pending: s.pending.filter(i => i.seq !== seq),
    failed: [...s.failed, { ...item, failure }]
  });
}

/** 人工丢弃一条失败项 —— 只有人能做这个决定。 */
export function discard(seq: number) {
  const s = read();
  write({ ...s, failed: s.failed.filter(i => i.seq !== seq) });
}

/** 把一条失败项放回队尾重试（例如人已经在别处把前置条件补上了）。 */
export function requeue(seq: number) {
  const s = read();
  const item = s.failed.find(i => i.seq === seq);
  if (!item) return;
  const { failure: _drop, ...rest } = item;
  write({
    pending: [...s.pending, { ...rest, seq: nextSeq(), attempts: 0 }]
      .sort((a, b) => a.seq - b.seq),
    failed: s.failed.filter(i => i.seq !== seq)
  });
}
