import { useState, type ReactNode } from "react";
import { useToast } from "@sitedesk/ui/react";
import { ApiError, type ProblemDetails } from "../api/client.js";

/* ════════════════════════════════════════════════════════════════════
   「发起」表单的外壳。

   ── 为什么值得抽出来 ────────────────────────────────────────────
   盘点写端点时发现的规律是：每条流程「处理/判定」那一端都接了，
   **「发起」那一端没接** —— 能判定一份立项申请但提不了，
   能受理一份机构材料但交不了，能确认执行一次监查访视但排不了。

   于是要补的八九个入口长得几乎一样：一个按钮展开成一张表，
   填完提交，成了说一句、收起来、刷新列表，败了把理由留在表上。
   各页各写一遍的话，"失败到底留在哪儿"这种事就会有八九种答案。

   ── 三条固定下来的规矩 ──────────────────────────────────────────
   ① **成功用吐司，失败留在页面上。** 吐司会自己消失，而失败要人读完
      再决定下一步。这两件事的寿命不一样，所以不能用同一个东西说。
   ② **必填没齐时按钮不亮**，而不是按下去再由服务端告诉他第三栏没填 ——
      那是把一次往返用在了本可以当场说清的事上。服务端当然照样校验。
   ③ **收起来时不清空。** 手滑点了取消，填了一半的东西不该没。
      真正清空是在提交成功之后，由调用方在 onSubmit 里做。
   ════════════════════════════════════════════════════════════════════ */

export function CreateForm({
  cta, title, sub, note, ready, onSubmit, testid, children, wide
}: {
  /** 收起时那个按钮上的字。用动词 —— 「排一次监查」比「新建」说得清。 */
  cta: string;
  title: string;
  sub?: string;
  /** 提交按钮旁边那句话：说清这一下会引起什么。 */
  note?: ReactNode;
  ready: boolean;
  /** 返回一句给吐司的话。抛 ApiError 时理由留在表单上。 */
  onSubmit: () => Promise<string>;
  testid: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const say = useToast();

  async function submit() {
    setBusy(true); setProblem(null);
    try {
      say(await onSubmit());
      setOpen(false);
    } catch (e) {
      if (e instanceof ApiError) setProblem(e.problem); else throw e;
    } finally { setBusy(false); }
  }

  if (!open) {
    return (
      <button className="btn btn-p" data-testid={testid}
        onClick={() => setOpen(true)}>{cta}</button>
    );
  }

  return (
    <section className={`card${wide ? "" : ""}`} data-testid={`${testid}-form`}
      style={{ marginBottom: 22 }}>
      <div className="card-h">
        <h3>{title}</h3>
        {sub && <span className="sub">{sub}</span>}
        <span className="sp" />
        <button className="btn link" data-testid={`${testid}-cancel`}
          onClick={() => { setOpen(false); setProblem(null); }}>取消</button>
      </div>
      <div className="card-b">
        <div className="stack">
          {problem && (
            <div className="problem" data-testid={`${testid}-problem`}>
              <strong>{problem.title}</strong>
              {problem.detail && <div>{problem.detail}</div>}
            </div>
          )}
          {children}
          <div className="row">
            <button className="btn btn-p" data-testid={`${testid}-submit`}
              disabled={!ready || busy} onClick={() => void submit()}>
              {busy ? "提交中…" : cta}
            </button>
            {note && <span className="note">{note}</span>}
          </div>
        </div>
      </div>
    </section>
  );
}

/** 一栏。**标签在上、控件在下** —— 中文标签长短差得多，
 *  左右排的话控件左边缘会参差不齐，一列表单看起来像没对齐的表格。 */
export function Field({ label, v, on, testid, type, placeholder, hint }: {
  label: string; v: string; on: (v: string) => void; testid: string;
  type?: string; placeholder?: string; hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}{hint && <span className="t-mut"> · {hint}</span>}</span>
      <input value={v} type={type ?? "text"} data-testid={testid}
        placeholder={placeholder} onChange={e => on(e.target.value)} />
    </label>
  );
}

/** 多行的那种。理由、说明、发现 —— 这几样写不下一行。 */
export function Area({ label, v, on, testid, rows, placeholder, hint }: {
  label: string; v: string; on: (v: string) => void; testid: string;
  rows?: number; placeholder?: string; hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}{hint && <span className="t-mut"> · {hint}</span>}</span>
      <textarea value={v} rows={rows ?? 2} data-testid={testid}
        placeholder={placeholder} onChange={e => on(e.target.value)} />
    </label>
  );
}

/** 下拉。选项是固定集合时用它，而不是让人打字 ——
 *  打字进来的枚举值最后总要在服务端被拒一次。 */
export function Pick({ label, v, on, testid, options, hint }: {
  label: string; v: string; on: (v: string) => void; testid: string;
  options: { value: string; label: string }[]; hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}{hint && <span className="t-mut"> · {hint}</span>}</span>
      <select value={v} data-testid={testid} onChange={e => on(e.target.value)}>
        <option value="">— 选一个 —</option>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

/* ── 一行一项的清单编辑 ──────────────────────────────────────────
   监查跟进项、机构材料清单都要它：**条目是一条条的，不是一段文字**。
   做成一个 textarea 让人用换行分隔，看起来省事，但那样就没法
   单独勾掉其中一条 —— 而"缺的是哪两份"正是补正通知要写的东西。 */
export function ListEdit({ label, items, onChange, testid, placeholder, hint }: {
  label: string; items: string[]; onChange: (v: string[]) => void;
  testid: string; placeholder?: string; hint?: string;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const t = draft.trim();
    if (!t || items.includes(t)) return;
    onChange([...items, t]); setDraft("");
  };
  return (
    <div className="field">
      <span style={{ color: "var(--ink-3)", fontSize: 12 }}>
        {label}{hint && <span className="t-mut"> · {hint}</span>}
      </span>
      {items.length > 0 && (
        <ul className="tasks" data-testid={`${testid}-items`} style={{ marginTop: 6 }}>
          {items.map((t, i) => (
            <li key={t}>
              <span className="grow">{t}</span>
              <button className="btn link" aria-label={`删除「${t}」`}
                data-testid={`${testid}-del-${i}`}
                onClick={() => onChange(items.filter(x => x !== t))}>删除</button>
            </li>
          ))}
        </ul>
      )}
      <div className="row" style={{ marginTop: 6, flexWrap: "nowrap" }}>
        <input value={draft} data-testid={`${testid}-draft`} placeholder={placeholder}
          onChange={e => setDraft(e.target.value)}
          /* 回车加一条。清单是一条条敲进去的，每敲一条都要够一次鼠标
             的话，没人会认真写满那张清单。 */
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
        <button className="btn" data-testid={`${testid}-add`}
          disabled={!draft.trim()} onClick={add}>加一条</button>
      </div>
    </div>
  );
}
