import { useEffect, useState } from "react";
import { ApiError, type ProblemDetails } from "../../api/client.js";
import { call } from "../../api/client.js";
import {
  listSubjects, createSubject, signIcf, screenFail, enroll,
  STATE_LABEL, anonymous, today, type Subject
} from "./api.js";
import { SCREEN_FAIL_LABEL } from "../enrollment/api.js";
import { Pick } from "../../shell/CreateForm.js";
import { UnmetList, type UnmetItem } from "../../shell/Unmet.js";
import { Why } from "../../shell/Why.js";
import { useCurrentSite } from "../../shell/currentSite.js";
import { ImportDialog } from "../../shell/ImportDialog.js";

/* ════════════════════════════════════════════════════════════════════
   预筛登记。

   ── 这一页管的是漏斗最上面那两格 ──────────────────────────────────
       登记预筛 → 签知情（进筛选期）→ 入组 / 筛败

   为什么值得单独一页：**预筛量不足和筛败率过高是两个完全不同的问题**
   （见「筛选漏斗与筛败」）。而要分得出来，前提是预筛这一格真的有人记 ——
   只在入组那一刻才建档的话，漏斗最上面两格永远是空的，
   于是"入组慢"就只剩一种解释。

   ── 三个动作的顺序不是界面定的，是库定的 ──────────────────────────
   · 签知情日**不能早于中心的伦理批件日** —— 批件之前签的知情是严重违背；
   · 入组要求筛选期访视**已登记 PI 确认**（状态 locked）—— 入排标准
     没人签字就随机化，是核查必查的一条。签字这件事由一线带着日期
     登记进来，不等 PI 登录这套系统（迁移 0050）。
   前端不重复判定这两条：点下去，让后端说不行，并把它说的话原样摆出来。
   两边各判一次，迟早长出分歧，而界面那一份总是更宽松的那个。
   ════════════════════════════════════════════════════════════════════ */

interface Site { id: string; code: string; hospital: string }

