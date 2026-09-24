import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { call } from "../../api/client.js";
import { loadMe } from "../login/me.js";
import { recallWho } from "../login/session.js";
import { Why } from "../../shell/Why.js";
import { ReportSaeForm } from "../quality/SaePanel.js";

/* ════════════════════════════════════════════════════════════════════
   今天 —— 一线的首页：**要你动手的事，按先后排成一列。**

   原来这一页只有访视。而 CRC 每天要处理的事散在十来个页面上：
   SAE 的 24 小时在「质量与 SAE」某个中心的面板里、待回复的质疑在
   「数据质疑」、交接给他的在「交接」、过期的批件在「中心文件」……
   「今天先做哪件」要他自己翻一遍再心算。

   现在由 `GET /v1/me/inbox` 一次给齐（见 contracts/src/workbench/api.ts）：
   只给你办得了的，SAE 最前，其余按 已过期 → 今天 → 这几天。
   每一条点进去就是办这件事的那一页。
   ════════════════════════════════════════════════════════════════════ */

export interface Visit {
  id: string; screeningNo?: string; siteCode: string;
  visitLabel: string; targetDate: string; windowFrom: string; windowTo: string;
  actualDate?: string | null;
  daysLeft: number | null; outOfWindow: boolean; status: string;
  /** 录入 EDC 的状态。**完成访视和录进 EDC 是两件事** ——
   *  访视完成后 5 个工作日内录入才算及时，超时不阻断，但进及时率统计。 */
  edcStatus?: "pending" | "entered" | "queried";
  edcDaysLate?: number | null;
  /** PI 签字确认的日期。**为空就是还没登记** —— 它是 locked 的充要条件。 */
  piConfirmedAt?: string | null;
  /** 在本系统里点下确认的那个人。**为空是常态**：PI 多数时候没有账号，
   *  确认由一线登记，那时这一栏空着而审计轨迹里有登记人。见迁移 0050。 */
  piConfirmedByName?: string | null;
  tasks: { seq: number; task: string; doneAt: string | null }[];
  /** 只在单取一次访视时有：本中心同一访视最近几次工时的中位数。 */
  suggestedHours?: number | null;
}

export interface InboxItem {
  kind: Kind; urgency: "overdue" | "today" | "soon";
  dueOn: string | null; dueAt: string | null;
  title: string; detail: string;
  studySiteId: string | null; siteCode: string | null; screeningNo?: string;
  /** 只看不办：归别人办、你要跟进（目前只有监查员看到的 SAE）。 */
  watch?: boolean;
  ref: { type: string; id: string | null };
}
type Kind = "sae" | "visit" | "pi_confirm" | "edc" | "query" | "handover"
  | "approval" | "isf" | "capa" | "mvr" | "monitor_visit";
export interface Inbox {
  items: InboxItem[];
  counts: { overdue: number; today: number; soon: number };
  truncatedKinds: Kind[];
  generatedAt: string;
}

/** 每一类：叫什么、按钮上写什么、去哪办、截断时去哪看全。
 *  访视页的「下一件」也用它 —— 两处各写一份，就会有一处的去处是错的。 */
export const KIND: Record<Kind, { label: string; go: string; href: (i: InboxItem) => string; all: string }> = {
  sae:           { label: "SAE",      go: "去上报", all: "/quality",
                   href: i => `/quality${i.studySiteId ? `?site=${i.studySiteId}` : ""}` },
  visit:         { label: "访视",     go: "去完成", all: "/subjects", href: i => `/visits/${i.ref.id}` },
  pi_confirm:    { label: "PI 签字",  go: "去登记", all: "/subjects", href: i => `/visits/${i.ref.id}` },
  edc:           { label: "EDC",      go: "去标记", all: "/subjects", href: i => `/visits/${i.ref.id}` },
  query:         { label: "质疑",     go: "去回复", all: "/queries",  href: () => "/queries" },
  handover:      { label: "交接",     go: "去确认", all: "/handovers", href: () => "/handovers" },
  approval:      { label: "审批",     go: "去审",   all: "/approvals", href: () => "/approvals" },
  isf:           { label: "文件",     go: "去处理", all: "/isf",      href: () => "/isf" },
  capa:          { label: "整改",     go: "去处理", all: "/quality",
                   href: i => `/quality${i.studySiteId ? `?site=${i.studySiteId}` : ""}` },
  mvr:           { label: "监查报告", go: "去提交", all: "/monitoring", href: () => "/monitoring" },
  monitor_visit: { label: "监查访视", go: "查看",   all: "/monitoring", href: () => "/monitoring" }
};

