import { useState } from "react";
import { call, ApiError, type ProblemDetails } from "../../api/client.js";
import { useToast } from "@sitedesk/ui/react";
import { Field } from "../../shell/CreateForm.js";
/* 「今天」取**本地**日历日，不从 UTC 的此刻里切 ——
   东八区早上八点前那八个小时，UTC 切出来的是昨天。
   见 shell/dates.ts 的长注释（测试里有一条守卫盯着这件事）。 */
import { today } from "../../shell/dates.js";

/* ════════════════════════════════════════════════════════════════════
   登记「拿到立项受理意向函」—— 一线在这条流程上的第二件事，也是最后一件。

   ── 为什么它和「予以受理」是两条路 ──────────────────────────────
   `acceptSite`（予以受理）是**机构办在本系统里点下的那一下**：
   它要先把材料清单逐项勾齐，受理人记的是系统里那个账号。

   而多数医院的机构办不在这个系统里（迁移 0038 自己写着这句话）。
   一线手里拿着的是一张纸：上面有日期，也有医院那边的签章。
   让他去走一遍"逐项勾清单再点受理"，是让他替一个不存在的用户演一遍流程。

   所以这条路只问两件事：**哪天拿到的**，以及**那张纸**。
   受理人不填 —— 医院那边是谁受理的由那张纸回答，
   填一个下拉框里挑出来的名字是编的（迁移 0048 为此放松了约束）。
   谁登记的，进审计轨迹；那两件事本来就不该混。

   ── 文件可以后补 ────────────────────────────────────────────────
   纸还没拿到手、先把日期登记上，是常事。所以 PDF 是可选的，
   而**没传时那句提醒要显眼**：核查要看的是那张纸，不是一个日期。
   ════════════════════════════════════════════════════════════════════ */

/** 与服务端、与库里的 CHECK 同一个数。三处都在，才防得住绕过前端直接打接口。 */
const MAX_BYTES = 10 * 1024 * 1024;
const kb = (n: number) => n < 1048576
  ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;

interface Letter {
  filename: string; sizeBytes: number; uploadedAt: string; uploadedByName: string;
}

