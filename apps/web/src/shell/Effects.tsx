import { SIDE_EFFECT_LABEL } from "@sitedesk/contracts";

/* ════════════════════════════════════════════════════════════════════
   「这一次提交，系统还做了这些」里的每一行。

   原来六个页面各自写 `<div className="t">{e.type}</div>` —— 显示的是
   枚举键：一线完成一次访视，读到的是 COMPENSATIONDUE、TIMESHEETPOSTED。
   这一块存在的理由是「让一线立刻知道自己不只是打了个卡」，
   而一串大写英文什么也没让他知道。

   中文名在契约里（SIDE_EFFECT_LABEL），枚举键留在 `data-type` 上 ——
   程序和测试认键，人读名字。
   ════════════════════════════════════════════════════════════════════ */

const label = (type: string) =>
  (SIDE_EFFECT_LABEL as Record<string, string>)[type] ?? "系统记录";

export function EffectItem({ type, summary }: { type: string; summary: string }) {
  return (
    <li data-type={type}>
      <div className="t">{label(type)}</div>
      <div>{summary}</div>
    </li>
  );
}
