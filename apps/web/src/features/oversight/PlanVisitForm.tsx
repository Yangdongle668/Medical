import { useState } from "react";
import { call } from "../../api/client.js";
import { CreateForm, Field, Pick, Area, ListEdit } from "../../shell/CreateForm.js";

/* ════════════════════════════════════════════════════════════════════
   排一次监查访视。

   ── 确认、执行、交报告都接了，排期没接 ──────────────────────────
   于是这一页只处理得了 seed 里已经排好的那几次访视 ——
   而板子上算出来的「这个中心逾期 41 天没人去」，看得见，排不出去。

   ── 跟进项在排期时就写下来，不是回来之后补 ──────────────────────
   契约原话：「这次去要看什么」是出发前的决定，**事后补的清单
   只会写成已经做过的事**。所以这张表上跟进项是必填（至少一条），
   而不是一个可以留到回来再填的可选栏。

   按访视类型预填一份常见清单 —— 预填不是替人决定，
   是让"至少写一条"这件事不至于变成随手敲一个字。

   ── 抽样比例：板子已经算出建议值，这里把它填进去 ────────────────
   监查频率来自风险分级，不是一刀切。`getMonitorBoard` 每个中心都给了
   建议间隔、建议抽样比例**和理由**。选中心时把建议值填进去，
   把理由摆在旁边 —— 人可以改，但改之前看得见建议是什么、凭什么。

   留空是「这次没有单独定过」，不是默认 100%（契约明说）。
   ════════════════════════════════════════════════════════════════════ */

export interface SiteOption {
  studySiteId: string; siteCode: string; hospital: string;
  sdvSamplePct: number; intervalDays: number; reasons: string[];
  overdueDays: number | null; neverVisited: boolean;
}

const KIND_OPTIONS = [
  { value: "siv", label: "启动访视 SIV" },
  { value: "imv", label: "例行监查 IMV" },
  { value: "cov", label: "关闭访视 COV" }
];

/** 按类型预填的跟进项。**是默认值，不是规则** ——
 *  每一条都能删，也该按这个中心的实际情况加。 */
const DEFAULT_ITEMS: Record<string, string[]> = {
  siv: [
    "核对研究者文件夹与授权分工表是否齐备",
    "确认试验用药品接收、储存条件与温控记录",
    "与研究团队过一遍方案入排标准与访视窗"
  ],
  imv: [
    "按抽样比例做源数据核查（SDV）",
    "核对知情同意书签署版本与日期",
    "清点试验用药品发放与回收数量",
    "复核未关闭的数据质疑与方案偏离"
  ],
  cov: [
    "确认全部受试者已完成或已登记脱落",
    "清点并交接研究者文件夹",
    "核对药品回收与销毁记录闭环"
  ]
};

export function PlanVisitForm({ sites, onCreated }:
  { sites: SiteOption[]; onCreated: () => void }) {
  const [siteId, setSiteId] = useState("");
  const [kind, setKind] = useState("");
  const [plannedOn, setPlannedOn] = useState("");
  const [days, setDays] = useState("1");
  const [pct, setPct] = useState("");
  const [note, setNote] = useState("");
  const [items, setItems] = useState<string[]>([]);

  const site = sites.find(s => s.studySiteId === siteId) ?? null;

  /* 换中心 → 填上它的建议抽样比例；换类型 → 铺一份默认跟进项。
     两处都**只在人还没动过那一栏时**才覆盖，否则填了一半换个类型
     会把人刚敲进去的东西冲掉。 */
  const pickSite = (v: string) => {
    setSiteId(v);
    const s = sites.find(x => x.studySiteId === v);
    if (s && !pct) setPct(String(s.sdvSamplePct));
  };
  const pickKind = (v: string) => {
    setKind(v);
    if (!items.length) setItems([...(DEFAULT_ITEMS[v] ?? [])]);
  };

  const ready = !!(siteId && kind && plannedOn && Number(days) > 0 && items.length >= 1);

  return (
    <CreateForm
      testid="plan-visit" cta="排一次监查" title="排一次监查访视"
      sub="「这次去要看什么」是出发前的决定" ready={ready}
      note={<>排完是<b>待确认</b> —— 中心确认之后才算已排期。</>}
      onSubmit={async () => {
        await call("planMonitorVisit", {
          body: {
            studySiteId: siteId, kind, plannedOn, days: Number(days),
            ...(pct ? { sdvSamplePct: Number(pct) } : {}),
            ...(note.trim() ? { note: note.trim() } : {}),
            items
          }
        });
        const said = `${site?.siteCode ?? "中心"} 的监查已排在 ${plannedOn}`;
        setSiteId(""); setKind(""); setPlannedOn(""); setDays("1");
        setPct(""); setNote(""); setItems([]);
        onCreated();
        return said;
      }}>
      <div className="grid-form">
        <Pick label="中心" v={siteId} on={pickSite} testid="pv-site"
          options={sites.map(s => ({
            value: s.studySiteId,
            label: `${s.siteCode} · ${s.hospital}` +
              (s.neverVisited ? "（从没去过）"
                : (s.overdueDays ?? 0) > 0 ? `（逾期 ${s.overdueDays} 天）` : "")
          }))} />
        <Pick label="类型" v={kind} on={pickKind} testid="pv-kind" options={KIND_OPTIONS} />
        <Field label="计划日期" v={plannedOn} on={setPlannedOn} testid="pv-date" type="date" />
        <Field label="人天" v={days} on={setDays} testid="pv-days" type="number" />
      </div>

      {/* 建议值与它的理由摆在一起。没有理由的建议值没人照着做，
          也没人能在核查时解释「为什么这个中心只抽了 25%」。 */}
      {site && (
        <div className="derive" data-testid="pv-advice">
          <b>{site.siteCode} 的建议：</b>
          每 <b>{site.intervalDays}</b> 天一次，抽样 <b>{site.sdvSamplePct}%</b>。
          {site.reasons.length > 0 && <>凭据：{site.reasons.join("；")}。</>}
          <div className="t-mut" style={{ marginTop: 4 }}>
            监查频率来自风险分级，不是一刀切。建议值可以改 ——
            但改之前先看见它是多少、凭什么。
          </div>
        </div>
      )}

      <Field label="SDV 抽样比例（%）" hint="留空 = 这次没有单独定过，不是 100%"
        v={pct} on={setPct} testid="pv-pct" type="number" />

      <ListEdit label="跟进项" testid="pv-items" items={items} onChange={setItems}
        hint="至少一条，出发前定 —— 回来补的清单只会写成已经做过的事"
        placeholder="这次去要看的一件事，回车" />

      <Area label="备注" hint="可选" v={note} on={setNote} testid="pv-note"
        placeholder="例：与机构办约了周三下午，需提前一天提交人员名单。" />
    </CreateForm>
  );
}