export function PrescreenPage() {
  const [sites, setSites] = useState<Site[]>([]);
  const [subs, setSubs] = useState<Subject[] | null>(null);
  /* 登记到哪个中心：认当前中心，但**不默认成第一个** —— 登错中心的代价大，不认得就让人选 */
  const [siteId, setSiteId] = useCurrentSite(sites.length ? sites : null, false);
  const [no, setNo] = useState("");
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [acting, setActing] = useState<{ id: string; kind: "icf" | "fail" | "enroll" } | null>(null);
  const [importing, setImporting] = useState(false);

  const reload = () => listSubjects({ state: ["prescreen", "screening"] })
    .then(r => setSubs(r.items));

  useEffect(() => {
    void (async () => {
      const s = await call<{ items: Site[] }>("listStudySites", { query: { limit: 200 } });
      setSites(s.items);
      await reload();
    })();
  }, []);

  /* fn 返回字符串时，用它当回执 —— 有些动作要等服务端回来才知道
     该说什么（比如筛选号是服务端发的，登记之前这里并不知道号是多少）。 */
  const run = async (what: string, fn: () => Promise<unknown>) => {
    setProblem(null); setSaid(null);
    try {
      const r = await fn();
      await reload();
      setSaid(typeof r === "string" ? r : what);
      setActing(null);
    } catch (e) { if (e instanceof ApiError) setProblem(e.problem); else throw e; }
  };

  if (!subs) return <p className="muted">加载中…</p>;

  const masked = subs.length > 0 && subs.every(anonymous);
  const prescreen = subs.filter(s => s.state === "prescreen");
  const screening = subs.filter(s => s.state === "screening");

  return (
    <>
      <div className="page-head">
        <h2>预筛登记</h2>
        <p>
          漏斗最上面两格：登记预筛 → 签知情（进筛选期）→ 入组 / 筛败。
          <b>不记预筛，"入组慢"就只剩一种解释。</b>
        </p>
      </div>

      <div className="stats" style={{ marginBottom: 14 }}>
        <Stat label="待签知情" v={prescreen.length} note="已登记预筛，还没签 ICF" />
        <Stat label="筛选中" v={screening.length} note="已签知情，等入组或筛败结论" />
      </div>

      <div className="card stack" style={{ marginBottom: 12 }}>
        <div className="spread">
          <h3>登记一位预筛受试者</h3>
          <span className="muted">此刻只有筛选号 —— 签知情之后才生成筛选期访视</span>
        </div>
        <div className="grid-form">
          <Pick label="中心" v={siteId} on={setSiteId} testid="pre-site"
            options={sites.map(s => ({ value: s.id, label: `${s.code} · ${s.hospital}` }))}
            empty="你被派工的中心里还没有能登记受试者的 —— 中心要先推进到 SIV（已启动）才收受试者，在那之前登记等于在启动会之前开展受试者相关工作。" />
          {/* 筛选号默认由系统按中心发（SS-16-P001）。
              留这条口子是因为申办方 / IWRS 指定筛选号确实存在 ——
              但它是例外：让每个人现想一个，得到的是同一个中心上
              并排出现 S-0203 和 SS-01-P001 两套写法。 */}
          <label className="field"><span>筛选号 <span className="t-mut">· 留空即自动</span></span>
            <input value={no} data-testid="pre-no" className="mono"
              onChange={e => setNo(e.target.value)}
              placeholder="自动生成，如 SS-01-P042" /></label>
        </div>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          {/* 一次几十个（从纸质登记表、从 IWRS 导出的名单）走批量导入 —— 到哪个中心同样看上面选的 */}
          <button className="btn" data-testid="pre-import" disabled={!siteId}
            title={siteId ? "从 CSV 一次登记多位" : "先选中心"}
            onClick={() => setImporting(true)}>批量导入</button>
          <button className="btn primary" data-testid="pre-create"
            disabled={!siteId}
            onClick={() => void run("已登记", async () => {
              const s = await createSubject(siteId, no.trim() || undefined);
              setNo("");
              /* 号是服务端发的，**发完要说出来** —— 不说的话，
                 人得自己去台账里找哪一条是刚才那个。
                 看不到筛选号的角色（列权限）就退回一句通用的。 */
              return s.screeningNo
                ? `已登记 ${s.screeningNo}${no.trim() ? "" : "（筛选号已自动生成）"}`
                : "已登记";
            })}>
            登记
          </button>
        </div>
      </div>

      {siteId && (
        <ImportDialog open={importing} onClose={() => setImporting(false)}
          onDone={() => void reload()} testid="pre-imp"
          title={`批量登记预筛 · ${sites.find(x => x.id === siteId)?.code ?? ""}`}
          previewOp="previewPrescreenImport" commitOp="commitPrescreenImport"
          body={{ studySiteId: siteId }}
          template={{
            name: "prescreen-template",
            csv: "序号,筛选号（空着=自动发号）,知情签署日（YYYY-MM-DD，可空）\r\n1,,\r\n2,,\r\n3,,\r\n",
            hint: "一行一位（序号那一列只为占行，不导入）。筛选号空着就按中心自动发；填了知情签署日的，会一并登记签署、进入筛选期并排出筛选期访视。" +
              "表里不要写姓名、电话这类能认出人的信息。"
          }} />
      )}

      {problem && (
        <div className="problem stack" data-testid="pre-problem" style={{ marginBottom: 12 }}>
          <strong>{problem.title}</strong>
          {problem.detail && <div>{problem.detail}</div>}
          {/* **被拦下来要说得出去哪儿办。** 原来这里只画文字 ——
              现场报的是「我找不到这个对应的入口」。链接由 UnmetList
              按服务端给的 module 自动出（见 shell/Unmet.tsx）。 */}
          {Array.isArray(problem.unmet) && (
            <UnmetList items={problem.unmet as UnmetItem[]} testid="prescreen-unmet" />
          )}
        </div>
      )}
      {said && <p className="muted" data-testid="pre-said">{said}</p>}

      {masked && (
        <div className="problem" data-testid="pre-masked" style={{ marginBottom: 12 }}>
          你的角色看不到筛选号 —— 这一页对你没有可操作的内容。
        </div>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {!masked && <th>筛选号</th>}
              <th>中心</th><th>状态</th><th>知情签署日</th><th>下一步</th>
            </tr>
          </thead>
          <tbody>
            {subs.map(s => (
              <tr key={s.id} data-testid="pre-row">
                {!masked && <td className="mono">{s.screeningNo ?? "—"}</td>}
                <td className="mono">{s.siteCode}</td>
                <td>
                  <span className={`chip ${s.state === "screening" ? "warn" : "flat"}`}>
                    {STATE_LABEL[s.state] ?? s.state}
                  </span>
                </td>
                <td className="mono muted">{s.icfSignedOn ?? "—"}</td>
                <td>
                  <div className="row" style={{ gap: 4 }}>
                    {s.state === "prescreen" && (
                      <button className="btn" data-testid={`icf-${s.id}`}
                        onClick={() => setActing({ id: s.id, kind: "icf" })}>签知情</button>
                    )}
                    {s.state === "screening" && <>
                      <button className="btn primary" data-testid={`enroll-${s.id}`}
                        onClick={() => setActing({ id: s.id, kind: "enroll" })}>入组</button>
                      <button className="btn" data-testid={`fail-${s.id}`}
                        onClick={() => setActing({ id: s.id, kind: "fail" })}>筛败</button>
                    </>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {acting?.kind === "icf" && (
        <DateForm title="登记知情同意签署" testid="icf-form" label="签署日"
          hint="**不能晚于今天，也不能早于中心的伦理批件日** —— 批件之前签的知情是严重违背。这两条由库判，不由这张表单判。"
          onCancel={() => setActing(null)}
          onGo={d => void run("已登记知情签署，筛选期访视已按 SOA 生成",
            () => signIcf(acting.id, d))} />
      )}

      {acting?.kind === "enroll" && (
        <EnrollForm onCancel={() => setActing(null)}
          onGo={(no, d) => void run("已入组", () => enroll(acting.id, no, d))} />
      )}

      {acting?.kind === "fail" && (
        <FailForm onCancel={() => setActing(null)}
          onGo={(reason, d, note) => void run("已登记筛败，筛败费已计入这个中心的收入",
            () => screenFail(acting.id, reason, d, note))} />
      )}

      <Why style={{ marginTop: 14 }}>
        <b>筛败不是失败，是收入。</b> 筛败例数 × 单价 × 筛败费率计入收入 ——
        不记录筛败，会把本来赚钱的高筛败中心算成亏损。
        所以原因是受控取值，不是自由文本：自由文本统计不出
        「入排标准与病源不匹配」这件事。
        <br />
        签知情日与入组的两条前置由<b>数据库</b>判，这张表单不重复判 ——
        两边各判一次，迟早长出分歧，而界面那一份总是更宽松的那个。
      </Why>
    </>
  );
}

function Stat({ label, v, note }: { label: string; v: number; note: string }) {
  return (
    <div className="stat">
      <div className="stat-l">{label}</div>
      <div className="stat-v">{v}</div>
      <div className="stat-n">{note}</div>
    </div>
  );
}

function DateForm({ title, testid, label, hint, onCancel, onGo }: {
  title: string; testid: string; label: string; hint: string;
  onCancel: () => void; onGo: (d: string) => void;
}) {
  const [d, setD] = useState(today());
  return (
    <div className="card stack" data-testid={testid} style={{ marginTop: 12 }}>
      <div className="spread"><h3>{title}</h3>
        <button className="btn" onClick={onCancel}>取消</button></div>
      <p className="muted" style={{ margin: 0 }}>{hint}</p>
      <label className="field" style={{ maxWidth: 220 }}><span>{label}</span>
        <input type="date" value={d} data-testid={`${testid}-date`}
          onChange={e => setD(e.target.value)} /></label>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn primary" data-testid={`${testid}-go`}
          disabled={!d} onClick={() => onGo(d)}>确认</button>
      </div>
    </div>
  );
}

function EnrollForm({ onCancel, onGo }:
  { onCancel: () => void; onGo: (no: string, d: string) => void }) {
  const [no, setNo] = useState("");
  const [d, setD] = useState(today());
  return (
    <div className="card stack" data-testid="enroll-form" style={{ marginTop: 12 }}>
      <div className="spread"><h3>入组（随机化）</h3>
        <button className="btn" onClick={onCancel}>取消</button></div>
      <p className="muted" style={{ margin: 0 }}>
        筛选期访视必须<b>已登记 PI 确认</b>才入组 ——
        入排标准还没人签字就随机化，是核查必查的一条。
        PI 签在纸上的那一下<b>由你带着日期登记进来</b>（访视详情页），
        不用等他登录这套系统；还没登记的话，下面这一下会被挡回来。
      </p>
      <div className="grid-form">
        <label className="field"><span>随机号</span>
          <input value={no} data-testid="enroll-no" className="mono"
            onChange={e => setNo(e.target.value)} placeholder="例：R-0142" /></label>
        <label className="field"><span>入组日</span>
          <input type="date" value={d} data-testid="enroll-date"
            onChange={e => setD(e.target.value)} /></label>
      </div>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn primary" data-testid="enroll-go"
          disabled={!no.trim() || !d} onClick={() => onGo(no.trim(), d)}>确认入组</button>
      </div>
    </div>
  );
}

function FailForm({ onCancel, onGo }:
  { onCancel: () => void; onGo: (reason: string, d: string, note?: string) => void }) {
  const [reason, setReason] = useState("");
  const [d, setD] = useState(today());
  const [note, setNote] = useState("");
  return (
    <div className="card stack" data-testid="fail-form" style={{ marginTop: 12 }}>
      <div className="spread"><h3>登记筛败</h3>
        <button className="btn" onClick={onCancel}>取消</button></div>
      <p className="muted" style={{ margin: 0 }}>
        筛败也按筛败费计入收入。原因从下拉里选 —— 这样才统计得出哪类原因筛掉的最多。
      </p>
      <div className="grid-form">
        <label className="field"><span>原因</span>
          <select value={reason} data-testid="fail-reason" onChange={e => setReason(e.target.value)}>
            <option value="">— 选一个 —</option>
            {Object.entries(SCREEN_FAIL_LABEL).map(([k, v]) =>
              <option key={k} value={k}>{v}</option>)}
          </select></label>
        <label className="field"><span>筛败日</span>
          <input type="date" value={d} data-testid="fail-date"
            onChange={e => setD(e.target.value)} /></label>
      </div>
      <label className="field"><span>补充说明（可选）</span>
        <textarea rows={2} value={note} data-testid="fail-note"
          onChange={e => setNote(e.target.value)}
          placeholder="例：ECOG 2 分，方案要求 0–1" /></label>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn primary" data-testid="fail-go"
          disabled={!reason || !d}
          onClick={() => onGo(reason, d, note.trim() || undefined)}>确认筛败</button>
      </div>
    </div>
  );
}
