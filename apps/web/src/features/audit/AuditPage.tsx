import { useEffect, useState } from "react";
import { call } from "../../api/client.js";

/* ════════════════════════════════════════════════════════════════════
   审计轨迹。

   四个 W：谁 / 何时 / 改了什么 / 为什么。**第四个是这里的重点** ——
   前三个别的系统也有，而"为什么"是核查时真正被问的那一栏，
   它由数据库约束强制（改权限、停用账号这类操作没有理由就写不进去）。

   ── 默认只看敏感操作 ──────────────────────────────────────────────
   全量轨迹里 99% 是日常写入（填了一条工时、勾了一项任务）。
   把它们和"谁给谁开了什么权限"混在一起按时间倒排，
   后者就永远在第三页之后 —— 而后者才是有人来查这一页的原因。

   全量随时切得回来，就在上面那个开关。
   ════════════════════════════════════════════════════════════════════ */

interface Entry {
  id: string; at: string; actorLogin: string; actorRoleCode: string;
  action: string; targetType: string; targetId: string;
  before: unknown; after: unknown;
  studySiteId: string | null; reason: string | null; isSensitive: boolean;
}

export function AuditPage() {
  const [items, setItems] = useState<Entry[] | null>(null);
  const [sensitiveOnly, setSensitiveOnly] = useState(true);
  const [actor, setActor] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    setItems(null);
    void call<{ items: Entry[] }>("listAuditEntries", {
      query: {
        limit: 100,
        /* 显式传 false，不靠"不传"。QueryBool 认得 false ——
           而"不传等于 false"这种约定，下一个加筛选的人不会知道。 */
        sensitiveOnly,
        ...(actor.trim() ? { actorLogin: actor.trim() } : {})
      }
    }).then(r => setItems(r.items));
  }, [sensitiveOnly, actor]);

  return (
    <>
      <div className="page-head">
        <h2>审计轨迹</h2>
        <p>谁 / 何时 / 改了什么 / <b>为什么</b>。最后一个由数据库约束强制，不是可填可不填。</p>
      </div>

      <div className="row" style={{ gap: 14, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
        <label className="row" style={{ gap: 6, alignItems: "center" }}>
          <input type="checkbox" style={{ width: "auto" }} checked={sensitiveOnly}
            data-testid="sensitive-only" onChange={e => setSensitiveOnly(e.target.checked)} />
          <span>只看权限类变更</span>
        </label>
        <label className="field" style={{ maxWidth: 220 }}>
          <span>操作人（登录名）</span>
          <input value={actor} data-testid="actor-filter" className="mono"
            onChange={e => setActor(e.target.value)} placeholder="例如 lingyuan" />
        </label>
      </div>

      {items === null ? <p className="muted">加载中…</p>
        : items.length === 0 ? (
          <p className="muted" data-testid="audit-empty">
            没有符合条件的条目。{sensitiveOnly && "权限类变更本来就该是少数 —— 把上面那个勾去掉看全量。"}
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>原因</th><th /></tr>
              </thead>
              <tbody>
                {items.map(e => (
                  <FragmentRow key={e.id} e={e} open={open === e.id}
                    onToggle={() => setOpen(open === e.id ? null : e.id)} />
                ))}
              </tbody>
            </table>
          </div>
        )}

      <div className="derive" style={{ marginTop: 14 }}>
        默认只看权限类变更。全量轨迹里绝大多数是日常写入（填一条工时、勾一项任务），
        和「谁给谁开了什么权限」混在一起按时间倒排的话，
        后者永远在第三页之后 —— 而后者才是有人来查这一页的原因。
        <br />
        <b>角色是当时的快照</b>（`actorRoleCode`），不随他后来转岗而变：
        "他当时是以什么身份做的这件事"，改了角色之后就再也复原不了。
        <br />
        这张表只追加，不可改删 —— 界面上没有编辑，是因为接口里也没有。
      </div>
    </>
  );
}

function FragmentRow({ e, open, onToggle }:
  { e: Entry; open: boolean; onToggle: () => void }) {
  const changed = e.before !== null || e.after !== null;
  return (
    <>
      <tr data-testid="audit-row">
        <td className="mono muted">{e.at.slice(0, 16).replace("T", " ")}</td>
        <td>
          <span className="mono">{e.actorLogin}</span>
          {/* 当时的角色，不是现在的 */}
          <div className="muted" style={{ fontSize: 11 }}>{e.actorRoleCode}</div>
        </td>
        <td>
          {e.action}
          {e.isSensitive && <span className="chip warn" style={{ marginLeft: 6 }}>敏感</span>}
        </td>
        <td className="muted">
          {e.targetType} <span className="mono">{e.targetId}</span>
        </td>
        <td>{e.reason ?? <span className="muted">—</span>}</td>
        <td>
          {changed && (
            <button className="btn" data-testid="audit-diff" onClick={onToggle}>
              {open ? "收起" : "改了什么"}
            </button>
          )}
        </td>
      </tr>
      {open && changed && (
        <tr>
          <td colSpan={6}>
            <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
              <Side title="改之前" v={e.before} />
              <Side title="改之后" v={e.after} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/** 前后两份原样铺开。**不做差异高亮** —— 这两份是任意形状的 JSON
 *  （角色的三维授予、账号的归属、中心的状态），
 *  猜一套通用的差异算法出来，猜错的那几次正好落在最需要看清楚的地方。 */
function Side({ title, v }: { title: string; v: unknown }) {
  return (
    <div className="card" style={{ flex: "1 1 280px", minWidth: 0 }}>
      <div className="muted" style={{ marginBottom: 6 }}>{title}</div>
      {v === null
        ? <span className="muted">（无）</span>
        : <pre className="mono" style={{
            margin: 0, fontSize: 11.5, whiteSpace: "pre-wrap", wordBreak: "break-word"
          }}>{JSON.stringify(v, null, 2)}</pre>}
    </div>
  );
}
