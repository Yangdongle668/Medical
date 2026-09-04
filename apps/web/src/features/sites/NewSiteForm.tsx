import { useEffect, useState } from "react";
import { call } from "../../api/client.js";
import { CreateForm, Field, Pick } from "../../shell/CreateForm.js";

/* ════════════════════════════════════════════════════════════════════
   中心建档。

   ── 为什么这一栏此前不存在 ──────────────────────────────────────
   `createStudySite` 从 Phase 6 起就在服务端跑着（site.controller.ts，
   带幂等键、带审计），但**界面上从来没有入口**。于是"系统里的中心"
   只能靠 seed 灌进去 —— 一个跑起来的系统没法把第 16 个中心建进去。

   契约对这个端点的说明写得很清楚它为什么要紧：
   「已建档 / 合同中心数」的差值 = 合同里写了但还没进系统的中心，
   它们的成本已经在发生，收入却挂不上号。**建档滞后是早期成本
   失控最不显形的一种** —— 而没有建档入口，这个差值只会越来越大。

   ── 单价与启动费是受列权限管辖的 ────────────────────────────────
   看不到价钱的人也应该能建档（建档是运营动作，不是商务动作）。
   所以这两栏在无权限时**不出现**，而不是出现一个禁用的输入框：
   禁用的输入框在说"你本该填这个但不许"，而事实是这件事不归他管。
   判断依据和台账那一列一样 —— 看数据里有没有这个字段，不重算权限。
   ════════════════════════════════════════════════════════════════════ */

interface Study { id: string; code: string; shortName: string; sponsorName: string }

const EMPTY = {
  studyId: "", code: "", hospital: "", dept: "", city: "", piName: "",
  contracted: "", unitPriceYuan: "", startupFeeYuan: "", sivPlannedOn: ""
};

export function NewSiteForm({ showPrice, onCreated }:
  { showPrice: boolean; onCreated: () => void }) {
  const [studies, setStudies] = useState<Study[] | null>(null);
  const [f, setF] = useState({ ...EMPTY });

  /* 项目列表拉一次就够 —— 台账页本身不需要它，但表单一展开就要有。 */
  useEffect(() => {
    void call<{ items: Study[] }>("listStudies", { query: { limit: 100 } })
      .then(r => setStudies(r.items));
  }, []);

  const set = (k: keyof typeof EMPTY) => (v: string) => setF(p => ({ ...p, [k]: v }));
  const yuanToCents = (v: string) => Math.round(Number(v || 0) * 100);

  const ready = !!(f.studyId && f.code.trim() && f.hospital.trim() && f.dept.trim()
    && f.city.trim() && f.piName.trim() && Number(f.contracted) > 0
    && (!showPrice || f.unitPriceYuan !== ""));

  return (
    <CreateForm
      testid="new-site" cta="建一个中心" title="中心建档"
      sub="合同里写了、系统里还没有的那些" ready={ready}
      note="建档之后中心停在「合同签署」，启动清单随之生成 —— 推进到 SIV 要等阻塞项清零。"
      onSubmit={async () => {
        await call("createStudySite", {
          body: {
            studyId: f.studyId,
            code: f.code.trim(), hospital: f.hospital.trim(),
            dept: f.dept.trim(), city: f.city.trim(), piName: f.piName.trim(),
            contracted: Number(f.contracted),
            /* 看不到价钱的人建的档，价钱是 0 —— 由商务后续在费率那边补。
               这里不能省略字段：契约要求它必填，省略会得到一个 422。 */
            unitPriceCents: showPrice ? yuanToCents(f.unitPriceYuan) : 0,
            startupFeeCents: showPrice ? yuanToCents(f.startupFeeYuan) : 0,
            ...(f.sivPlannedOn ? { sivPlannedOn: f.sivPlannedOn } : {})
          }
        });
        const said = `${f.code.trim()} 已建档`;
        setF({ ...EMPTY });
        onCreated();
        return said;
      }}>
      <Pick label="所属项目" v={f.studyId} on={set("studyId")} testid="ns-study"
        options={(studies ?? []).map(s => ({
          value: s.id, label: `${s.code} · ${s.shortName}（${s.sponsorName}）`
        }))} />

      <div className="grid-form">
        <Field label="中心编号" v={f.code} on={set("code")} testid="ns-code" />
        <Field label="医院" v={f.hospital} on={set("hospital")} testid="ns-hospital" />
        <Field label="科室" v={f.dept} on={set("dept")} testid="ns-dept" />
        <Field label="城市" v={f.city} on={set("city")} testid="ns-city" />
        <Field label="主要研究者" v={f.piName} on={set("piName")} testid="ns-pi" />
        <Field label="合同例数" v={f.contracted} on={set("contracted")}
          testid="ns-contracted" type="number" />
      </div>

      {/* 价钱那两栏只给看得见价钱的人 —— 判断依据是台账里有没有这个字段。 */}
      {showPrice && (
        <div className="grid-form">
          <Field label="单例单价（元）" v={f.unitPriceYuan} on={set("unitPriceYuan")}
            testid="ns-price" type="number" />
          <Field label="启动费（元）" v={f.startupFeeYuan} on={set("startupFeeYuan")}
            testid="ns-startup-fee" type="number" />
        </div>
      )}

      <Field label="计划 SIV 日" hint="可留空" v={f.sivPlannedOn}
        on={set("sivPlannedOn")} testid="ns-siv" type="date" />
    </CreateForm>
  );
}
