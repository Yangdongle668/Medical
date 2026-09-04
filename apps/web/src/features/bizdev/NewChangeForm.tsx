import { useEffect, useState } from "react";
import { CHANGE_KINDS, CHANGE_KIND_LABEL } from "@sitedesk/contracts";
import { call } from "../../api/client.js";
import { CreateForm, Field, Pick, Area } from "../../shell/CreateForm.js";

/* ════════════════════════════════════════════════════════════════════
   登记一张变更单。

   ── 先记下来，再去谈 ───────────────────────────────────────────
   契约原话：顺序反过来的话，**谈不成的那些就永远不进系统** ——
   而它们恰恰是最该被记住的：下次报价时要加进去的正是它们。

   所以这张表不问「谈成了吗」，只问「发生了什么、值多少人天」。
   结算是后面那一步（settleContractChange，已接）。

   ── 人天影响可以是负的 ─────────────────────────────────────────
   中心减了、例数砍了，人天是往下走的。契约允许负数正是为此 ——
   只记加不记减的变更台账，累计出来的数字永远偏大，
   而"我们一共被加了多少活"这个数一旦不可信，就没人再看它。

   ── 中心留空 = 全项目 ──────────────────────────────────────────
   周期延长、中心增减是全项目的事，不挂在某一个中心下。
   **那不是漏填**，所以这一栏的默认值就是空，且旁边说清楚。
   ════════════════════════════════════════════════════════════════════ */

interface Study { id: string; code: string; shortName: string }
interface Site { id: string; code: string; hospital: string }

const EMPTY = {
  studyId: "", studySiteId: "", kind: "", raisedOn: "",
  what: "", personDays: "", perSubject: "no", note: ""
};

export function NewChangeForm({ onCreated }: { onCreated: () => void }) {
  const [studies, setStudies] = useState<Study[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [f, setF] = useState({ ...EMPTY });
  const set = (k: keyof typeof EMPTY) => (v: string) => setF(p => ({ ...p, [k]: v }));

  useEffect(() => {
    void Promise.all([
      call<{ items: Study[] }>("listStudies", { query: { limit: 100 } })
        .then(r => setStudies(r.items)),
      call<{ items: Site[] }>("listStudySites", { query: { limit: 200 } })
        .then(r => setSites(r.items))
    ]);
  }, []);

  const ready = !!(f.studyId && f.kind && f.raisedOn && f.what.trim().length >= 4
    && f.personDays !== "");

  return (
    <CreateForm
      testid="new-change" cta="登记一张变更单" title="合同变更登记"
      sub="先记下来，再去谈 —— 谈不成的那些才是下次报价要加进去的"
      ready={ready}
      note="登记之后状态是「待提出」，谈成与否走结算那一步。"
      onSubmit={async () => {
        await call("createContractChange", {
          body: {
            studyId: f.studyId,
            ...(f.studySiteId ? { studySiteId: f.studySiteId } : {}),
            kind: f.kind, raisedOn: f.raisedOn,
            what: f.what.trim(),
            personDaysImpact: Number(f.personDays),
            perSubject: f.perSubject === "yes",
            ...(f.note.trim() ? { note: f.note.trim() } : {})
          }
        });
        const said = `变更单已登记（${CHANGE_KIND_LABEL[f.kind as keyof typeof CHANGE_KIND_LABEL]}）`;
        setF({ ...EMPTY });
        onCreated();
        return said;
      }}>
      <div className="grid-form">
        <Pick label="项目" v={f.studyId} on={set("studyId")} testid="nc-study"
          options={studies.map(s => ({ value: s.id, label: `${s.code} · ${s.shortName}` }))} />
        <Pick label="变更类型" v={f.kind} on={set("kind")} testid="nc-kind"
          options={CHANGE_KINDS.map(k => ({ value: k, label: CHANGE_KIND_LABEL[k] }))} />
        <Field label="提出日期" v={f.raisedOn} on={set("raisedOn")}
          testid="nc-date" type="date" />
      </div>

      <label className="field">
        <span>
          中心 <span className="t-mut">· 留空 = 全项目的变更（周期延长、中心增减）</span>
        </span>
        <select value={f.studySiteId} data-testid="nc-site"
          onChange={e => set("studySiteId")(e.target.value)}>
          <option value="">— 全项目 —</option>
          {sites.map(s => (
            <option key={s.id} value={s.id}>{s.code} · {s.hospital}</option>
          ))}
        </select>
      </label>

      <Area label="变更内容" hint="至少 4 字" v={f.what} on={set("what")} testid="nc-what"
        placeholder="例：第 3 周期起每例增加一次骨扫描，含预约、陪同与影像归档。" />

      <div className="grid-form">
        <Field label="人天影响" hint="可以是负数" v={f.personDays}
          on={set("personDays")} testid="nc-days" type="number" />
        <label className="field">
          <span>计量口径</span>
          <select value={f.perSubject} data-testid="nc-per"
            onChange={e => set("perSubject")(e.target.value)}>
            <option value="no">整个项目一次性</option>
            <option value="yes">每例受试者</option>
          </select>
        </label>
      </div>

      <div className="derive">
        <b>人天影响可以是负的。</b>中心减了、例数砍了，人天是往下走的 ——
        只记加不记减的变更台账，累计出来的数永远偏大，
        而「我们一共被加了多少活」这个数一旦不可信，就没人再看它。
        <br />
        <b>每例</b>的口径会按合同例数乘开；<b>一次性</b>就是这一个数。
      </div>

      <Area label="备注" hint="可选" v={f.note} on={set("note")} testid="nc-note"
        placeholder="例：申办方口头同意按人天补，待其法务出具变更函。" />
    </CreateForm>
  );
}
