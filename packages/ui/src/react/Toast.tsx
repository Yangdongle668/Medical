import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode
} from "react";

/* ════════════════════════════════════════════════════════════════════
   吐司 —— 一次写操作发生了之后，说一句。

   ── 为什么需要它，而且只需要它这么点 ───────────────────────────
   这个系统里的写操作大多**不改变当前这一页的样子**：勾掉一项启动清单、
   把一个中心推进一档、给一条质疑写回复。人按了按钮，页面没动静，
   于是再按一次 —— 幂等键挡得住重复写入，挡不住"我到底做了没有"这个疑问。

   ── 三条约束 ───────────────────────────────────────────────────
   ① **不做撤销按钮。** 这个系统里的写操作条条进审计轨迹，
      "撤销"是另一条要留痕的记录，不是把上一条抹掉。要撤销就走
      对应的反向命令（reopen / void / amend），它们各自有自己的理由字段。
   ② **失败不用吐司。** 吐司会自己消失，而失败需要人读完并决定下一步。
      失败留在页面上（.problem），不在这里。
   ③ **同一句话不叠。** 连点三次"标记完成"应该看到一条，不是三条。
   ════════════════════════════════════════════════════════════════════ */

type Tone = "good" | "warn" | "crit";
interface Toast { id: number; text: string; tone: Tone }

const Ctx = createContext<((text: string, tone?: Tone) => void) | null>(null);

const LIFE_MS = 4200;

export function ToastHost({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const drop = useCallback((id: number) => {
    setItems(v => v.filter(t => t.id !== id));
    const t = timers.current.get(id);
    if (t) { clearTimeout(t); timers.current.delete(id); }
  }, []);

  const push = useCallback((text: string, tone: Tone = "good") => {
    setItems(v => {
      /* 同一句话已经在屏幕上就不叠 —— 连点三次该看到一条，不是三条。 */
      if (v.some(t => t.text === text)) return v;
      const id = ++seq.current;
      timers.current.set(id, setTimeout(() => drop(id), LIFE_MS));
      /* 最多三条。再多就成了一堵墙，而墙是不读的。 */
      return [...v, { id, text, tone }].slice(-3);
    });
  }, [drop]);

  /* 卸载时把定时器收干净，否则路由一换就是一串 setState-after-unmount。 */
  useEffect(() => () => { timers.current.forEach(clearTimeout); timers.current.clear(); }, []);

  return (
    <Ctx.Provider value={push}>
      {children}
      {/* aria-live="polite"：读屏要念，但不打断人正在念的那句。 */}
      <div className="toasts" role="status" aria-live="polite" data-testid="toasts">
        {items.map(t => (
          <div key={t.id} className={`toast${t.tone === "good" ? "" : " " + t.tone}`}
            data-testid="toast" onClick={() => drop(t.id)}>
            <i />{t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

/** 说一句。没有 ToastHost 时退化成空操作 —— 少一层壳不该让页面崩掉。 */
export function useToast() {
  const push = useContext(Ctx);
  return useMemo(() => push ?? (() => { /* 没有宿主：静默 */ }), [push]);
}
