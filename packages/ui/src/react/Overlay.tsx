import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/* ════════════════════════════════════════════════════════════════════
   悬浮层 —— 抽屉与模态。**整个 web 端此前一个都没有。**

   ── 为什么这件事要紧 ────────────────────────────────────────────
   原型里有 33 处抽屉。它承担的是同一件事：**看明细不必离开当前这一页**。
   台账上点开一个中心，右边滑出它的详情，关掉之后筛选、滚动位置、
   排序全都还在。换成路由跳转的话，这三样每次都要重来一遍 ——
   而"挨个看一遍今天异常的那几个中心"正是这一页最主要的用法。

   ── 三件容易漏的事 ─────────────────────────────────────────────
   ① **进场动画要等一帧。** 挂载即带 `.on` 的话浏览器只看到终态，
      transform 从来没变过，动画不发生 —— 抽屉是"啪"地出现的。
   ② **退场要等动画结束再卸载。** 立刻卸载的话关闭没有动画，
      而开有关没有比两边都没有更刺眼。
   ③ **焦点要收进来，关掉要还回去。** 不收，Tab 会走到抽屉背后
      那张看不见的表格上；不还，关掉之后焦点在 body 上，
      键盘用户丢失了自己刚才的位置。
   ════════════════════════════════════════════════════════════════════ */

const EXIT_MS = 280;

interface Base {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** 标题下面那行小字：说明这是什么、数据截止到什么时候 */
  sub?: ReactNode;
  children: ReactNode;
  /** 底部动作区。放在这里而不是内容里，滚动时它不该跟着滚走。 */
  foot?: ReactNode;
}

/** 进场/退场：`mounted` 管在不在 DOM 里，`on` 管那个类。 */
function useTransition(open: boolean) {
  const [mounted, setMounted] = useState(open);
  const [on, setOn] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      /* 两帧。一帧在 Chrome 上偶尔仍会被合并掉。 */
      const r = requestAnimationFrame(() => requestAnimationFrame(() => setOn(true)));
      return () => cancelAnimationFrame(r);
    }
    setOn(false);
    const t = setTimeout(() => setMounted(false), EXIT_MS);
    return () => clearTimeout(t);
  }, [open]);

  return { mounted, on };
}

/** Esc 关闭 + 焦点收拢与归还 + 背景不跟着滚。 */
function useDismiss(open: boolean, onClose: () => void) {
  const panel = useRef<HTMLDivElement | null>(null);
  const restore = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restore.current = document.activeElement as HTMLElement | null;

    /* 焦点落在面板上，而不是里面第一个控件上 ——
       落在控件上等于替人做了"你现在要改这个"的决定。 */
    panel.current?.focus();

    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); return; }
      if (e.key !== "Tab" || !panel.current) return;
      /* 焦点环：Tab 走到尽头回到开头，Shift+Tab 反之。
         不做环的话，Tab 会走到抽屉背后那张看不见的表格上。 */
      const items = panel.current.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),' +
        'textarea:not([disabled]),[tabindex]:not([tabindex="-1"])');
      if (!items.length) return;
      const first = items[0]!, last = items[items.length - 1]!;
      if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    };

    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
      restore.current?.focus?.();
    };
  }, [open, onClose]);

  return panel;
}

function Shell({ open, onClose, title, sub, children, foot, kind }: Base & {
  kind: "drawer" | "modal";
}) {
  const { mounted, on } = useTransition(open);
  const panel = useDismiss(open, onClose);
  const close = useCallback(() => onClose(), [onClose]);
  if (!mounted) return null;

  return (
    <>
      <div className={`scrim${on ? " on" : ""}`} onClick={close} />
      <div className={`${kind}${on ? " on" : ""}`} ref={panel} tabIndex={-1}
        role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined}
        data-testid={kind}>
        <div className="drawer-h">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 style={{ fontSize: 16 }}>{title}</h3>
            {sub && <div className="note" style={{ marginTop: 3 }}>{sub}</div>}
          </div>
          <button className="x" onClick={close} aria-label="关闭" data-testid="overlay-close">✕</button>
        </div>
        <div className="drawer-b">{children}</div>
        {foot && (
          <div style={{
            padding: "14px 28px", borderTop: "1px solid var(--line)",
            display: "flex", gap: 8, justifyContent: "flex-end"
          }}>{foot}</div>
        )}
      </div>
    </>
  );
}

/** 右侧滑出的明细层。看明细不必离开当前这一页。 */
export function Drawer(p: Base) { return <Shell {...p} kind="drawer" />; }

/** 居中模态。**只给需要当场确认的动作** —— 看的东西一律用抽屉：
 *  模态会把背景整个挡住，而"我刚才在看哪一行"往往正是决策的一半。 */
export function Modal(p: Base) { return <Shell {...p} kind="modal" />; }
