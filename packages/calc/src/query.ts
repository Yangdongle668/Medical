import { ratio } from "./kernel.js";

/* ════════════════════════════════════════════════════════════════════
   数据质疑的口径。

   ── 平均挂起天数有一个和 SAE 及时率一模一样的后门 ──────────────────
   最省事的算法是「已关闭的那些平均花了几天」：

       平均 = Σ(关闭日 − 提出日) / 已关闭条数

   它的后门是：**一条质疑只要永远不关，就永远不进分母。**
   于是挂得越久的越不影响这个数字，看板反而越好看 ——
   而"平均 4.2 天，目标 5 天"底下压着一条挂了 21 天没人管的质疑。

   所以这里把**未关闭的也算进去**，按"到今天为止已经挂了多少天"计。
   它们正是把这个数拖上去的那些，而拖上去是对的。

   ── 每例质疑数：入组 0 例的中心不是 0 条/例 ────────────────────────
   原型写的是 `ss.enrolled ? l.length/ss.enrolled : 0` ——
   没入组的中心密度显示成 0，在排序里落到最干净的一端。
   但"这个中心录得很干净"和"这个中心还没开始录"是两回事，
   而后者伪装成前者，恰好会让人不去看它。这里返回 null。

   ── 密度高不一定是中心差 ──────────────────────────────────────────
   原型自己写了这句话，但没给区分的办法。区分的线索是**集中度**：
   质疑扎堆在一个表单上，是这个表单本身难填（方案问题，改的是 eCRF 或培训材料）；
   散在七八个表单上，才是这家中心的录入质量问题（改的是人）。
   所以密度和集中度必须一起给 —— 只给密度，那句话就只是免责声明。
   ════════════════════════════════════════════════════════════════════ */

/** 挂起超过这条线，靠系统提醒已经不够了 —— 该打电话。 */
export const QUERY_STALE_DAYS = 7;
/** 平均挂起的目标线。超过它不阻断任何事，但它是这一页存在的理由。 */
export const QUERY_TARGET_DAYS = 5;
/** 每例质疑数的两条带：黄线与红线。 */
export const QUERY_DENSITY_WATCH = 0.2;
export const QUERY_DENSITY_BAD = 0.4;

export type QueryState = "open" | "pending_review" | "closed";

export interface QueryRecord {
  /** 从提出到关闭（或到今天）的天数。**由调用方给出** ——
   *  它和质量事件的 ageDays 是同一个定义，在这里再定义一次就有了两个。 */
  ageDays: number;
  state: QueryState;
}

export interface QueryLoad {
  total: number;
  /** 待中心回复 */
  open: number;
  /** 待中心回复且已挂起超过 QUERY_STALE_DAYS —— 该打电话的那些 */
  stale: number;
  /** 已回复待关闭。**这一格堆积是 DM 自己的欠账**，不是中心的。 */
  pendingReview: number;
  /** 已回复待关闭且已经超过目标天数 —— 判定也是要花时间的，
   *  但判定花掉的时间同样记在这个系统头上。 */
  staleReview: number;
  closed: number;
  /** 平均挂起天数。未关闭的按"到今天"计入（见文件头）。无质疑时为 null。 */
  meanAgeDays: number | null;
  /** 最久的那一条挂了多少天。平均是 4.2 天远不如"最坏的挂了 21 天"能让人动。 */
  worstAgeDays: number | null;
  /** 平均是否达标。无质疑时为 null —— 「没有质疑」不等于「达标」。 */
  meetsTarget: boolean | null;
}

export function queryLoad(rs: readonly QueryRecord[]): QueryLoad {
  let open = 0, stale = 0, pendingReview = 0, staleReview = 0, closed = 0;
  let sum = 0, worst: number | null = null;
  for (const r of rs) {
    sum += r.ageDays;
    if (worst === null || r.ageDays > worst) worst = r.ageDays;
    if (r.state === "open") {
      open++;
      if (r.ageDays > QUERY_STALE_DAYS) stale++;
    } else if (r.state === "pending_review") {
      pendingReview++;
      if (r.ageDays > QUERY_TARGET_DAYS) staleReview++;
    } else closed++;
  }
  const mean = rs.length ? sum / rs.length : null;
  return {
    total: rs.length, open, stale, pendingReview, staleReview, closed,
    meanAgeDays: mean, worstAgeDays: worst,
    meetsTarget: mean === null ? null : mean <= QUERY_TARGET_DAYS
  };
}

export type DensityBand = "ok" | "watch" | "bad";

/** 密度落在哪一带。没入组的中心没有密度，也就没有带 —— null。 */
export function densityBand(perSubject: number | null): DensityBand | null {
  if (perSubject === null) return null;
  if (perSubject > QUERY_DENSITY_BAD) return "bad";
  if (perSubject > QUERY_DENSITY_WATCH) return "watch";
  return "ok";
}

export interface SiteQueryInput {
  studySiteId: string;
  /** 已入组例数。0 表示还没开始录 —— 不是"录得很干净"。 */
  enrolled: number;
  queries: readonly (QueryRecord & { form: string })[];
}

export interface SiteQueryDensity {
  studySiteId: string;
  enrolled: number;
  total: number;
  open: number;
  meanAgeDays: number | null;
  /** 每例质疑数。入组 0 例为 null（见文件头）。 */
  perSubject: number | null;
  band: DensityBand | null;
  /** 质疑最多的那个表单，以及它占这个中心全部质疑的比例。
   *  集中度高 → 表单/方案问题；散开 → 录入质量问题。无质疑时为 null。 */
  topForm: string | null;
  topFormShare: number | null;
}

export function siteQueryDensity(s: SiteQueryInput): SiteQueryDensity {
  const load = queryLoad(s.queries);
  const byForm = new Map<string, number>();
  for (const q of s.queries) byForm.set(q.form, (byForm.get(q.form) ?? 0) + 1);
  /* 并列第一按表单名定序 —— 否则同一份数据两次渲染给出两个"主要表单"。 */
  const top = [...byForm.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return {
    studySiteId: s.studySiteId,
    enrolled: s.enrolled,
    total: load.total,
    open: load.open,
    meanAgeDays: load.meanAgeDays,
    perSubject: s.enrolled > 0 ? s.queries.length / s.enrolled : null,
    band: densityBand(s.enrolled > 0 ? s.queries.length / s.enrolled : null),
    topForm: top ? top[0] : null,
    topFormShare: top ? ratio(top[1], load.total) : null
  };
}

/** 集中度到了这条线，就该去看这个表单本身而不是这家中心。 */
export const FORM_CONCENTRATED = 0.5;

/** 这家中心的质疑该归因给谁：表单，还是录入的人。
 *  质疑太少（≤ 2 条）时不下结论 —— 两条质疑碰巧同一个表单说明不了什么。 */
export function densityVerdict(d: SiteQueryDensity):
  "too-few" | "form" | "entry" {
  if (d.total <= 2) return "too-few";
  return (d.topFormShare ?? 0) >= FORM_CONCENTRATED ? "form" : "entry";
}
