import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Modal } from "@sitedesk/ui/react";
import { call } from "../api/client.js";
import type { ModuleDef } from "./modules.js";

/* ════════════════════════════════════════════════════════════════════
   全局搜索（Ctrl/⌘ + K）。

   「S-0203 下次什么时候来」「SS-07 是哪家」「工时在哪一页」——
   知道名字，不知道在哪。原来只有管理员的侧栏有一个「跳到…」，
   而且只找页面；找一个受试者要先想起他在哪个中心、再去受试者页里翻。

   一个框，三类结果：**页面**（按这个人侧栏上有的模块匹配，前端算）、
   **中心**、**受试者**（服务端，/v1/search）。回车去第一个，↑↓ 挑，Esc 关。
   离线时服务端那两类没有，页面照样能跳。
   ════════════════════════════════════════════════════════════════════ */

interface Hit { type: "site" | "subject"; id: string; label: string; sub: string; screeningNo?: string }
interface Row { key: string; kind: string; title: string; sub: string; href: string }

/** 敲到第几个字才去问服务端。一个字不问：搜受试者会记一条访问审计，
 *  一个字的结果也没法用。 */
const MIN = 2;

export function CommandPalette({ open, onClose, pages }: {
  open: boolean; onClose: () => void; pages: ModuleDef[];
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const nav = useNavigate();

  /* 打开时焦点给输入框。Modal 自己会把焦点放在面板上（那是对抽屉的正确做法），
     而搜索框打开就是为了打字 —— 晚一拍再抢回来。 */
  useEffect(() => {
    if (!open) { setQ(""); setHits([]); setAt(0); return; }
    const t = setTimeout(() => input.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [open]);

  /* 停手 200ms 再问 —— 每个键都问一次，受试者访问审计就一个键一条 */
  useEffect(() => {
    const needle = q.trim();
    if (needle.length < MIN) { setHits([]); return; }
    const t = setTimeout(() => {
      call<{ items: Hit[] }>("search", { query: { q: needle } })
        .then(r => setHits(r.items)).catch(() => setHits([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  const needle = q.trim().toLowerCase();
  const rows: Row[] = [
    ...(needle ? pages.filter(m => m.title.toLowerCase().includes(needle)
        || m.group.toLowerCase().includes(needle)).slice(0, 6)
      .map(m => ({ key: `p:${m.key}`, kind: "页面", title: m.title, sub: m.group, href: m.path })) : []),
    ...hits.map(h => h.type === "site"
      ? { key: `s:${h.id}`, kind: "中心", title: h.label, sub: h.sub, href: `/sites/${h.id}` }
      : { key: `u:${h.id}`, kind: "受试者", title: h.screeningNo ?? "受试者",
          sub: [h.label, h.sub].filter(Boolean).join(" · "), href: `/subjects/${h.id}` })
  ];
  const cur = Math.min(at, Math.max(rows.length - 1, 0));

  const go = (r: Row | undefined) => {
    if (!r) return;
    onClose();
    nav(r.href);
  };

  return (
    <Modal open={open} onClose={onClose} title="搜索"
      sub="页面名、中心代号或医院、受试者筛选号">
      <input ref={input} value={q} data-testid="palette-input" type="search"
        placeholder="例如：SS-07、协和、S-0203、工时"
        aria-label="搜索页面、中心、受试者"
        onChange={e => { setQ(e.target.value); setAt(0); }}
        onKeyDown={e => {
          if (e.key === "ArrowDown") { e.preventDefault(); setAt(Math.min(cur + 1, rows.length - 1)); }
          if (e.key === "ArrowUp") { e.preventDefault(); setAt(Math.max(cur - 1, 0)); }
          if (e.key === "Enter") { e.preventDefault(); go(rows[cur]); }
        }} />
      <ul className="palette" data-testid="palette-results">
        {rows.map((r, i) => (
          <li key={r.key}>
            <button type="button" className={i === cur ? "on" : ""} data-testid="palette-row"
              onMouseEnter={() => setAt(i)} onClick={() => go(r)}>
              <span className="chip flat">{r.kind}</span>
              <span className="palette-title">{r.title}</span>
              <span className="muted palette-sub">{r.sub}</span>
            </button>
          </li>
        ))}
      </ul>
      {needle && rows.length === 0 && (
        <p className="muted" data-testid="palette-none" style={{ margin: "10px 0 0" }}>
          {needle.length < MIN ? "再多敲一个字 —— 中心与受试者从两个字起搜。" : "没有找到。"}
        </p>
      )}
    </Modal>
  );
}