/* SAE 单独一组、钉在最上面。服务端已经把它排在最前，但这里还要按紧急程度分段 ——
   不单列的话，一条还剩三小时的 SAE（today）会落到整段「已过期」的访视下面，
   服务端那条排序就白做了。 */
const GROUPS = [
  { id: "sae",     title: "SAE",    sub: "知悉后 24 小时内上报", pick: (i: InboxItem) => i.kind === "sae" },
  { id: "overdue", title: "已过期", sub: "期限已经过了",
    pick: (i: InboxItem) => i.kind !== "sae" && i.urgency === "overdue" },
  { id: "today",   title: "今天",   sub: "今天就是期限",
    pick: (i: InboxItem) => i.kind !== "sae" && i.urgency === "today" },
  { id: "soon",    title: "这几天", sub: "7 天内要办",
    pick: (i: InboxItem) => i.kind !== "sae" && i.urgency === "soon" }
] as const;

/* 离线时给上一次拿到的那份 —— 按账号分开存，共用一台平板时不串。
   **只是一份快照**：页面上写明截至几点，不假装是现在的。 */
const CACHE = "sitedesk.inbox.";
function saveCache(accountId: string, b: Inbox) {
  try { localStorage.setItem(CACHE + accountId, JSON.stringify(b)); } catch { /* 存不下就算了 */ }
}
function readCache(accountId: string): Inbox | null {
  try {
    const raw = localStorage.getItem(CACHE + accountId);
    return raw ? JSON.parse(raw) as Inbox : null;
  } catch { return null; }
}

type Site = { id: string; code: string; hospital: string };

