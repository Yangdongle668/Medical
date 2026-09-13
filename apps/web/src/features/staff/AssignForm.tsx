import { useEffect, useState } from "react";
import { call } from "../../api/client.js";
import { CreateForm, Field, Pick } from "../../shell/CreateForm.js";

/* ════════════════════════════════════════════════════════════════════
   派工：把一个人接到几个中心上。

   ── 为什么这张表长成「先挑项目，再勾中心」 ──────────────────────
   人嘴里说的是「把小张分配到这个项目」，而库里存的是
   「小张 × 这个中心」一行一条。两者都对，差别在于**范围**：
   一个 CRA 常常只跑一个项目里的三家医院，不是全部十五家。
   按项目整体派，等于把另外十二家的受试者明细一并给他 ——
   那不是方便，是超范围。

   所以这张表照着人的说法开头（挑项目），照着模型收尾（勾中心），
   并且默认**一个都不勾**：默认全勾的话，多给出去的那十二家
   不会有任何一处提醒。

   ── 它不是排班表，是发钥匙 ──────────────────────────────────────
   `site_assignment` 就是行规则 `assigned` 本身。多一行，那个人就
   多看得见一个中心的受试者、访视、质疑、药品台账。所以这张表
   要原因，而且提交按钮旁边那句话说的是后果，不是"确定要提交吗"。
   ════════════════════════════════════════════════════════════════════ */

interface Staff {
  accountId: string; displayName: string; roleKind: string;
  gcpDaysLeft: number | null; active: boolean;
}
interface Study { id: string; code: string; shortName: string }
interface Site { id: string; code: string; hospital: string; city: string }
interface Assignment { studySiteId: string; accountId: string }