export function RecordLetterForm({ acceptance, onDone, onCancel }: {
  acceptance: {
    id: string; code: string; hospital: string;
    submittedOn: string; acceptedOn: string | null; letter: Letter | null;
  };
  onDone: () => void;
  onCancel: () => void;
}) {
  const [receivedOn, setReceivedOn] = useState(acceptance.acceptedOn ?? today());
  const [file, setFile] = useState<{ name: string; size: number; b64: string } | null>(null);
  const [fileErr, setFileErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const say = useToast();

  const 将来 = receivedOn > today();
  const 早于递交 = receivedOn < acceptance.submittedOn;
  const ready = !!receivedOn && !将来 && !早于递交 && !fileErr && !busy;

  async function pick(f: File | undefined) {
    setFileErr(null); setFile(null);
    if (!f) return;
    /* 三道都在前端先走一遍 —— 不是因为服务端不判（它判），
       而是因为一次失败的上传要等整份文件传完才知道结果，
       而那几秒里人只能看着一个转圈。 */
    if (f.size > MAX_BYTES)
      return setFileErr(`这份文件 ${kb(f.size)}，超过 10 MB 上限 —— ` +
        "受理意向函是一页扫描件，这么大通常是扫描分辨率调得太高。");
    if (f.size === 0) return setFileErr("这份文件是空的（0 字节）。");
    const buf = new Uint8Array(await f.arrayBuffer());
    /* 认前五个字节，不认扩展名 —— 改个后缀不会让它变成 PDF，
       而下载的人拿到一个打不开的文件时，第一反应是"系统坏了"。 */
    if (String.fromCharCode(...buf.subarray(0, 5)) !== "%PDF-")
      return setFileErr("这不是一个 PDF 文件（开头不是 %PDF-）—— 请传扫描件的 PDF。");

    /* 分块转 base64。`String.fromCharCode(...buf)` 在几百 KB 上就会
       "Maximum call stack size exceeded" —— 而那个报错跟 PDF 毫无关系。 */
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000)
      bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    setFile({ name: f.name, size: f.size, b64: btoa(bin) });
  }

  async function save() {
    setBusy(true); setProblem(null);
    try {
      const r = await call<{ sideEffects: { summary: string }[] }>("recordAcceptanceLetter", {
        params: { id: acceptance.id },
        body: {
          receivedOn,
          ...(file ? { file: { filename: file.name, contentBase64: file.b64 } } : {})
        }
      });
      say(r.sideEffects[0]?.summary ?? "已登记");
      onDone();
    } catch (e) {
      if (e instanceof ApiError) setProblem(e.problem); else throw e;
    } finally { setBusy(false); }
  }

  return (
    <div className="card stack" data-testid="record-letter" style={{ marginTop: 12 }}>
      <div className="spread">
        <h3>
          <span className="mono">{acceptance.code}</span> · {acceptance.hospital}
          {" "}的受理意向函
        </h3>
        <button className="btn link" data-testid="rl-cancel" onClick={onCancel}>取消</button>
      </div>

      {problem && (
        <div className="problem" data-testid="rl-problem">
          <strong>{problem.title}</strong>
          {problem.detail && <div>{problem.detail}</div>}
        </div>
      )}

      <Field label="哪天拿到的" v={receivedOn} on={setReceivedOn}
        testid="rl-date" type="date"
        hint={`递交日期是 ${acceptance.submittedOn}`} />
      {将来 && (
        <span className="t-crit" data-testid="rl-date-future" style={{ fontSize: 12 }}>
          这个日期在将来 —— 这一栏记的是「哪天拿到的」，还没拿到的不用先登记。
        </span>
      )}
      {早于递交 && !将来 && (
        <span className="t-crit" data-testid="rl-date-before" style={{ fontSize: 12 }}>
          早于递交日期（{acceptance.submittedOn}）—— 受理意向函不会比材料先到。
        </span>
      )}

      <label className="field">
        <span>
          受理意向函扫描件 <span className="t-mut">· PDF · 不超过 10 MB · 可以后补</span>
        </span>
        <input type="file" accept="application/pdf,.pdf" data-testid="rl-file"
          onChange={e => void pick(e.target.files?.[0])} />
        {fileErr && (
          <span className="t-crit" data-testid="rl-file-bad" style={{ fontSize: 12 }}>
            {fileErr}
          </span>
        )}
        {file && (
          <span className="muted" data-testid="rl-file-ok" style={{ fontSize: 12 }}>
            已选中：{file.name}（{kb(file.size)}）
          </span>
        )}
        {/* 已经传过一份时说清楚再传一次会怎样 —— 覆盖是个安静的动作。 */}
        {acceptance.letter && !file && (
          <span className="muted" data-testid="rl-file-existing" style={{ fontSize: 12 }}>
            已有一份：{acceptance.letter.filename}（{kb(acceptance.letter.sizeBytes)}，
            {acceptance.letter.uploadedByName} 上传）。
            <b>再选一份会覆盖它。</b>不选就只改日期。
          </span>
        )}
      </label>

      <div className="row">
        <button className="btn btn-p" data-testid="rl-go" disabled={!ready}
          onClick={() => void save()}>{busy ? "提交中…" : "登记"}</button>
        <span className="note">
          {file || acceptance.letter
            ? <>登记之后这条受理转为「已受理」，该中心可以推进到「伦理递交」。</>
            : <><b>还没传扫描件。</b>日期可以先登记，但核查要看的是那张纸 ——
                拿到之后回来补一次。</>}
        </span>
      </div>

      <div className="derive">
        <b>受理人这一栏不填，是有意的。</b>
        医院那边是谁受理的，由那张纸上的签章回答 ——
        从一个下拉框里挑一个本系统的账号填进去，填的是编的。
        <b>谁在系统里登记了这一条</b>进审计轨迹，那是另一件事。
      </div>
    </div>
  );
}
