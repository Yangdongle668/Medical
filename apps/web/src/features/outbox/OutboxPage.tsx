import { useEffect, useState } from "react";
import { subscribe, discard, requeue, type OutboxItem } from "../../api/outbox.js";
import { drain } from "../../api/replay.js";
import { loadMe } from "../login/me.js";

/* ════════════════════════════════════════════════════════════════════
   发件箱。

   这一页存在的理由只有一句：**「我到底发出去没有」不该由用户去猜。**

   离线队列最容易做成的样子是"悄悄替你重试"，看起来很贴心 ——
   直到有人在核查现场被问「这次访视你什么时候录的」，
   而系统里那条记录的时间比他记得的晚了三小时，或者根本不在。

   所以：待发的逐条列出来，发失败的单独一栏并写明服务端说了什么，
   丢弃需要人点一下。没有一条是系统替人做主的。
   ════════════════════════════════════════════════════════════════════ */

const when = (iso: string) => iso.slice(0, 16).replace("T", " ");

export function OutboxPage() {
  const [s, setS] = useState<{ pending: OutboxItem[]; failed: OutboxItem[] }>(
    { pending: [], failed: [] });
  const [me, setMe] = useState<{ accountId: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => subscribe(setS), []);
  useEffect(() => {
    void loadMe().then(m => setMe({ accountId: m.account.id })).catch(() => setMe(null));
  }, []);

  const online = typeof navigator === "undefined" || navigator.onLine;
  /* 别人排的队：能看见、能知道是谁的，但发不了也删不了 */
  const foreign = s.pending.filter(i => me && i.accountId !== me.accountId);

  async function retryNow() {
    setBusy(true);
    try { await drain(me); } finally { setBusy(false); }
  }

  return (
    <>
      <div className="page-head">
        <h2>发件箱</h2>
        <p>
          断网时提交的命令会排在这里，联网后按<b>原顺序</b>自动发送。
          每条都带着提交那一刻生成的幂等键 —— <b>重发不会记成两笔</b>。
        </p>
      </div>

      <div className="stack" style={{ maxWidth: 820 }}>
        <div className="row spread">
          <span className={`chip ${online ? "good" : "warn"}`} data-testid="net-state">
            {online ? "已联网" : "当前离线"}
          </span>
          <div className="row" style={{ gap: 8 }}>
            <span className="muted num" data-testid="pending-count">
              待发 {s.pending.length}
            </span>
            <button className="btn" data-testid="retry-now"
              disabled={busy || !s.pending.length || !online}
              onClick={() => void retryNow()}>
              {busy ? "发送中…" : "立即发送"}
            </button>
          </div>
        </div>

        {s.pending.length === 0 && s.failed.length === 0 && (
          <p className="muted" data-testid="outbox-empty">发件箱是空的 —— 没有待发的命令。</p>
        )}

        {s.pending.length > 0 && (
          <section className="card stack" data-testid="pending-list">
            <h3>待发送</h3>
            <ol className="tasks" style={{ counterReset: "none" }}>
              {s.pending.map(i => (
                <li key={i.seq} data-testid="pending-item">
                  <span className="grow">
                    {i.label}
                    <div className="muted">
                      {when(i.createdAt)} · {i.accountName}
                      {i.attempts > 0 && ` · 已尝试 ${i.attempts} 次`}
                    </div>
                  </span>
                  {me && i.accountId !== me.accountId && (
                    <span className="chip warn" data-testid="foreign-item">别人的</span>
                  )}
                </li>
              ))}
            </ol>
            {foreign.length > 0 && (
              /* 共用电脑上必然会出现这一幕。把 A 的活用 B 的会话发出去，
                 审计轨迹上就成了 B 做的 —— 所以不发，也不删。 */
              <p className="muted" data-testid="foreign-note">
                其中 {foreign.length} 条是别人排的队。它们不会用你的账号发送 ——
                否则审计轨迹上就成了你做的。等本人登录后自己发。
              </p>
            )}
          </section>
        )}

        {s.failed.length > 0 && (
          <section className="card stack" data-testid="failed-list">
            <h3>需要处理</h3>
            <p className="muted" style={{ margin: 0 }}>
              这些命令服务端明确拒绝了，重发也不会成功。
              它们已经从队列里挪出来，不挡后面的 —— 但<b>它们没有进系统</b>。
            </p>
            {s.failed.map(i => (
              <div key={i.seq} className="problem" data-testid="failed-item">
                <strong>{i.label}</strong>
                <div>{i.failure?.title}：{i.failure?.detail}</div>
                {/* 服务端的原话不知道这条排了多久 —— 而那往往才是原因。 */}
                {i.failure?.hint && (
                  <div className="muted" data-testid="offline-hint" style={{ marginTop: 6 }}>
                    {i.failure.hint}
                  </div>
                )}
                <div className="row" style={{ marginTop: 8 }}>
                  <button className="btn" data-testid="requeue"
                    onClick={() => requeue(i.seq)}>补好了，重新发送</button>
                  <button className="btn link" data-testid="discard"
                    onClick={() => discard(i.seq)}>丢弃这条</button>
                </div>
              </div>
            ))}
          </section>
        )}
      </div>
    </>
  );
}
