import type { CSSProperties, ReactNode } from "react";

/* ════════════════════════════════════════════════════════════════════
   「为什么？」—— 设计理由收起来，要看的人点开。

   ── 这是为什么写的 ────────────────────────────────────────────────
   一线每天打开的那些页，首屏底下常常压着一整段 `.derive`：
   这一页为什么这样排、这个数为什么这样算、那个字段为什么不预填。
   理由本身都是对的，但**它是写给做系统的人的**，不是写给干活的人的。
   CRC 在走廊上拿手机打开受试者那一页，要的是"谁要先办"，
   不是"这一页和『今天』那一页是同一批数据的两种切法"。

   ── 处置：收起，不删 ──────────────────────────────────────────────
   删掉的话，被人问"为什么这个数把没关的也算进去了"时，答案就没了。
   收起来之后首屏只剩一行「为什么？」，想知道的人一点就开。

   里面仍然是 `.derive` —— 样式照旧，而 e2e 断言的是 textContent，
   收起来的内容照样读得到。

   **不该收起来的**：按下去之前必须知道的后果（例如登记脱落那两条），
   以及一个数的推导链本身（工时台账的「为什么是这个数」）。
   那两种是这一步的内容，不是这一页的理由，直接用 `.derive`。
   ════════════════════════════════════════════════════════════════════ */

export function Why({ summary = "为什么？", style, children, ...rest }: {
  summary?: string;
  style?: CSSProperties;
  children: ReactNode;
  "data-testid"?: string;
}) {
  return (
    <details className="why" style={style}>
      <summary>{summary}</summary>
      <div className="derive" data-testid={rest["data-testid"]}>{children}</div>
    </details>
  );
}
