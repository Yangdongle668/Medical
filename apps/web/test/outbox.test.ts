import { describe, it, expect, beforeEach } from "vitest";
import {
  enqueue, head, snapshot, markSent, markFailed, requeue, discard,
  pendingCommand, subscribe
} from "../src/api/outbox.js";

/* ════════════════════════════════════════════════════════════════════
   发件箱的队列逻辑 —— e2e 够不着的那一层。

   界面那一层已经被两套测试盖住（e2e 打 mock、integration 打真库），
   但有一条**结构上就验不到**：重复入队会被折叠。
   因为界面在第一次入队之后就把那一格变成"待发"且勾不动了 ——
   人点不了第二次，测试自然也点不了。

   而判重恰恰是不能只靠界面的：界面是"不让它发生"，
   队列这一层是"发生了也不出错"。两道都要在，
   所以这一条只能在这里直接验。
   ════════════════════════════════════════════════════════════════════ */

const OK = "completeStartupItem";          // L2：契约里必须带幂等键
const L1_WRITE = "createStudySite";        // L1 写入：现在也带得了键，可以排队
const NOT_QUEUEABLE = "redeemMagicLink";   // auth：排一次登录没有意义，也不该被重放

const A = { accountId: "acc-a", accountName: "凌远" };
const B = { accountId: "acc-b", accountName: "吴桐" };
const cmd = (over: Record<string, unknown> = {}) => ({
  ...A, operationId: OK, label: "启动清单：伦理批件归档",
  idempotencyKey: "key-1", params: { id: "item-1" }, ...over
});

beforeEach(() => localStorage.clear());

describe("能带幂等键的写入才进得了队列", () => {
  it("L2 命令可以入队", () => {
    expect(enqueue(cmd()).operationId).toBe(OK);
  });

  it("**L1 的写入现在也能入队** —— 它们已经带得了幂等键", () => {
    /* 这条线原来画在"是不是 L2"上，于是断网时填的那条工时、建的那个
       受试者直接抛错丢掉。判据改成"能不能带幂等键"之后它们进得来了 ——
       而重放安全仍然由那把键保证，不是由分层保证。 */
    expect(enqueue(cmd({ operationId: L1_WRITE })).operationId).toBe(L1_WRITE);
  });

  it("登录相关的端点仍然进不去 —— 排一次登录没有意义，也不该被重放", () => {
    expect(() => enqueue(cmd({ operationId: NOT_QUEUEABLE })))
      .toThrow(/不能进发件箱/);
  });
});

describe("重复入队会被折叠", () => {
  it("同一条命令入两次，队列里只有一条，且用的是**第一次那把**幂等键", () => {
    const first = enqueue(cmd({ idempotencyKey: "key-first" }));
    const again = enqueue(cmd({ idempotencyKey: "key-second" }));

    expect(snapshot().pending).toHaveLength(1);
    expect(again.seq).toBe(first.seq);
    /* 关键：不能换新键。换了键，服务端看到的就是两条不同的命令 ——
       而幂等键防的是"同一条命令发两遍"，防不了"生成了两条命令"。 */
    expect(again.idempotencyKey).toBe("key-first");
  });

  it("参数不同就不是同一条命令，照常入队", () => {
    enqueue(cmd({ params: { id: "item-1" } }));
    enqueue(cmd({ params: { id: "item-2" }, idempotencyKey: "key-2" }));
    expect(snapshot().pending).toHaveLength(2);
  });

  it("同一条命令、不同的人 —— 不折叠", () => {
    /* 共用电脑上 A 排了队、A 的会话没了、B 登录了。
       把两个人的活折叠成一条，等于把其中一个人的活删了。 */
    enqueue(cmd());
    enqueue(cmd({ ...B, idempotencyKey: "key-b" }));
    expect(snapshot().pending).toHaveLength(2);
  });

  it("已经挪进「需要处理」的那条不参与折叠", () => {
    /* 那条要人来决定，重新发起是一次**新的尝试**。 */
    const it1 = enqueue(cmd());
    markFailed(it1.seq, { code: "conflict", title: "冲突", at: "now" });
    expect(snapshot().pending).toHaveLength(0);

    enqueue(cmd({ idempotencyKey: "key-retry" }));
    expect(snapshot().pending).toHaveLength(1);
    expect(snapshot().failed).toHaveLength(1);
  });
});

