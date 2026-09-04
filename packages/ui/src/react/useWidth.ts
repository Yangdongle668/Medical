import { useEffect, useRef, useState } from "react";

/* 图表要按**实际像素宽**画，不能靠 viewBox 拉伸。
   拉伸的后果不是"图小一点"，是 1.75px 的线宽被横向放大而纵向不变 ——
   线会变成楔形，网格线也跟着糊。所以量一次，重排时再量。

   量不到时（SSR、jsdom、display:none）退回 640 ——
   原型里 `box.clientWidth||640` 用的是同一个数。 */
export function useWidth<T extends HTMLElement>(fallback = 640) {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(fallback);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    /* jsdom 里没有 ResizeObserver，测试环境不该因为这个炸掉。 */
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => {
      const next = e?.contentRect.width ?? 0;
      if (next > 0) setW(next);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, w] as const;
}
