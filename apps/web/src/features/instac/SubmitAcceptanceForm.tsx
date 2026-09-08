import { useEffect, useState } from "react";
import { ACCEPTANCE_DOC_TEMPLATE } from "@sitedesk/contracts";
import { call } from "../../api/client.js";
import { CreateForm, Field, Pick, ListEdit } from "../../shell/CreateForm.js";

/* ════════════════════════════════════════════════════════════════════
   递交立项材料 —— 受托方把材料递到医院机构办。

   ── 不接这一端，那道闸门就是一堵墙 ──────────────────────────────
   契约与 gate.ts 里写着同一句话：「**这一步不在的话，`irb_submit`
   闸门就是一堵墙**：新建档的中心永远递不出去，而墙教会用户的是绕过它。」

   ── 两个入口，因为这件事有两个发生的时刻 ────────────────────────
   ① **中心详情页**（`fixed` 传进来）—— 闸门正拦在这里，
      而这个中心自己知道它属于哪个项目、在哪家医院。
      让人在这一刻再去下拉里挑一遍项目和医院，是把已知的事又问一遍，
      而且挑错了闸门照样不放行 —— 错得还很难看出来。
   ② **立项受理页**（不传 `fixed`）—— 从机构那一侧回看时的补录入口，
      那时中心可能还没建档（受理发生在建档之前，迁移 0038）。

   ── 材料清单由请求带来，不是服务端的规则 ────────────────────────
   各医院的形式审查清单不一样。把它写死在服务端，等于替所有医院
   决定它们该查什么。`ACCEPTANCE_DOC_TEMPLATE` 是**给界面预填的默认值**，
   所以这里可以加、可以删 —— 那八项只是最常见的那一份。

   ── 递进去一律未勾 ─────────────────────────────────────────────
   所以这张表里没有勾选框，只有名字。勾是机构办形式审查的动作 ——
   递交方自己勾完再递，形式审查就没有意义了。
   ════════════════════════════════════════════════════════════════════ */

interface Study { id: string; code: string; shortName: string; sponsorName: string }

export function SubmitAcceptanceForm({ onCreated, fixed }: {
  onCreated: () => void;
  /** 从中心详情页进来时，项目与医院是已知的 —— 不再问一遍。 */
  fixed?: { studyId: string; hospital: string; label: string };
}) {
  const [studies, setStudies] = useState<Study[] | null>(null);
  const [studyId, setStudyId] = useState(fixed?.studyId ?? "");
  const [hospital, setHospital] = useState(fixed?.hospital ?? "");
  const [docs, setDocs] = useState<string[]>([...ACCEPTANCE_DOC_TEMPLATE]);

  /* 项目列表只在要人自己挑的时候才拉。 */
  useEffect(() => {
    if (fixed) return;
    void call<{ items: Study[] }>("listStudies", { query: { limit: 100 } })
      .then(r => setStudies(r.items));
  }, [fixed]);

  const ready = !!(studyId && hospital.trim().length >= 2 && docs.length >= 1);

  return (
    <CreateForm
      testid="submit-acceptance" cta="递交立项材料" title="递交立项材料"
      sub={fixed
        ? fixed.label
        : "受托方递到医院机构办 —— 递进去一律未勾，勾是形式审查的动作"}
      ready={ready}
      note={<>递交之后由机构办做形式审查。<b>未受理的中心推不到「伦理递交」</b>。</>}
      onSubmit={async () => {
        await call("submitSiteAcceptance", {
          body: { studyId, hospital: hospital.trim(), docs }
        });
        const said = `已向 ${hospital.trim()} 递交立项材料`;
        if (!fixed) { setStudyId(""); setHospital(""); }
        setDocs([...ACCEPTANCE_DOC_TEMPLATE]);
        onCreated();
        return said;
      }}>
      {/* 项目与医院：中心详情页进来时它们是已知的，不再问一遍 ——
          问一遍还给了挑错的机会，而挑错了闸门照样不放行。 */}
      {fixed
        ? <div className="derive" data-testid="sa-fixed">
            递给 <b>{hospital}</b>，项目 <b>{fixed.label}</b> ——
            两项都来自这个中心自己，不用挑。
          </div>
        : <div className="grid-form">
            <Pick label="项目" v={studyId} on={setStudyId} testid="sa-study"
              options={(studies ?? []).map(s => ({
                value: s.id, label: `${s.code} · ${s.shortName}（${s.sponsorName}）`
              }))} />
            <Field label="医院" v={hospital} on={setHospital} testid="sa-hospital"
              placeholder="例：四川大学华西医院" />
          </div>}

      <ListEdit label="这家医院要审的材料" testid="sa-docs" items={docs} onChange={setDocs}
        hint="预填的是最常见的那八份，各院不同，可加可删"
        placeholder="再加一份材料的名字，回车" />

      <div className="derive">
        <b>清单由递交方带来，不是服务端的规则。</b>
        各医院的形式审查清单不一样 —— 写死在服务端，等于替所有医院
        决定它们该查什么。
        <br />
        <b>递进去一律未勾。</b>所以这里只填名字，没有勾选框：
        勾是机构办形式审查的动作，递交方自己勾完再递，
        形式审查就没有意义了。
      </div>
    </CreateForm>
  );
}
