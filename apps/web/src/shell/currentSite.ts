import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { recallWho } from "../features/login/session.js";

/* ════════════════════════════════════════════════════════════════════
   当前中心 —— 选一次，各页都认。

   ── 为什么 ──────────────────────────────────────────────────────
   质量与 SAE、药品与样本、预筛登记、工时……每一页各有一个「中心」下拉，
   各自默认成第一个。一个管着 SS-07 的 CRC，每换一页就要再选一次 SS-07；
   从首页的 SAE 待办点过去，落到的是 SS-01 的面板。

   ── 取哪一个 ────────────────────────────────────────────────────
   ① 地址栏 `?site=` —— 链接带过来的（首页待办、中心工作台）最具体；
   ② 这个账号上次选的 —— 存在本机，按账号分开（共用平板时不串）；
   ③ 只有一个中心就是它；
   ④ 否则第一个。
   前两者都要**在这个人的中心列表里**才算数：换了派工之后，
   上次选的那个可能已经不归他了。

   改选时同时写地址栏（换页、刷新、发给同事都带着）和本机（下次打开还记得）。
   ════════════════════════════════════════════════════════════════════ */

const KEY = "sitedesk.site.";
const storeKey = () => KEY + (recallWho()?.accountId ?? "anon");

function readStored(): string | null {
  try { return localStorage.getItem(storeKey()); } catch { return null; }
}
function writeStored(id: string) {
  try { localStorage.setItem(storeKey(), id); } catch { /* 无痕模式写不进去 */ }
}

/** 纯函数，便于测：从候选里按上面的顺序挑一个。候选为空时给空串。
 *  `fallbackFirst: false` 用在「选错了代价大」的地方（预筛登记、填工时）：
 *  不认得就留空让人选，只有一个中心时照样替他选上。 */
export function pickSite(ids: readonly string[], fromUrl: string | null,
                         stored: string | null, fallbackFirst = true): string {
  if (fromUrl && ids.includes(fromUrl)) return fromUrl;
  if (stored && ids.includes(stored)) return stored;
  if (ids.length === 1 || fallbackFirst) return ids[0] ?? "";
  return "";
}

/** 表单里的默认值：上次选的那个（在列表里才算）。**不写地址栏** ——
 *  在一个表单里挑中心，不等于换了"当前中心"。 */
export const rememberedSite = (ids: readonly string[], fallbackFirst = true) =>
  pickSite(ids, null, readStored(), fallbackFirst);

/** `sites` 还没取到时传 null —— 那时先用地址栏的，不回退，免得闪一下第一个中心。 */
export function useCurrentSite(sites: readonly { id: string }[] | null, fallbackFirst = true):
  [string, (id: string) => void] {
  const [params, setParams] = useSearchParams();
  const fromUrl = params.get("site");
  const [id, setId] = useState<string>(fromUrl ?? "");

  useEffect(() => {
    if (!sites) return;
    setId(pickSite(sites.map(s => s.id), fromUrl, readStored(), fallbackFirst));
  }, [sites, fromUrl, fallbackFirst]);

  const choose = (next: string) => {
    setId(next);
    writeStored(next);
    setParams(p => { const q = new URLSearchParams(p); q.set("site", next); return q; },
      { replace: true });
  };
  return [id, choose];
}
