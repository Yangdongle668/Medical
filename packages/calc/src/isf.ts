import { ratio } from "./kernel.js";

/* ════════════════════════════════════════════════════════════════════
   中心文件与物资（ISF）的口径。

   ── 状态不能存，只能算 ────────────────────────────────────────────
   原型把它写成 `st: "good" | "warn" | "crit"`，而同一行的备注写着
   「2026-10-18 到期，需提前 60 天递交」—— 也就是说，
   状态本来就是从到期日推出来的。

   **存成枚举的后果是它会过期。** 六月标"齐备"的那一项，
   十月已经是缺项，而没有人会回去改。原型自己那句
   「人员资质缺失与药品效期……都能被日历提醒兜住，却经常没人管」，
   说的正是这件事 —— 而一个存着过期状态的系统，连日历都算不上。

   所以库里只存**事实**（在不在、什么时候到期），状态在这里按今天算。

   ── 提前量按类别不同 ──────────────────────────────────────────────
   伦理年度跟踪审查要**提前 60 天**递交（批件到期那天才想起来就晚了）；
   药品效期提前 30 天联系申办方换批就够。
   一刀切的提前量要么让人天天看到红的，要么在最要紧的那一项上来不及。
   ════════════════════════════════════════════════════════════════════ */

export const ISF_CATEGORIES = ["dossier", "credential", "ip", "equipment"] as const;
export type IsfCategory = (typeof ISF_CATEGORIES)[number];

/** 各类别的默认提前量（天）。**它是口径，不是常识** ——
 *  项目上可以在行上覆盖（`leadDays`），但覆盖这件事要留在行上。 */
export const ISF_LEAD_DAYS: Record<IsfCategory, number> = {
  dossier: 60,      // 研究者文件夹：伦理年度跟踪要提前 60 天递交
  credential: 60,   // 人员资质：GCP 证书换证要走培训与考试
  ip: 30,           // 试验用药品：效期前 30 天联系申办方换批
  equipment: 60     // 检验与设备：校准与室间质评证书
};

/** missing 缺失 · expired 已过期 · due 临期 · low 库存不足 · ok 齐备。
 *
 *  **缺失与过期分开** —— 一份从来没有过的证书和一份过期的证书，
 *  要做的事不一样：前者是去要，后者是去换。
 *
 *  **库存排在临期之后**：一批过期的药一盒都不能用，
 *  而库存少还能撑到用完 —— 前者更急。 */
export type IsfStatus = "missing" | "expired" | "due" | "low" | "ok";

export interface IsfInput {
  category: IsfCategory;
  present: boolean;
  /** 到期日。没有到期日的（如方案签收表）只看在不在。 */
  expiresOn: string | null;
  /** 行上覆盖的提前量；空则用类别默认。 */
  leadDays: number | null;
  /** 物资库存与补货线。两个一起有或一起没有 ——
   *  只有库存没有补货线，「少到多少算少」没有答案。 */
  quantity?: number | null;
  reorderAt?: number | null;
}

export interface IsfVerdict {
  status: IsfStatus;
  /** 距到期还有几天。**负数表示已经过期几天** ——
   *  折算成 0 会让"昨天过期"和"今天到期"看起来一样。
   *  没有到期日或已缺失时为 null。 */
  daysLeft: number | null;
  /** 实际用的提前量 —— 界面要说得出"为什么现在就提醒"。 */
  leadDays: number;
}

const days = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

export function isfVerdict(i: IsfInput, today: string): IsfVerdict {
  const lead = i.leadDays ?? ISF_LEAD_DAYS[i.category];
  const low = i.quantity != null && i.reorderAt != null && i.quantity <= i.reorderAt;
  if (!i.present) return { status: "missing", daysLeft: null, leadDays: lead };
  if (!i.expiresOn)
    return { status: low ? "low" : "ok", daysLeft: null, leadDays: lead };
  const left = days(today, i.expiresOn);
  return {
    /* 到期当天算**临期**，不算过期 —— 那一天证书还有效。
       过期与临期都排在库存不足之前：一批过期的药一盒都不能用。 */
    status: left < 0 ? "expired" : left <= lead ? "due" : low ? "low" : "ok",
    daysLeft: left,
    leadDays: lead
  };
}

export interface IsfSummary {
  total: number;
  missing: number;
  expired: number;
  due: number;
  low: number;
  ok: number;
  /** 齐备率 = ok / total。**总数为 0 时为 null，不是 100%** ——
   *  一个还没建清单的中心不是"文件齐备"，是没人查过。 */
  readyRatio: number | null;
  /** 最紧的那一项还剩几天（已过期的取最负的那个）。无到期项时为 null。 */
  worstDaysLeft: number | null;
}

export function isfSummary(vs: readonly IsfVerdict[]): IsfSummary {
  let missing = 0, expired = 0, due = 0, low = 0, ok = 0;
  let worst: number | null = null;
  for (const v of vs) {
    if (v.status === "missing") missing++;
    else if (v.status === "expired") expired++;
    else if (v.status === "due") due++;
    else if (v.status === "low") low++;
    else ok++;
    if (v.daysLeft !== null && (worst === null || v.daysLeft < worst)) worst = v.daysLeft;
  }
  return {
    total: vs.length, missing, expired, due, low, ok,
    readyRatio: ratio(ok, vs.length),
    worstDaysLeft: worst
  };
}

/** 排序权重：**缺失与过期在最前**，其次临期（越近越前），齐备在最后。
 *  核查现场翻的就是这几摞东西，而翻到的顺序应当是最该先处理的那几项。 */
export function isfRank(v: IsfVerdict): number {
  if (v.status === "missing") return -1_000_000;
  if (v.status === "expired") return -900_000 + (v.daysLeft ?? 0);
  if (v.status === "due") return v.daysLeft ?? 0;
  if (v.status === "low") return 500_000;
  return 1_000_000;
}
