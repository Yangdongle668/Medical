import { useState } from "react";
import { call } from "../../api/client.js";
import { CreateForm, Field, Area } from "../../shell/CreateForm.js";
import { yuan } from "../cost/money.js";

/* ════════════════════════════════════════════════════════════════════
   登记一次投标。

   ── 报价与人天两个都要记 ───────────────────────────────────────
   契约原话：只记价格的话，事后没法回答「**是人天估多了还是费率高了**」——
   而这两条要采取的行动完全不同。估多了要改测算口径，
   费率高了要谈定价策略，两件事找的不是同一个人。

   所以这张表上人天是必填，而不是一个可以以后再补的备注。
   ════════════════════════════════════════════════════════════════════ */

const EMPTY = {
  sponsor: "", name: "", submittedOn: "", sites: "", subjects: "",
  quoteWan: "", personDays: "", note: ""
};

export function NewBidForm({ onCreated }: { onCreated: () => void }) {
  const [f, setF] = useState({ ...EMPTY });
  const set = (k: keyof typeof EMPTY) => (v: string) => setF(p => ({ ...p, [k]: v }));

  const cents = Math.round(Number(f.quoteWan || 0) * 1_000_000);
  const pd = Number(f.personDays || 0);
  /* 单人天报价 —— 复盘时最先看的就是这个数。当场算给他看，
     因为「报了 860 万」本身说明不了贵还是便宜。 */
  const perDay = pd > 0 ? Math.round(cents / pd) : null;

  const ready = !!(f.sponsor.trim().length >= 2 && f.name.trim().length >= 2
    && f.submittedOn && Number(f.sites) >= 1 && Number(f.subjects) >= 1
    && cents > 0 && pd > 0);

  return (
    <CreateForm
      testid="new-bid" cta="登记一次投标" title="投标登记"
      sub="报价与当时测算的人天，两个都要记" ready={ready}
      note="中标与否稍后回填 —— 丢标的那些才是复盘时最要紧的。"
      onSubmit={async () => {
        await call("createBid", {
          body: {
            sponsor: f.sponsor.trim(), name: f.name.trim(),
            submittedOn: f.submittedOn,
            sites: Number(f.sites), subjects: Number(f.subjects),
            ourQuoteCents: cents, ourPersonDays: pd,
            ...(f.note.trim() ? { note: f.note.trim() } : {})
          }
        });
        const said = `${f.name.trim()} 的投标已登记`;
        setF({ ...EMPTY });
        onCreated();
        return said;
      }}>
      <div className="grid-form">
        <Field label="申办方" v={f.sponsor} on={set("sponsor")} testid="nb-sponsor"
          placeholder="例：华拓生物" />
        <Field label="项目名" v={f.name} on={set("name")} testid="nb-name"
          placeholder="例：ATC-301 III 期" />
        <Field label="投标日期" v={f.submittedOn} on={set("submittedOn")}
          testid="nb-date" type="date" />
      </div>

      <div className="grid-form">
        <Field label="中心数" v={f.sites} on={set("sites")} testid="nb-sites" type="number" />
        <Field label="例数" v={f.subjects} on={set("subjects")} testid="nb-subjects" type="number" />
        <Field label="我方报价（万元）" v={f.quoteWan} on={set("quoteWan")}
          testid="nb-quote" type="number" />
        <Field label="测算人天" hint="必填" v={f.personDays} on={set("personDays")}
          testid="nb-days" type="number" />
      </div>

      {perDay !== null && (
        <div className="derive" data-testid="nb-perday">
          单人天报价 <b>{yuan(perDay)}</b>。
          <div className="t-mut" style={{ marginTop: 4 }}>
            <b>报价与人天两个都要记。</b>只记价格的话，丢标之后没法回答
            「是人天估多了，还是费率高了」—— 而这两条要采取的行动完全不同。
          </div>
        </div>
      )}

      <Area label="备注" hint="可选" v={f.note} on={set("note")} testid="nb-note"
        placeholder="例：对方要求含 20% 的中心启动费，已按此口径报。" />
    </CreateForm>
  );
}
