import { type ReactNode, useState } from "react";
import { useWidth } from "./useWidth.js";
import { useTip, TipRow } from "./Tip.js";

/* ════════════════════════════════════════════════════════════════════
   图表原语 —— 移植自 prototype/parts/03-core.html。

   原型文件头写的那几条约束是**量出来的口径**，不是审美偏好，逐条保留：
     · 细笔画：线宽 1.75px，网格与轴线退居后景（--line / --ink-3）；
     · 只做**选择性直标** —— 只标终点，绝不每点标数。每点标数之后
       图就变成了一张排版很差的表，而人来看图正是因为不想读表；
     · ≥2 系列必有图例；
     · 计划=中性参考色（--plan），实际=强调色。**颜色编码的是角色，
       不是好坏** —— 实际低于计划时不变红，差额那一行才说话。

   ── 为什么不引图表库 ────────────────────────────────────────────
   apps/web 的 package.json 里运行时依赖只有 react / react-dom /
   react-router-dom 三个（见 apps/web/README.md）。为四种图引一个
   打包体积以百 KB 计的库，换来的是一套**对不上这份设计令牌**的默认样式，
   然后再写同样多的代码把它改回来。这四种图加起来不到 200 行。
   ════════════════════════════════════════════════════════════════════ */

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const n0 = (v: number) => Math.round(v).toLocaleString("zh-CN");

export interface Series {
  name: string;
  values: number[];
  color: string;
  /** 虚线：计划/参考线用，把"这条是约定"和"这条是发生了的"分开 */
  dash?: boolean;
  /** 线下淡填充：只给"实际"那条，强调它是累积量 */
  fill?: boolean;
}