export function AssignForm({ staff, onDone, preset }: {
  /** 名册由调用方给 —— 这一页本来就拉过一次，不必再拉一遍。 */
  staff: Staff[];
  onDone: () => void;
  /** 从某个人那一行点进来时，人是已知的。 */
  preset?: { accountId: string };
}) {
  const [who, setWho] = useState(preset?.accountId ?? "");
  const [studies, setStudies] = useState<Study[] | null>(null);
  const [studyId, setStudyId] = useState("");
  const [sites, setSites] = useState<Site[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [held, setHeld] = useState<Set<string>>(new Set());
  const [since, setSince] = useState("");
  const [reason, setReason] = useState("");

  useEffect(() => {
    void call<{ items: Study[] }>("listStudies", { query: { limit: 100 } })
      .then(r => setStudies(r.items)).catch(() => setStudies([]));
  }, []);

  /* 选了项目才拉它下面的中心 —— 一次拉全部中心，勾选框会有几百个，
     而人心里想的只是"这个项目的这几家"。 */
  useEffect(() => {
    setPicked([]);
    if (!studyId) { setSites(null); return; }
    void call<{ items: Site[] }>("listStudySites", { query: { limit: 200, studyId } })
      .then(r => setSites(r.items)).catch(() => setSites([]));
  }, [studyId]);

  /* 他已经在跑的那些**要标出来**，而不是让人勾完再被服务端告知"跳过了 3 个"。 */
  useEffect(() => {
    if (!who) { setHeld(new Set()); return; }
    void call<{ items: Assignment[] }>("listSiteAssignments",
      { query: { limit: 200, accountId: who } })
      .then(r => setHeld(new Set(r.items.map(a => a.studySiteId))))
      .catch(() => setHeld(new Set()));
  }, [who]);

  const 人 = staff.find(s => s.accountId === who);
  const 可勾的 = (sites ?? []).filter(s => !held.has(s.id));
  const ready = !!who && picked.length > 0 && reason.trim().length >= 4;

  const toggle = (id: string) =>
    setPicked(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id]);

  return (
    <CreateForm
      testid="assign" cta="派工到中心" title="派工到中心"
      sub="先挑项目，再勾这个项目下他要跑的几个中心"
      ready={ready}
      note={人
        ? <>派完之后，<b>{人.displayName}</b> 当场看得见这 {picked.length} 个中心的
            受试者、访视、质疑与药品台账。这是权限变更，会进审计轨迹。</>
        : <>这是权限变更，不是排班：派上去那一刻，他就看得见那个中心的全部明细。</>}
      onSubmit={async () => {
        const r = await call<{ sideEffects: { summary: string }[] }>("assignSiteStaff", {
          params: { id: who },
          body: {
            studySiteIds: picked, reason: reason.trim(),
            ...(since ? { since } : {})
          }
        });
        setPicked([]); setReason(""); setSince("");
        onDone();
        return r.sideEffects[0]?.summary ?? "已派工";
      }}>

      <div className="grid-form">
        {!preset && (
          <Pick label="派给谁" v={who} on={setWho} testid="assign-who"
            hint="只列 CRA / CRC"
            options={staff.filter(s => s.active
              && (s.roleKind === "CRA" || s.roleKind === "CRC"))
              .map(s => ({
                value: s.accountId,
                label: `${s.displayName}（${s.roleKind}）` +
                  (s.gcpDaysLeft !== null && s.gcpDaysLeft < 0
                    ? ` · GCP 已过期 ${-s.gcpDaysLeft} 天` : "")
              }))}
            /* 字符串属性写成两行的话，JSX 会把换行和缩进原样留在值里 ——
               页面上就是一句中间夹着七个空格的话。用表达式拼。 */
            empty={"名册里没有在职的 CRA / CRC —— 派工只对这两个工种成立，" +
              "先去「人才梯队」把人建起来。"} />
        )}
        <Pick label="项目" v={studyId} on={setStudyId} testid="assign-study"
          options={(studies ?? []).map(s => ({
            value: s.id, label: `${s.code} · ${s.shortName}`
          }))}
          empty={studies === null ? "加载中…"
            : "你的范围里还没有项目 —— 派工是派到某个项目的中心上的，先去「立项与建档」。"} />
        <Field label="从哪天起" v={since} on={setSince} testid="assign-since"
          type="date" hint="留空即今天；可以补登过去，不收将来" />
      </div>

      {/* 中心是勾出来的，不是下拉选的：一次派一批是常态，
          而「这几家归他、那几家不归」正是这一步要表达的东西。 */}
      {studyId && (
        <div className="field" data-testid="assign-sites">
          <span>
            这个项目下的中心
            {可勾的.length > 0 && (
              <button type="button" className="btn link" data-testid="assign-all"
                style={{ marginLeft: 8 }}
                onClick={() => setPicked(可勾的.map(s => s.id))}>全勾上</button>
            )}
          </span>
          {sites === null ? <span className="muted">加载中…</span>
            : sites.length === 0
              ? <span className="t-crit" data-testid="assign-no-sites">
                  这个项目下还没有中心 —— 先去「项目 · 中心台账」建档。
                </span>
              : (
                <ul className="tasks" style={{ marginTop: 6 }}>
                  {sites.map(s => {
                    const 在跑 = held.has(s.id);
                    return (
                      <li key={s.id}>
                        <label className="row" style={{ gap: 6, alignItems: "center" }}>
                          <input type="checkbox" style={{ width: "auto" }}
                            data-testid={`assign-site-${s.code}`}
                            disabled={在跑} checked={picked.includes(s.id)}
                            onChange={() => toggle(s.id)} />
                          <span className="mono">{s.code}</span>
                          <span>{s.hospital}</span>
                          <span className="muted">{s.city}</span>
                        </label>
                        {/* 已经在跑的**标出来而不是藏起来** —— 藏起来的话，
                            "他到底在不在这个中心上"这个问题这一页答不出，
                            而那正是打开这张表的人心里的问题。 */}
                        {在跑 && <span className="chip flat" data-testid="assign-held">
                          已在跑
                        </span>}
                      </li>
                    );
                  })}
                </ul>
              )}
        </div>
      )}

      <Field label="原因" v={reason} on={setReason} testid="assign-reason"
        placeholder="例：SS-02 的 CRA 休产假，这几个中心转给他"
        hint="至少 4 个字，进审计轨迹 —— 核查时真正被问的就是这一栏" />

      <div className="derive">
        <b>派工按中心，不按项目。</b> 一个 CRA 常常只跑一个项目里的三家医院，
        不是全部十五家 —— 按项目整体派，等于把另外十二家的受试者明细一并给他。
        <br />
        <b>PM 不走这条路。</b> 项目总监的范围来自<b>项目归属组</b>：
        把项目划给他那个组（「项目 · 中心台账」里的「改归属组」），
        而不是在这里给他派中心。QA / DM 看全部，机构办按所属医院，
        PI 按中心上绑定的研究者账号 —— 四种各有各的来源，都不是派工。
      </div>
    </CreateForm>
  );
}
