import { useState } from "react";
import { call } from "../../api/client.js";
import { CreateForm, Field, Area } from "../../shell/CreateForm.js";
import { yuan, pct } from "../cost/money.js";

/* ════════════════════════════════════════════════════════════════════
   提交立项申请。

   ── 判定接了，提交没接 ──────────────────────────────────────────
   这一页原本能批准、能退回，但**提不了**。于是「立项」这条流程
   只能处理 seed 里已经躺着的那几份申请 —— 而这一页的整个意义是
   "一个项目要先有人提出来、有人算过账、有人批准，然后才有档案"。

   ── 测算成本是手填的，而且要看得出是手填的 ──────────────────────
   契约原话：报价模型那一页能把它算出来（`quote()`），但立项时未必
   已经算过。所以这一栏是人填的数，旁边那句话指得出去哪儿复核。

   ── 毛利率不给填 ───────────────────────────────────────────────
   服务端按合同额与成本算，不接受调用方传入 ——
   **一个可以自己报毛利率的申请，门槛就形同虚设。**
   所以这里只做一件事：把人填的两个数当场算给他看，
   让他在按下提交之前就知道这份申请会不会撞门槛。
   算出来的数**不随请求发出去**，它只是提前把服务端的答案说了一遍。
   ════════════════════════════════════════════════════════════════════ */

const EMPTY = {
  drug: "", sponsorName: "", phase: "", indication: "",
  plannedSites: "", plannedSubjects: "", enrollMonths: "",
  contractWan: "", estimatedCostWan: "", note: ""
};

export function NewIntakeForm({ gmGate, seesPrice, onCreated }:
  { gmGate: number; seesPrice: boolean; onCreated: () => void }) {
  const [f, setF] = useState({ ...EMPTY });
  const set = (k: keyof typeof EMPTY) => (v: string) => setF(p => ({ ...p, [k]: v }));

  /* 万元 → 分。合同额这一档的数字用「万」输入，不然要数六个零 ——
     而数错一个零的立项申请，错的方向永远是偏大。 */
  const wanToCents = (v: string) => Math.round(Number(v || 0) * 1_000_000);

  const contract = wanToCents(f.contractWan);
  const cost = wanToCents(f.estimatedCostWan);
  /* 预演服务端那条算式。**只用来提示，不随请求发出去。** */
  const gm = contract > 0 ? (contract - cost) / contract : null;
  const breakEven = gmGate < 1 ? Math.round(cost / (1 - gmGate)) : null;

  const ready = !!(f.drug.trim().length >= 2 && f.sponsorName.trim().length >= 2
    && f.phase.trim() && f.indication.trim().length >= 2
    && Number(f.plannedSites) >= 1 && Number(f.plannedSubjects) >= 1
    && Number(f.enrollMonths) >= 1 && f.contractWan !== "" && f.estimatedCostWan !== "");

  return (
    <CreateForm
      testid="new-intake" cta="提交立项申请" title="立项申请"
      sub="先算账，再决定 —— 立项时算出 8%，那是决定；做完才算出 8%，那是历史"
      ready={ready}
      note={<>提交之后等经营层批准。<b>批准会在同一个事务里建出项目档案</b>。</>}
      onSubmit={async () => {
        await call("submitIntakeApplication", {
          body: {
            drug: f.drug.trim(), sponsorName: f.sponsorName.trim(),
            phase: f.phase.trim(), indication: f.indication.trim(),
            plannedSites: Number(f.plannedSites),
            plannedSubjects: Number(f.plannedSubjects),
            enrollMonths: Number(f.enrollMonths),
            contractCents: contract, estimatedCostCents: cost,
            ...(f.note.trim() ? { note: f.note.trim() } : {})
          }
        });
        const said = `${f.drug.trim()} 的立项申请已提交`;
        setF({ ...EMPTY });
        onCreated();
        return said;
      }}>
      <div className="grid-form">
        <Field label="药物 / 项目名" v={f.drug} on={set("drug")} testid="ni-drug"
          placeholder="例：艾瑞替尼" />
        <Field label="申办方" v={f.sponsorName} on={set("sponsorName")}
          testid="ni-sponsor" placeholder="例：恒瑞医药" />
        <Field label="期别" v={f.phase} on={set("phase")} testid="ni-phase"
          placeholder="例：III 期" />
        <Field label="适应症" v={f.indication} on={set("indication")}
          testid="ni-indication" placeholder="例：非小细胞肺癌" />
      </div>

      <div className="grid-form">
        <Field label="计划中心数" v={f.plannedSites} on={set("plannedSites")}
          testid="ni-sites" type="number" />
        <Field label="计划例数" v={f.plannedSubjects} on={set("plannedSubjects")}
          testid="ni-subjects" type="number" />
        <Field label="入组期（月）" v={f.enrollMonths} on={set("enrollMonths")}
          testid="ni-months" type="number" />
      </div>

      <div className="grid-form">
        <Field label="合同总额（万元）" v={f.contractWan} on={set("contractWan")}
          testid="ni-contract" type="number" />
        <Field label="测算成本（万元）" hint="手填" v={f.estimatedCostWan}
          on={set("estimatedCostWan")} testid="ni-cost" type="number" />
      </div>

      {/* 当场把服务端会算出来的数说一遍 —— 撞门槛这件事不该等到提交之后
          才知道。**这个数不发出去**：毛利率由服务端算，
          一个可以自己报毛利率的申请，门槛就形同虚设。 */}
      {gm !== null && seesPrice && (
        <div className="derive" data-testid="ni-preview">
          按这两个数：预估毛利 <b>{yuan(contract - cost)}</b>，
          毛利率 <b className={gm < gmGate ? "t-crit" : undefined}>{pct(gm)}</b>
          {gm < gmGate
            ? <>，<b>低于 {pct(gmGate)} 门槛</b> —— 谈判桌上用得上的不是这个百分比，
                是保本合同额：按当前测算成本，合同额至少要{" "}
                <b>{breakEven === null ? "—" : yuan(breakEven)}</b>。</>
            : <>，高于 {pct(gmGate)} 门槛。</>}
          <div className="t-mut" style={{ marginTop: 4 }}>
            这个数只是提前把服务端的答案说了一遍，<b>不随申请发出去</b> ——
            毛利率由服务端按同一条算式算。
          </div>
        </div>
      )}

      <Area label="提交说明" hint="可选" v={f.note} on={set("note")} testid="ni-note"
        placeholder="例：老客户续单，启动成本可复用；CRC 可从相邻项目调配。" />
    </CreateForm>
  );
}