/* ── 折线：计划 vs 实际，带十字准星与跟随提示 ──────────────────── */
export function LineChart({ x, series, yMax, yFmt = n0, h = 200, label }: {
  x: string[]; series: Series[]; yMax?: number;
  yFmt?: (v: number) => string; h?: number; label?: string;
}) {
  const [box, W] = useWidth<HTMLDivElement>();
  const tip = useTip();
  const [at, setAt] = useState<number | null>(null);

  const P = { t: 12, r: 14, b: 26, l: 44 };
  const iw = Math.max(1, W - P.l - P.r), ih = h - P.t - P.b;
  const max = yMax || Math.max(...series.flatMap(s => s.values), 0) * 1.12 || 1;
  const px = (i: number) => P.l + (x.length > 1 ? i * iw / (x.length - 1) : iw / 2);
  const py = (v: number) => P.t + ih - (v / max) * ih;

  const ticks = [0, 1, 2, 3, 4].map(i => { const v = max * i / 4; return { v, y: py(v) }; });
  const step = x.length > 8 ? 2 : 1;

  /* 命中区盖在绘图区上，按指针的 x 反推最近的一个数据点。
     不用逐点加监听：点多了之后那是几百个监听器，而这里只要一个。 */
  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const r = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
    const sx = (e.clientX - r.left) * W / r.width;
    const i = clamp(Math.round((sx - P.l) / (iw / (x.length - 1 || 1))), 0, x.length - 1);
    setAt(i);
    const diff = series.length === 2
      ? series[1]!.values[i]! - series[0]!.values[i]!
      : null;
    tip.show(<>
      <div className="tip-t">{x[i]}</div>
      {series.map(s => (
        <TipRow key={s.name} value={yFmt(s.values[i]!)}
          label={<><i style={{
            display: "inline-block", width: 12, height: 2, borderRadius: 2,
            background: s.color, verticalAlign: "middle", marginRight: 7, opacity: .9
          }} />{s.name}</>} />
      ))}
      {diff !== null && (
        <div className="tip-r" style={{
          borderTop: "1px solid var(--line)", marginTop: 4, paddingTop: 4
        }}>
          <span>差额</span>
          <b style={{ color: diff < 0 ? "var(--crit)" : "var(--surface)" }}>
            {diff > 0 ? "+" : ""}{n0(diff)}
          </b>
        </div>
      )}
    </>, e.clientX, e.clientY);
  };

  const leave = () => { setAt(null); tip.hide(); };

  return (
    <div className="chart" ref={box} data-testid="line-chart">
      <svg viewBox={`0 0 ${W} ${h}`} role="img"
        aria-label={label ?? `${series.map(s => s.name).join(" 与 ")}趋势`}>
        {ticks.map(t => (
          <line key={t.y} className="gridline"
            x1={P.l} y1={t.y.toFixed(1)} x2={W - P.r} y2={t.y.toFixed(1)} />
        ))}
        {ticks.map(t => (
          <text key={`a${t.y}`} className="axis-t" x={P.l - 7} y={(t.y + 3.5).toFixed(1)}
            textAnchor="end">{yFmt(t.v)}</text>
        ))}
        {x.map((t, i) => (i % step === 0 || i === x.length - 1) && (
          <text key={t + i} className="axis-t" x={px(i).toFixed(1)} y={h - 8}
            textAnchor="middle">{t}</text>
        ))}

        {at !== null && (
          <line className="gridline" stroke="var(--ink-3)" strokeDasharray="3 3"
            x1={px(at)} x2={px(at)} y1={P.t} y2={P.t + ih} />
        )}

        {series.map(s => {
          const d = s.values.map((v, i) =>
            `${i ? "L" : "M"}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(" ");
          return (
            <g key={s.name}>
              {s.fill && (
                <path fill={s.color} opacity=".055"
                  d={`${d} L${px(x.length - 1).toFixed(1)},${P.t + ih} L${px(0).toFixed(1)},${P.t + ih} Z`} />
              )}
              <path d={d} fill="none" stroke={s.color} strokeWidth="1.75"
                strokeLinejoin="round" strokeLinecap="round"
                strokeDasharray={s.dash ? "2 4" : undefined} />
            </g>
          );
        })}

        {/* 选择性直标：只标终点。每点都标就成了排版很差的表。 */}
        {series.map(s => (
          <circle key={`e${s.name}`} r="3.5" fill={s.color}
            cx={px(x.length - 1).toFixed(1)} cy={py(s.values[x.length - 1]!).toFixed(1)}
            stroke="var(--surface)" strokeWidth="2.5" />
        ))}
        {at !== null && series.map(s => (
          <circle key={`c${s.name}`} r="4" fill={s.color}
            cx={px(at)} cy={py(s.values[at]!)}
            stroke="var(--surface)" strokeWidth="2.5" />
        ))}

        <rect x={P.l} y={P.t} width={iw} height={ih} fill="transparent"
          style={{ cursor: "crosshair" }}
          onPointerMove={onMove} onPointerLeave={leave} />
      </svg>
      {tip.node}
    </div>
  );
}

/* ── 迷你走势线（KPI 里那条） ─────────────────────────────────── */
export function Spark({ values, color, w = 76, h = 22 }:
  { values: number[]; color: string; w?: number; h?: number }) {
  if (values.length < 2) return null;
  const mn = Math.min(...values), mx = Math.max(...values), r = (mx - mn) || 1;
  const y = (v: number) => h - 2 - ((v - mn) / r) * (h - 4);
  const d = values.map((v, i) =>
    `${i ? "L" : "M"}${(i * w / (values.length - 1)).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h} aria-hidden="true" style={{ overflow: "visible" }}>
      <path d={d} fill="none" stroke={color} strokeWidth="1.6"
        strokeLinejoin="round" strokeLinecap="round" opacity=".75" />
      <circle cx={w} cy={y(values.at(-1)!)} r="2.6" fill={color} />
    </svg>
  );
}

export interface BarRow {
  label: string; v: number;
  color?: string; vColor?: string;
  /** 参考刻度（如"计划到今日"）—— 一条竖线，不是第二根条 */
  marker?: number;
  tip?: ReactNode;
}

/* ── 横向条：基线锚定 ─────────────────────────────────────────── */
export function HBars({ rows, max, fmt = (v: number) => v.toFixed(1), unit = "",
  h = 12, gap = 11, band }: {
    rows: BarRow[]; max?: number; fmt?: (v: number) => string;
    unit?: string; h?: number; gap?: number;
    /** 健康区间刻度（如利用率 60/88%）—— 让"多少算正常"留在图上 */
    band?: number[];
  }) {
  const tip = useTip();
  if (!rows.length) return <div className="empty">暂无数据</div>;
  const M = max || Math.max(...rows.map(r => Math.abs(r.v))) * 1.05 || 1;

  return (
    <div data-testid="hbars">
      {rows.map(r => (
        <div key={r.label} style={{
          display: "grid", gridTemplateColumns: "minmax(96px,158px) 1fr auto",
          gap: 14, alignItems: "center", marginBottom: gap
        }}
          onPointerMove={r.tip ? e => tip.show(r.tip, e.clientX, e.clientY) : undefined}
          onPointerLeave={r.tip ? tip.hide : undefined}>
          <div title={r.label} style={{
            fontSize: 12.5, color: "var(--ink-2)",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
          }}>{r.label}</div>
          <div className="bartrack" style={{ height: h }}>
            <div className="barfill" style={{
              width: `${clamp(Math.abs(r.v) / M * 100, 2, 100)}%`,
              background: r.color || "var(--accent)", height: "100%"
            }} />
            {r.marker != null && (
              <div style={{
                position: "absolute", left: `${clamp(r.marker / M * 100, 0, 100)}%`,
                top: 0, bottom: 0, width: 1.5, background: "var(--ink)", opacity: .45
              }} />
            )}
            {band?.map(t => (
              <div key={t} style={{
                position: "absolute", left: `${clamp(t / M * 100, 0, 100)}%`,
                top: -3, bottom: -3, width: 2, background: "var(--accent)", borderRadius: 2
              }} />
            ))}
          </div>
          <div className="tnum" style={{
            fontSize: 12.5, minWidth: 58, fontWeight: 600, color: r.vColor || "var(--ink)"
          }}>{fmt(r.v)}{unit}</div>
        </div>
      ))}
      {tip.node}
    </div>
  );
}

/* ── 双向条：零轴居中，正负两色 ───────────────────────────────── */
export function Diverging({ rows, fmt = (v: number) => (v > 0 ? "+" : "") + v.toFixed(1),
  unit = "万" }: { rows: BarRow[]; fmt?: (v: number) => string; unit?: string }) {
  const tip = useTip();
  if (!rows.length) return <div className="empty">暂无数据</div>;
  const M = Math.max(...rows.map(r => Math.abs(r.v))) * 1.08 || 1;

  return (
    <div data-testid="diverging">
      {rows.map(r => {
        const w = Math.abs(r.v) / M * 50, pos = r.v >= 0;
        return (
          <div key={r.label} style={{
            display: "grid", gridTemplateColumns: "minmax(102px,180px) 1fr 74px",
            gap: 14, alignItems: "center", marginBottom: 10
          }}
            onPointerMove={r.tip ? e => tip.show(r.tip, e.clientX, e.clientY) : undefined}
            onPointerLeave={r.tip ? tip.hide : undefined}>
            <div title={r.label} style={{
              fontSize: 12.5, color: "var(--ink-2)",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
            }}>{r.label}</div>
            <div style={{
              position: "relative", height: 11,
              background: "var(--surface-2)", borderRadius: 99
            }}>
              <div style={{
                position: "absolute", left: "50%", top: -3, bottom: -3,
                width: 1, background: "var(--line-2)"
              }} />
              <div style={{
                position: "absolute", top: 0, bottom: 0, width: `${w}%`,
                background: pos ? "var(--ink-2)" : "var(--crit)",
                ...(pos
                  ? { left: "50%", borderRadius: "0 99px 99px 0" }
                  : { right: "50%", borderRadius: "99px 0 0 99px" })
              }} />
            </div>
            <div className="tnum" style={{
              fontSize: 12.5, fontWeight: 600, color: pos ? "var(--ink)" : "var(--crit)"
            }}>{fmt(r.v)}{unit}</div>
          </div>
        );
      })}
      {tip.node}
    </div>
  );
}

/** 图例。两个系列以上必有 —— 靠颜色认系列而颜色没有名字，等于没画。 */
export function Legend({ items, hint }:
  { items: { name: string; color: string }[]; hint?: ReactNode }) {
  return (
    <div className="legend">
      {items.map(s => (
        <span key={s.name}><i style={{ background: s.color }} />{s.name}</span>
      ))}
      {hint && <span className="t-mut" style={{ marginLeft: "auto" }}>{hint}</span>}
    </div>
  );
}
