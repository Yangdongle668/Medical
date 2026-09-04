import { useEffect, useState } from "react";
import { call } from "../../api/client.js";
import { CreateForm, Field, Pick } from "../../shell/CreateForm.js";

/* ════════════════════════════════════════════════════════════════════
   登记一次可行性调查。

   ── 问卷那八项不是表单填空，每一项都要被评分用到 ────────────────
   服务端的 `feasibilityScore()` 拿它们算出总分与逐项得分，
   而逐项得分**必须给得出**：这套分数会被用来拒绝一家医院，
   被拒的一方（以及内部坚持要选它的人）一定会问"凭什么"。

   ── eligPct 允许为空，而且空得有意义 ───────────────────────────
   契约注释里那段话值得照抄到界面上：这一栏是复盘一次
   「评分 82 分入选、实际筛败率 57%」之后才加的 ——
   病源足、团队强、启动快全部说对了，
   **但没有人问过「你们的病人符合我们这套入排吗」**。

   所以它的空值是「当时没问过」，不是 0%。界面上给一个明确的
   「没问过」开关，而不是留一个空输入框让人猜该不该填。

   ── 同一个项目对同一家医院的同一个科室只能有一份 ────────────────
   重复了就没人知道该看哪一份（数据库直接拒绝）。
   ════════════════════════════════════════════════════════════════════ */

interface Study { id: string; code: string; shortName: string }

const EMPTY = {
  studyId: "", hospital: "", city: "", dept: "", piName: "", surveyedOn: "",
  ptYear: "", pastN: "", pastBest: "", compet: "",
  ethicsDays: "", startDays: "", teamN: "", piCommit: "", eligPct: ""
};

export function NewFeasibilityForm({ onCreated }: { onCreated: () => void }) {
  const [studies, setStudies] = useState<Study[]>([]);
  const [f, setF] = useState({ ...EMPTY });
  /** 「当时没问过」—— eligPct 的空值有含义，所以它是一个明确的开关。 */
  const [askedElig, setAskedElig] = useState(true);
  const set = (k: keyof typeof EMPTY) => (v: string) => setF(p => ({ ...p, [k]: v }));

  useEffect(() => {
    void call<{ items: Study[] }>("listStudies", { query: { limit: 100 } })
      .then(r => setStudies(r.items));
  }, []);

  const num = (v: string) => Number(v || 0);
  const filled = (["ptYear", "pastN", "pastBest", "compet",
    "ethicsDays", "startDays", "teamN", "piCommit"] as const).every(k => f[k] !== "");

  const ready = !!(f.studyId && f.hospital.trim().length >= 2 && f.city.trim().length >= 2
    && f.dept.trim().length >= 2 && f.piName.trim().length >= 2 && f.surveyedOn
    && filled && (!askedElig || f.eligPct !== ""));

  return (
    <CreateForm
      testid="new-feas" cta="登记一次可行性" title="可行性调查登记"
      sub="八项问卷，每一项都会被评分用到" ready={ready}
      note="登记之后服务端出总分与逐项得分 —— 入选与否是另一步。"
      onSubmit={async () => {
        await call("createFeasibility", {
          body: {
            studyId: f.studyId, hospital: f.hospital.trim(), city: f.city.trim(),
            dept: f.dept.trim(), piName: f.piName.trim(), surveyedOn: f.surveyedOn,
            answers: {
              ptYear: num(f.ptYear), pastN: num(f.pastN), pastBest: num(f.pastBest),
              compet: num(f.compet), ethicsDays: num(f.ethicsDays),
              startDays: num(f.startDays), teamN: num(f.teamN),
              piCommit: num(f.piCommit),
              /* null = 当时没问过。**不是 0%** —— 两者在评分里不是一回事。 */
              eligPct: askedElig ? num(f.eligPct) / 100 : null
            }
          }
        });
        const said = `${f.hospital.trim()} 的可行性已登记`;
        setF({ ...EMPTY }); setAskedElig(true);
        onCreated();
        return said;
      }}>
      <div className="grid-form">
        <Pick label="项目" v={f.studyId} on={set("studyId")} testid="nf-study"
          options={studies.map(s => ({ value: s.id, label: `${s.code} · ${s.shortName}` }))} />
        <Field label="医院" v={f.hospital} on={set("hospital")} testid="nf-hospital" />
        <Field label="城市" v={f.city} on={set("city")} testid="nf-city" />
        <Field label="科室" v={f.dept} on={set("dept")} testid="nf-dept" />
        <Field label="主要研究者" v={f.piName} on={set("piName")} testid="nf-pi" />
        <Field label="调查日期" v={f.surveyedOn} on={set("surveyedOn")}
          testid="nf-date" type="date" />
      </div>

      <div className="section-t" style={{ marginTop: 4 }}>问卷</div>
      <div className="grid-form">
        <Field label="年就诊量" hint="该适应症" v={f.ptYear} on={set("ptYear")}
          testid="nf-ptyear" type="number" />
        <Field label="既往同类试验数" v={f.pastN} on={set("pastN")}
          testid="nf-pastn" type="number" />
        <Field label="既往最好月入组" hint="例/月" v={f.pastBest} on={set("pastBest")}
          testid="nf-pastbest" type="number" />
        <Field label="同期竞争试验数" v={f.compet} on={set("compet")}
          testid="nf-compet" type="number" />
        <Field label="伦理审批耗时" hint="天，历史均值" v={f.ethicsDays}
          on={set("ethicsDays")} testid="nf-ethics" type="number" />
        <Field label="立项到 SIV 耗时" hint="天，历史均值" v={f.startDays}
          on={set("startDays")} testid="nf-start" type="number" />
        <Field label="研究团队人数" v={f.teamN} on={set("teamN")}
          testid="nf-team" type="number" />
        <Field label="PI 自报月入组承诺" hint="例/月" v={f.piCommit}
          on={set("piCommit")} testid="nf-commit" type="number" />
      </div>

      {/* eligPct 那一栏，连同它为什么存在。 */}
      <div className="stack" style={{ gap: 8 }}>
        <label className="cbx">
          <input type="checkbox" checked={askedElig} data-testid="nf-asked"
            onChange={e => setAskedElig(e.target.checked)} />
          <span>这次问了「按本方案入排，合格患者比例大概多少」</span>
        </label>
        {askedElig
          ? <Field label="合格患者比例（%）" v={f.eligPct} on={set("eligPct")}
              testid="nf-elig" type="number" />
          : <div className="derive" data-testid="nf-elig-skipped">
              这一栏会记成<b>「当时没问过」</b>，不是 0% —— 两者在评分里不是一回事。
            </div>}
      </div>

      <div className="derive">
        <b>最后那一项是复盘出来的。</b>
        有过一次「评分 82 分入选、实际筛败率 57%」：病源足、团队强、启动快
        全部说对了，<b>但没有人问过「你们的病人符合我们这套入排吗」</b>。
        问卷因此多了这一栏 —— 而它的空值必须留得住"当时没问过"这个事实。
      </div>
    </CreateForm>
  );
}
