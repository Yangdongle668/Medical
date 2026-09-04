import { useCallback, useState, type CSSProperties, type ReactNode } from "react";

/* ════════════════════════════════════════════════════════════════════
   跟随指针的提示层。

   原型里是一个全局 `.tip` 元素配 showTip/hideTip 两个函数。
   这里做成 hook + 元素对：**谁用谁自己带一个**。

   理由是卸载。全局单例在 React 里要考虑"图表卸载了但提示还挂着"——
   路由一换就能复现。每个图表自带一个，卸载时跟着走，这个问题不存在。

   `.tip` 是 `position:fixed; pointer-events:none`，
   所以挂在组件树的哪一层都不影响它的位置，也不会挡住底下的命中区。
   ════════════════════════════════════════════════════════════════════ */

interface TipState { x: number; y: number; body: ReactNode }

/** 贴边翻转：靠右时向左展开，靠下时向上展开 —— 否则提示会被视口切掉。
 *  只写用得上的那两个方向：`exactOptionalPropertyTypes` 下
 *  显式写 `left: undefined` 与不写 `left` 不是一回事。 */
function place(x: number, y: number): CSSProperties {
  const vw = typeof window === "undefined" ? 1024 : window.innerWidth;
  const vh = typeof window === "undefined" ? 768 : window.innerHeight;
  return {
    ...(x > vw - 290 ? { right: vw - x + 14 } : { left: x + 14 }),
    ...(y > vh - 150 ? { bottom: vh - y + 16 } : { top: y + 16 })
  };
}

export function useTip() {
  const [tip, setTip] = useState<TipState | null>(null);

  const show = useCallback((body: ReactNode, x: number, y: number) =>
    setTip({ body, x, y }), []);
  const hide = useCallback(() => setTip(null), []);

  const node = tip
    ? <div className="tip on" role="tooltip" style={place(tip.x, tip.y)}>{tip.body}</div>
    : null;

  return { show, hide, node };
}

/** 提示里的一行：左边名目、右边数值。数值等宽，因为要竖着比。 */
export function TipRow({ label, value, color }:
  { label: ReactNode; value: ReactNode; color?: string }) {
  return (
    <div className="tip-r">
      <span>{label}</span>
      <b style={color ? { color } : undefined}>{value}</b>
    </div>
  );
}
