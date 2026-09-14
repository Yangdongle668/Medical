import { json } from "express";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { allEndpoints } from "@sitedesk/contracts";

/* ════════════════════════════════════════════════════════════════════
   哪几条端点收文件，就给哪几条放大请求体上限 —— **名单从契约里取**。

   ── 这是从一次线上 422 里长出来的 ──────────────────────────────────
   express 的 JSON 解析默认上限是 **100 KB**。原来这里写的是：

     app.use("/v1/site-acceptances", (req, res, next) =>
       req.method === "POST" && req.url.includes(":record-letter") ? big : next())

   写的时候只有 `:record-letter` 收文件，这条判断是对的。
   后来「立项受理收成一步」给 `POST /v1/site-acceptances` 也加了
   `letter` 字段 —— 一步填完，两个日期加一份意见函。
   **那条路径里没有 `:record-letter`**，于是它落回 100 KB。

   现场报的是：一份 **100 KB** 的 PDF 递不进去，回 422，
   而 422 的正文写着「受理意向函的上限是 10 MB」。
   一条同时说着"太大了"和"上限 10 MB"的报错，没有人能从中看出该做什么。

   ── 所以判据不能是路径里有没有某个词 ──────────────────────────────
   真正的判据是**这条端点的请求体里有没有文件**，而那件事契约自己知道：
   带文件的请求体里一定有 `contentBase64`（见 site/model.ts 的
   `AcceptanceLetterFile`）。从 `allEndpoints()` 里筛，下一条收文件的端点
   加进来时**自动落在名单里**，不需要有人记得回来改这里。

   ── 仍然不全局放大 ────────────────────────────────────────────────
   把上限提到 15 MB 等于给每一条 POST 都开了那么大的口子，而那是一条
   最便宜的拖垮路径。大小的真正判定在服务层（10 MB，按 base64 解出来
   之后算）与库里的 CHECK 上，这里放的只是"让它进得来"那一道。
   15 MB 是 10 MB 的 base64 膨胀（×4/3）再留一点余量。
   ════════════════════════════════════════════════════════════════════ */

/** 15 MB —— 10 MB 的 base64 膨胀（×4/3）再留一点余量。 */
export const UPLOAD_BODY_LIMIT = "15mb";

/** 契约里带文件的那几条端点。**导出是为了让测试拿同一份名单** ——
 *  测试里另抄一份的话，它验的是那份副本，不是真正生效的那一份。 */
export function fileEndpoints(): { method: string; path: string }[] {
  return allEndpoints()
    .filter(e => {
      if (!e.body) return false;
      try {
        const schema = (e.body as { toJSONSchema?: () => unknown }).toJSONSchema?.();
        return JSON.stringify(schema ?? {}).includes("contentBase64");
      } catch { return false; }
    })
    .map(e => ({ method: e.method.toUpperCase(), path: e.path }));
}

/** 契约路径 → 匹配实际请求路径的正则。
 *  `{id}` 换成一段通配；`:` 之类的正则元字符先转义。
 *  结尾锚 `(\?|$)`，否则 `/v1/site-acceptances` 会连
 *  `/v1/site-acceptances/xxx:record-letter` 一起吃掉 —— 那正好是这次要
 *  分开的两条（虽然两条都在名单里，但"顺手吃掉"是下一个 bug 的形状）。 */
function toRegExp(path: string): RegExp {
  const body = path
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\\\{(\w+)\\\}/g, "[^/]+");
  return new RegExp(`^${body}(\\?|$)`);
}

/** 装在应用最前面：请求落在带文件的端点上时，用放大的解析器。 */
export function uploadBodyLimit(): RequestHandler {
  const big = json({ limit: UPLOAD_BODY_LIMIT });
  const routes = fileEndpoints().map(r => ({ method: r.method, re: toRegExp(r.path) }));
  return (req: Request, res: Response, next: NextFunction) => {
    const path = req.originalUrl || req.url;
    return routes.some(r => r.method === req.method && r.re.test(path))
      ? big(req, res, next)
      : next();
  };
}
