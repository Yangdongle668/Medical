import { useEffect, useState } from "react";
import { STARTUP_CATEGORIES, STARTUP_CATEGORY_LABEL } from "@sitedesk/contracts";
import { useToast } from "@sitedesk/ui/react";
import { call, ApiError, type ProblemDetails } from "../../api/client.js";

/* ════════════════════════════════════════════════════════════════════
   启动清单模板 —— 决定每个**新**中心怎么启动的那份清单。

   ── 为什么它此前没有界面 ────────────────────────────────────────
   `getStartupTemplate` 与 `replaceStartupTemplate` 都在服务端跑着，
   前端一个都没调。于是那份清单是什么样，只有直接读库才知道 ——
   而它决定了此后每一个新中心开工前要做哪十几件事。

   ── 改它不影响在途中心 ─────────────────────────────────────────
   清单在**建档那一刻**铺开成行，此后与模板无关。所以这一页要说清楚：
   改完只对之后建的中心生效，眼下卡着的那几个不会因此少一项。
   不说清楚的话，会有人指望改模板去解一个具体中心的锁。

   ── 版本号加一，旧版本不删 ─────────────────────────────────────
   中心的 `startupTemplateVersion` 要指得回去，
   否则「这个中心当初是照着什么铺的」就没有答案 —— 而核查会问这个。

   ── 整份替换，不是逐条增删 ─────────────────────────────────────
   所以这个编辑器一次编辑全部条目，提交时整份发出去。
   逐条 PATCH 看起来更省事，但那样就没有"某一版模板"这个东西了。
   ════════════════════════════════════════════════════════════════════ */

interface Item {
  sortOrder: number; category: string; item: string;
  isBlocking: boolean; dueOffset: number;
}
interface Template {
  version: number; items: Item[];
  updatedAt: string | null; updatedByName: string | null; reason: string | null;
}

