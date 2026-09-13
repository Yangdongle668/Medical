import { useEffect, useState } from "react";
import { ACCEPTANCE_DOC_TEMPLATE } from "@sitedesk/contracts";
import { call } from "../../api/client.js";
import { CreateForm, Field, Pick, ListEdit } from "../../shell/CreateForm.js";
/* 「今天」取**本地**日历日，不从 UTC 的此刻里切 ——
   东八区早上八点前那八个小时，UTC 切出来的是昨天。
   见 shell/dates.ts 的长注释（测试里有一条守卫盯着这件事）。 */
import { today } from "../../shell/dates.js";

/* ════════════════════════════════════════════════════════════════════
   递交立项材料 —— 受托方把材料递到医院机构办。

   ── 不接这一端，那道闸门就是一堵墙 ──────────────────────────────
   契约与 gate.ts 里写着同一句话：「**这一步不在的话，`irb_submit`
   闸门就是一堵墙**：新建档的中心永远递不出去，而墙教会用户的是绕过它。」

   ── 这张表瘦过一次，值得记下为什么 ──────────────────────────────
   第一版要求先编一张材料清单（预填八项、可加可删）才递得出去。
   那套模型假定**医院的机构办是本系统的用户**：递交方列清单 →
   机构办逐项勾 → 齐备则受理、不齐则发补正。

   而迁移 0038 自己在同一个文件里写着相反的事实：「多数医院的机构办
   根本不是本系统的用户」。于是那张清单由递交方自己填、自己不勾、
   也没有第二个人来勾 —— **一张永远不会被勾的清单，不是记录，
   是每次递交都要重填一遍的仪式。**

   一线在这条流程上真正要报给项目管理员的只有两件事：

     · 哪天成功递交的      ← 这张表
     · 哪天拿到受理意向函   ← 受理台账那一行上的「登记受理意向函」

   所以现在默认只问项目、医院、递交日期三栏。清单收进一个折叠区，
   **要走机构办那条流程的租户照样列得出来** —— 收回的是"必经"，不是"能力"。

   ── 两个入口，因为这件事有两个发生的时刻 ────────────────────────
   ① **中心详情页**（`fixed` 传进来）—— 闸门正拦在这里，
      而这个中心自己知道它属于哪个项目、在哪家医院。
   ② **立项受理页**（不传 `fixed`）—— 从机构那一侧回看时的补录入口，
      那时中心可能还没建档（受理发生在建档之前，迁移 0038）。
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
  const [submittedOn, setSubmittedOn] = useState(today());
  /* 清单默认**空着且折叠**。展开之后才预填那八项 ——
     预填一个默认折叠的区域，等于替人做了"要列清单"这个决定。 */
  const [listing, setListing] = useState(false);
  const [docs, setDocs] = useState<string[]>([]);

  /* 项目列表只在要人自己挑的时候才拉。 */
  useEffect(() => {
    if (fixed) return;
    void call<{ items: Study[] }>("listStudies", { query: { limit: 100 } })
      .then(r => setStudies(r.items));
  }, [fixed]);

  const 将来 = submittedOn > today();
  const ready = !!(studyId && hospital.trim().length >= 2 && submittedOn && !将来);

  return (
    <CreateForm
      testid="submit-acceptance" cta="登记递交" title="登记立项材料递交"
      sub={fixed ? fixed.label : "只记两件事：递给谁、哪天递的"}
      ready={ready}
      note={<>登记之后由机构办受理。<b>未受理的中心推不到「伦理递交」</b>。
        拿到受理意向函后，回到受理台账那一行点「登记受理意向函」。</>}
      onSubmit={async () => {
        await call("submitSiteAcceptance", {
          body: {
            studyId, hospital: hospital.trim(), submittedOn,
            ...(docs.length ? { docs } : {})
          }
        });
        const said = `已登记：${submittedOn} 向 ${hospital.trim()} 递交立项材料`;
        if (!fixed) { setStudyId(""); setHospital(""); }
        setDocs([]); setListing(false); setSubmittedOn(today());
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
              }))}
              empty={studies === null ? "加载中…"
                : "你的范围里还没有项目 —— 立项材料是递给某一个项目的，得先有一份立项申请被批准。"} />
            <Field label="医院" v={hospital} on={setHospital} testid="sa-hospital"
              placeholder="例：四川大学华西医院" />
          </div>}

      {/* **递交日期是这张表的正题。** 默认今天，但收得下过去：
          一线常常是过两天才回到系统里补登，而那时默认成今天的话，
          「递交日期」这一栏就成了「登记日期」—— 两者差的那几天
          恰恰是伦理排期要算的。 */}
      <Field label="哪天递交的" v={submittedOn} on={setSubmittedOn}
        testid="sa-submitted-on" type="date"
        hint="默认今天；过两天才回来补登的，把真实日期填回去" />
      {将来 && (
        <span className="t-crit" data-testid="sa-date-future" style={{ fontSize: 12 }}>
          这个日期在将来 —— 这一栏记的是「哪天递出去的」，还没递的不用先登记。
        </span>
      )}

      {/* 材料清单折进来。**默认不展开** —— 见文件头那段。 */}
      {!listing ? (
        <button type="button" className="btn link" data-testid="sa-docs-open"
          style={{ alignSelf: "flex-start" }}
          onClick={() => { setListing(true); setDocs([...ACCEPTANCE_DOC_TEMPLATE]); }}>
          要在系统里逐项列材料清单？（机构办在本系统里做形式审查时才需要）
        </button>
      ) : (
        <>
          <ListEdit label="这家医院要审的材料" testid="sa-docs" items={docs} onChange={setDocs}
            hint="预填的是最常见的那八份，各院不同，可加可删"
            placeholder="再加一份材料的名字，回车" />
          <button type="button" className="btn link" data-testid="sa-docs-close"
            style={{ alignSelf: "flex-start" }}
            onClick={() => { setListing(false); setDocs([]); }}>
            不列了 —— 收起清单
          </button>
          <div className="derive">
            <b>清单由递交方带来，不是服务端的规则。</b>
            各医院的形式审查清单不一样 —— 写死在服务端，等于替所有医院
            决定它们该查什么。
            <br />
            <b>递进去一律未勾。</b>所以这里只填名字，没有勾选框：
            勾是机构办形式审查的动作，递交方自己勾完再递，
            形式审查就没有意义了。
          </div>
        </>
      )}
    </CreateForm>
  );
}