describe("顺序与状态流转", () => {
  it("严格 FIFO：队头是先排的那条", () => {
    const a = enqueue(cmd({ params: { id: "x" } }));
    enqueue(cmd({ params: { id: "y" }, idempotencyKey: "k2" }));
    expect(head()!.seq).toBe(a.seq);
  });

  it("4xx 挪进「需要处理」，后面的继续走", () => {
    /* 不堵死整条队列：一条超窗未填原因的命令永远不会自己变成功，
       堵在队头就把后面所有的活一起卡住了。 */
    const a = enqueue(cmd({ params: { id: "x" } }));
    const b = enqueue(cmd({ params: { id: "y" }, idempotencyKey: "k2" }));
    markFailed(a.seq, { code: "validation-failed", title: "缺原因", at: "now" });
    expect(head()!.seq).toBe(b.seq);
  });

  it("重新入队保留原来那把幂等键，但拿一个新序号", () => {
    const a = enqueue(cmd());
    markFailed(a.seq, { code: "conflict", title: "冲突", at: "now" });
    requeue(a.seq);

    const [back] = snapshot().pending;
    expect(back!.idempotencyKey).toBe(a.idempotencyKey);   // 键不能变
    expect(back!.seq).toBeGreaterThan(a.seq);              // 排到队尾
    expect(back!.failure).toBeUndefined();
    expect(snapshot().failed).toHaveLength(0);
  });

  it("发送成功就出队；人工丢弃只作用于失败项", () => {
    const a = enqueue(cmd());
    markSent(a.seq);
    expect(snapshot().pending).toHaveLength(0);

    const b = enqueue(cmd({ idempotencyKey: "k2" }));
    markFailed(b.seq, { code: "x", title: "y", at: "now" });
    discard(b.seq);
    expect(snapshot().failed).toHaveLength(0);
  });
});

describe("界面要问得到的东西", () => {
  it("pendingCommand 能按 operationId + params 找到待发的那一条", () => {
    enqueue(cmd({ params: { id: "item-9" } }));
    expect(pendingCommand(OK, { id: "item-9" })).toBeTruthy();
    expect(pendingCommand(OK, { id: "item-8" })).toBeUndefined();
  });

  it("**只认本人排的那条** —— 共用电脑上队列里可能躺着上一个人的活", () => {
    /* 把别人的活显示成"你刚勾的"，他会以为自己已经做过了。
       医院示教室那台机器，上一个人是谁没人说得准。 */
    enqueue({ ...B, operationId: OK, label: "别人的活",
      idempotencyKey: "key-b", params: { id: "item-7" } });
    expect(pendingCommand(OK, { id: "item-7" })).toBeTruthy();          // 不过滤时看得到
    expect(pendingCommand(OK, { id: "item-7" }, A.accountId)).toBeUndefined();
    expect(pendingCommand(OK, { id: "item-7" }, B.accountId)).toBeTruthy();
  });

  it("订阅时立刻收到一次当前快照", () => {
    enqueue(cmd());
    let seen = -1;
    const off = subscribe(s => { seen = s.pending.length; });
    expect(seen).toBe(1);
    off();
  });
});

describe("localStorage 不可用时", () => {
  it("读不出来就退回空队列，且**不清空存储** —— 那可能是别人的活", () => {
    localStorage.setItem("sitedesk.outbox", "{ 这不是 JSON");
    expect(snapshot().pending).toEqual([]);
    expect(localStorage.getItem("sitedesk.outbox")).toBe("{ 这不是 JSON");
  });
});