export function TodayPage() {
  const [box, setBox] = useState<Inbox | null>(null);
  const [stale, setStale] = useState(false);
  const [failed, setFailed] = useState(false);
  /** 报 SAE 用：有 subjWrite 才给按钮，中心列表给表单挑。 */
  const [saeSites, setSaeSites] = useState<Site[] | null>(null);

  const load = async () => {
    try {
      const [me, b] = await Promise.all([loadMe(), call<Inbox>("getMyInbox")]);
      setBox(b); setStale(false); saveCache(me.account.id, b);
    } catch {
      const who = recallWho();
      const cached = who ? readCache(who.accountId) : null;
      if (cached) { setBox(cached); setStale(true); } else setFailed(true);
    }
  };

  useEffect(() => {
    void load();
    /* 「报告 SAE」放在首页最上面：原来它在 质量与 SAE → 选中心 → 面板 里，
       而它是一线手上最急、最不能等的一件事。 */
    void loadMe().then(m => {
      if (!m.permissions.actions.includes("subjWrite")) return;
      return call<{ items: Site[] }>("listStudySites", { query: { limit: 200 } })
        .then(r => setSaeSites(r.items));
    }).catch(() => { /* 离线：没有按钮，不报错 —— 登记 SAE 要联网 */ });
  }, []);

  if (failed) return (
    <>
      <div className="page-head"><h2>今天</h2></div>
      <p className="problem" data-testid="today-failed">
        待办没取到，而这台设备上也没有上一次的记录。联网之后刷新一下。
      </p>
    </>
  );
  if (!box) return <p className="muted">加载中…</p>;

  const { counts } = box;
  const at = new Date(box.generatedAt);

  return (
    <>
      <div className="page-head">
        <h2>今天</h2>
        <p data-testid="today-summary">
          {box.items.length === 0 ? "没有要你办的事。"
            : [counts.overdue && `${counts.overdue} 件已过期`,
               counts.today && `${counts.today} 件今天要办`,
               counts.soon && `${counts.soon} 件这几天要办`].filter(Boolean).join("，") + "。"}
        </p>
      </div>

      {saeSites && saeSites.length > 0 && (
        <div style={{ marginBottom: 14 }} data-testid="today-report-sae">
          {/* 登记完回到待办：它会带着 24 小时倒计时出现在最上面 */}
          <ReportSaeForm sites={saeSites} cta="报告 SAE" onCreated={() => void load()} />
        </div>
      )}

      {stale && (
        <div className="problem" data-testid="today-stale" style={{ marginBottom: 14 }}>
          <b>离线</b> —— 下面是 {at.toLocaleString("zh-CN", { hour12: false })} 的待办，可能已经有变化。
        </div>
      )}

      {GROUPS.map(g => {
        const list = box.items.filter(g.pick);
        if (!list.length) return null;
        return (
          <section key={g.id} className="stack" data-testid={`today-${g.id}`}
            style={{ marginBottom: 18 }}>
            <h3>{g.title} <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
              {g.sub} · {list.length}</span></h3>
            <ul className="inbox">
              {list.map(i => <InboxRow key={`${i.kind}:${i.ref.id ?? i.title}`} i={i} />)}
            </ul>
          </section>
        );
      })}

      {box.truncatedKinds.length > 0 && (
        <p className="muted" data-testid="today-truncated">
          每类只列最急的 20 条。其余的在：{box.truncatedKinds.map((k, n) => (
            <span key={k}>{n > 0 && "、"}<Link to={KIND[k].all}>{KIND[k].label}</Link></span>
          ))}。
        </p>
      )}

      <Why style={{ marginTop: 14 }}>
        这里只列<b>你办得了的</b>：没有完成访视权限的角色看不到别人该做的访视，
        没有审批权限的看不到待审工时。SAE 永远排在最前 —— 24 小时是按小时走的，
        一条一个月前就超窗的访视已经是偏离了，SAE 现在办还来得及。
        <br />
        访视只看 7 天内的；更远的在 <Link to="/sched">「我的日程」</Link>，
        全部受试者在 <Link to="/subjects">「受试者访视窗口」</Link>。
      </Why>
    </>
  );
}

/* 类名写全，不拼 —— 拼出来的类名 design.test 查不到定义。 */
const URGENCY_CLASS = { overdue: "u-overdue", today: "u-today", soon: "u-soon" } as const;

/** 一件待办的那一行。中心工作台的「本中心待办」也用它。 */
export function InboxRow({ i }: { i: InboxItem }) {
  const k = KIND[i.kind];
  return (
    <li className={`inbox-item ${URGENCY_CLASS[i.urgency]}`} data-testid="inbox-item" data-kind={i.kind}>
      <span className={`chip ${i.urgency === "overdue" || i.kind === "sae" ? "crit"
        : i.urgency === "today" ? "warn" : "flat"}`}>{k.label}</span>
      <div className="inbox-main">
        <div className="inbox-title">{i.title}</div>
        <div className="inbox-sub muted">
          {[i.screeningNo, i.siteCode].filter(Boolean).join(" · ")}
          {(i.screeningNo || i.siteCode) && " · "}{i.detail}
        </div>
      </div>
      {/* 跟进的那种不是主按钮 —— 主按钮留给「这件事等你办」 */}
      <Link to={k.href(i)} className={`btn inbox-go${i.watch ? "" : " primary"}`}
        data-testid="inbox-go">{i.watch ? "去跟进" : k.go}</Link>
    </li>
  );
}