export function StartupTemplateEditor({ canManage }: { canManage: boolean }) {
  const [tpl, setTpl] = useState<Template | null>(null);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const say = useToast();

  const load = () => void call<Template>("getStartupTemplate")
    .then(setTpl).catch(() => setTpl(null));
  useEffect(load, []);

  if (!tpl) return null;

  const start = () => {
    setItems(tpl.items.map(i => ({ ...i })));
    setReason(""); setProblem(null); setOpen(true);
  };

  const set = (i: number, patch: Partial<Item>) =>
    setItems(v => v.map((x, k) => k === i ? { ...x, ...patch } : x));

  const add = () => setItems(v => [...v, {
    sortOrder: v.length, category: "ethics", item: "", isBlocking: false, dueOffset: -14
  }]);

  const del = (i: number) =>
    setItems(v => v.filter((_, k) => k !== i).map((x, k) => ({ ...x, sortOrder: k })));

  const ready = items.length >= 1
    && items.every(i => i.item.trim().length >= 1)
    && reason.trim().length >= 4;

  async function publish() {
    setBusy(true); setProblem(null);
    try {
      const r = await call<{ data: Template; sideEffects: { summary: string }[] }>(
        "replaceStartupTemplate", {
          body: {
            items: items.map((i, k) => ({
              sortOrder: k, category: i.category, item: i.item.trim(),
              isBlocking: i.isBlocking, dueOffset: i.dueOffset
            })),
            reason: reason.trim()
          }
        });
      setTpl(r.data);
      setOpen(false);
      say(r.sideEffects[0]?.summary ?? `启动清单模板已发布第 ${r.data.version} 版`);
    } catch (e) {
      if (e instanceof ApiError) setProblem(e.problem); else throw e;
    } finally { setBusy(false); }
  }

  const blocking = (open ? items : tpl.items).filter(i => i.isBlocking).length;

  return (
    <section className="card" data-testid="startup-template" style={{ marginBottom: 22 }}>
      <div className="card-h">
        <h3>启动清单模板</h3>
        <span className="sub">
          第 <b className="num">{tpl.version}</b> 版 ·
          {" "}{tpl.items.length} 项，其中 {blocking} 项阻塞
          {tpl.updatedByName && <> · {tpl.updatedByName} 于 {tpl.updatedAt?.slice(0, 10)} 发布</>}
        </span>
        <span className="sp" />
        {canManage && (open
          ? <button className="btn link" data-testid="tpl-cancel"
              onClick={() => { setOpen(false); setProblem(null); }}>取消</button>
          : <button className="btn" data-testid="tpl-edit" onClick={start}>改这份模板</button>)}
      </div>

      <div className="card-b stack">
        {tpl.reason && !open && (
          <p className="note" style={{ margin: 0 }} data-testid="tpl-reason">
            上一版变更理由：{tpl.reason}
          </p>
        )}

        <div className="derive" data-testid="tpl-scope">
          <b>改它不影响在途中心。</b>
          清单在<b>建档那一刻</b>铺开成行，此后与模板无关 ——
          所以改完只对之后建的中心生效，眼下卡着的那几个不会因此少一项。
          <br />
          版本号加一，<b>旧版本不删</b>：中心要指得回它当初是照着哪一版铺的，
          而核查会问这个。
        </div>

        {problem && (
          <div className="problem" data-testid="tpl-problem">
            <strong>{problem.title}</strong>
            {problem.detail && <div>{problem.detail}</div>}
          </div>
        )}

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>分类</th><th>事项</th><th>阻塞</th>
                <th>相对 SIV</th>{open && <th />}
              </tr>
            </thead>
            <tbody>
              {(open ? items : tpl.items).map((i, k) => (
                <tr key={k} data-testid="tpl-row">
                  <td>
                    {open
                      ? <select value={i.category} data-testid={`tpl-cat-${k}`}
                          onChange={e => set(k, { category: e.target.value })}>
                          {STARTUP_CATEGORIES.map(c => (
                            <option key={c} value={c}>{STARTUP_CATEGORY_LABEL[c]}</option>
                          ))}
                        </select>
                      : <span className="chip flat">
                          {STARTUP_CATEGORY_LABEL[
                            i.category as keyof typeof STARTUP_CATEGORY_LABEL] ?? i.category}
                        </span>}
                  </td>
                  <td>
                    {open
                      ? <input value={i.item} data-testid={`tpl-item-${k}`}
                          aria-label={`第 ${k + 1} 项`}
                          onChange={e => set(k, { item: e.target.value })} />
                      : i.item}
                  </td>
                  <td>
                    {open
                      ? <input type="checkbox" checked={i.isBlocking} style={{ width: "auto" }}
                          data-testid={`tpl-block-${k}`} aria-label={`第 ${k + 1} 项是否阻塞`}
                          onChange={e => set(k, { isBlocking: e.target.checked })} />
                      : i.isBlocking
                        ? <span className="chip warn">阻塞</span>
                        : <span className="t-mut">—</span>}
                  </td>
                  <td className="tnum">
                    {open
                      ? <input type="number" value={i.dueOffset} style={{ width: 90 }}
                          data-testid={`tpl-due-${k}`} aria-label={`第 ${k + 1} 项相对 SIV 天数`}
                          onChange={e => set(k, { dueOffset: Number(e.target.value) })} />
                      : <>{i.dueOffset > 0 ? "+" : ""}{i.dueOffset} 天</>}
                  </td>
                  {open && (
                    <td>
                      <button className="btn link" data-testid={`tpl-del-${k}`}
                        onClick={() => del(k)}>删除</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {open && (
          <>
            <div className="row">
              <button className="btn" data-testid="tpl-add" onClick={add}>加一项</button>
              <span className="note">
                阻塞项决定这个中心能不能推进到 SIV —— 勾之前想清楚它是不是真的必须。
              </span>
            </div>

            <label className="field">
              <span>
                变更理由 <span className="t-mut">· 至少 4 字，进变更史</span>
              </span>
              <textarea rows={2} value={reason} data-testid="tpl-reason-input"
                placeholder="例：新增「研究者资质审查表」为阻塞项 —— 上一轮核查提出三个中心缺这一份。"
                onChange={e => setReason(e.target.value)} />
            </label>

            <div className="row">
              <button className="btn btn-p" data-testid="tpl-publish"
                disabled={!ready || busy} onClick={() => void publish()}>
                {busy ? "发布中…" : `发布第 ${tpl.version + 1} 版`}
              </button>
              <span className="note">
                整份替换 —— 逐条改看起来更省事，但那样就没有「某一版模板」这个东西了。
              </span>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
