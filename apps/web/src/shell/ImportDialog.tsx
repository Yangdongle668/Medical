import { useState } from "react";
import { Drawer } from "@sitedesk/ui/react";
import { call, ApiError, type OperationId, type ProblemDetails } from "../api/client.js";
import { downloadText, readCsvFile } from "./csv.js";

/* ════════════════════════════════════════════════════════════════════
   批量导入（W17）：下载模板 → 选文件 → 服务端试运行，逐行说能不能导 →
   确认 → 逐行执行，结果逐行显示。

   试运行**什么都不写**，放心点。执行时每行各自成败：
   第 7 行不行，不连累其他行；没导进去的那几行改好了再传一次就行 ——
   已经导进去的会被认出来（"已存在"），不会建两遍。
   ════════════════════════════════════════════════════════════════════ */

interface Row {
  line: number; status: "ok" | "error" | "done" | "failed";
  summary: string; error: string | null; screeningNo?: string | null;
}
interface Result { rows: Row[]; ok: number; bad: number }

const CHIP: Record<Row["status"], string> = { ok: "good", done: "good", error: "crit", failed: "crit" };
const TEXT: Record<Row["status"], string> = { ok: "可导入", done: "已导入", error: "不能导入", failed: "没导进去" };

export function ImportDialog({ open, onClose, onDone, title, template, previewOp, commitOp, body = {}, testid = "import" }: {
  open: boolean; onClose: () => void;
  /** 执行过之后关掉时调用 —— 页面借此重新加载列表 */
  onDone: () => void;
  title: string;
  /** name 是下载的文件名（不带扩展名），用英文 —— 中文文件名在一部分 Chromium 里会被丢掉 */
  template: { name: string; csv: string; hint: string };
  previewOp: OperationId; commitOp: OperationId;
  /** 除 csv 之外要一起带上的字段（如 studySiteId） */
  body?: Record<string, unknown>;
  testid?: string;
}) {
  const [csv, setCsv] = useState<string | null>(null);
  const [file, setFile] = useState("");
  const [res, setRes] = useState<Result | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState<"preview" | "commit" | null>(null);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);

  const reset = () => { setCsv(null); setFile(""); setRes(null); setDone(false); setProblem(null); };
  const close = () => { if (done) onDone(); reset(); onClose(); };

  const send = async (op: OperationId, text: string) => {
    setBusy(op === commitOp ? "commit" : "preview"); setProblem(null);
    try {
      const r = await call<{ data: Result }>(op, { body: { ...body, csv: text }, label: title });
      setRes(r.data);
      return true;
    } catch (e) {
      if (e instanceof ApiError) { setProblem(e.problem); return false; }
      throw e;
    } finally { setBusy(null); }
  };

  const pick = async (f: File | undefined) => {
    reset();
    if (!f) return;
    setFile(f.name);
    if (/\.(xlsx|xls)$/i.test(f.name)) {
      setProblem({ type: "", title: "请先另存为 CSV", status: 0, code: "validation-failed",
        detail: "在 Excel 里「文件 → 另存为」，类型选「CSV UTF-8（逗号分隔）」或「CSV（逗号分隔）」，再选那个 .csv 文件。" });
      return;
    }
    const text = await readCsvFile(f);
    setCsv(text);
    await send(previewOp, text);
  };

  const commit = async () => {
    if (!csv) return;
    if (await send(commitOp, csv)) setDone(true);
  };

  return (
    <Drawer open={open} onClose={close} title={title}
      sub="先试运行、逐行看过，再确认导入。试运行不写任何东西。"
      foot={
        <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
          {done
            ? <button className="btn primary" onClick={close} data-testid={`${testid}-finish`}>完成</button>
            : <>
                <button className="btn" onClick={close}>取消</button>
                <button className="btn primary" data-testid={`${testid}-commit`}
                  disabled={busy !== null || !res || res.ok === 0} onClick={() => void commit()}>
                  {res ? `导入 ${res.ok} 行` : "导入"}
                </button>
              </>}
        </div>
      }>
      <div className="stack">
        <div className="card stack">
          <div className="spread">
            <strong>① 按模板填好</strong>
            <button className="btn link" data-testid={`${testid}-template`}
              onClick={() => downloadText(`${template.name}.csv`, "﻿" + template.csv)}>
              下载模板
            </button>
          </div>
          <span className="muted">{template.hint}</span>
        </div>

        <label className="card stack">
          <strong>② 选文件</strong>
          <input type="file" accept=".csv,text/csv" data-testid={`${testid}-file`} disabled={busy !== null || done}
            onChange={e => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
          <span className="muted">
            {file ? `已选：${file}` : "Excel 里「另存为 → CSV」得到的文件。UTF-8 与中文 Windows 默认的编码都认。"}
          </span>
        </label>

        {busy && <p className="muted">{busy === "commit" ? "正在导入…" : "正在逐行检查…"}</p>}

        {problem && (
          <div className="problem stack" data-testid={`${testid}-problem`}>
            <strong>{problem.title}</strong>
            {problem.detail && <div>{problem.detail}</div>}
          </div>
        )}

        {res && (
          <>
            <p data-testid={`${testid}-summary`}>
              {done
                ? <>导入了 <b>{res.ok}</b> 行{res.bad > 0 && <>，<b>{res.bad} 行没导进去</b> —— 改好这几行再传一次，已导入的不会重复</>}。</>
                : <><b>{res.ok}</b> 行可以导入{res.bad > 0 && <>，<b>{res.bad} 行不能</b>（原因见下表，导入时会跳过）</>}。</>}
            </p>
            <div className="table-wrap">
              <table>
                <thead><tr><th>行</th><th>结果</th><th>内容</th><th>原因</th></tr></thead>
                <tbody>
                  {res.rows.map(r => (
                    <tr key={r.line} data-testid={`${testid}-row`}>
                      <td className="num">{r.line}</td>
                      <td><span className={`chip ${CHIP[r.status]}`}>{TEXT[r.status]}</span></td>
                      <td>{r.summary}{r.screeningNo && <span className="mono muted"> · {r.screeningNo}</span>}</td>
                      <td>{r.error ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Drawer>
  );
}
