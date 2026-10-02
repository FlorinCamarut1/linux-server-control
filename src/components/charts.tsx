"use client";
import { memo, useCallback, useMemo, useRef, useState } from "react";

// Charts drawn as inline SVG. Colors come from the theme's validated chart
// palette (--series-N), text uses text tokens, and every chart can also be
// read as a table.

export type LineSeries = { id: string; label: string; values: (number | null)[] };
export type BarSeries = { id: string; label: string; values: number[] };

const PLOT_HEIGHT = 200;
const MARGIN = { top: 12, right: 16, bottom: 28, left: 48 };
const seriesColor = (index: number) => `var(--series-${(index % 8) + 1})`;

// Measures the chart's container. A callback ref, because the container is a
// different element while there is no data: a ref read once in an effect kept
// watching the placeholder and left the chart at its default width.
function useWidth() {
  const [width, setWidth] = useState(640);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((element: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!element) return;
    // Measure right away: observers only report while the page is visible,
    // and a page opened in a background tab would keep the default width.
    const style = getComputedStyle(element);
    const inner = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    if (inner > 0) setWidth(Math.max(240, inner));
    observer.current = new ResizeObserver(([entry]) => setWidth(Math.max(240, entry.contentRect.width)));
    observer.current.observe(element);
  }, []);
  return { ref, width };
}

// Clean axis ticks: 0 and three or four round steps up to at least `max`.
function niceTicks(max: number) {
  if (!(max > 0)) return [0, 1];
  const rough = max / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= rough)!;
  const ticks = [];
  for (let value = 0; value < max + step * 0.999; value += step) ticks.push(Number(value.toPrecision(6)));
  return ticks;
}

// Formatters are created once: building one for every label was most of the
// cost of drawing a chart or filling its table.
const clockTime = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" });
const dayMonth = new Intl.DateTimeFormat([], { day: "2-digit", month: "2-digit" });
const dateTime = new Intl.DateTimeFormat([], { dateStyle: "short", timeStyle: "short" });
export function formatTime(at: number, spanMs: number) {
  return (spanMs <= 36 * 3600000 ? clockTime : dayMonth).format(at);
}

// The key mirrors the mark: a short line for lines, a square for bars.
function Legend({ series, shape = "line" }: { series: { id: string; label: string }[]; shape?: "line" | "square" }) {
  if (series.length < 2) return null;
  return (
    <ul className="chart-legend">
      {series.map((item, index) => (
        <li key={item.id}><i className={shape} style={{ background: seriesColor(index) }} />{item.label}</li>
      ))}
    </ul>
  );
}

type ChartFrameProps = {
  title: string;
  note?: string;
  // The rows are only built when the table is shown.
  table: { columns: string[]; rows: () => (string | number)[][] };
  children: React.ReactNode;
};
// Card with a title and a switch between the chart and its table view.
export function ChartFrame({ title, note, table, children }: ChartFrameProps) {
  const [showTable, setShowTable] = useState(false);
  return (
    <section className="panel chart-card">
      <div className="panel-head">
        <div>
          <h2>{title}</h2>
          {note && <p>{note}</p>}
        </div>
        <button type="button" className="button" aria-pressed={showTable} onClick={() => setShowTable((value) => !value)}>
          {showTable ? "Chart" : "Table"}
        </button>
      </div>
      {showTable ? (
        <div className="chart-table">
          <table>
            <thead><tr>{table.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
            <tbody>{table.rows().map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}</tbody>
          </table>
        </div>
      ) : children}
    </section>
  );
}

type LineChartProps = {
  times: number[];
  series: LineSeries[];
  unit: string;
  yMax?: number;
  digits?: number;
  empty?: string;
};
// Memoized, with its geometry computed once per data and width: moving the
// pointer only moves the crosshair, and a refresh of the page around the chart
// does not draw it again.
export const LineChart = memo(function LineChart({ times, series, unit, yMax, digits = 1, empty = "No samples in this range yet." }: LineChartProps) {
  const { ref, width } = useWidth();
  const [hovered, setHover] = useState<number | null>(null);
  // A refresh can leave fewer points than the one the pointer was on.
  const hover = hovered !== null && hovered < times.length ? hovered : null;
  const plotWidth = width - MARGIN.left - MARGIN.right;
  const start = times[0] ?? 0, span = Math.max(1, (times.at(-1) ?? 1) - start);
  const format = (value: number | null) => (value === null ? "—" : `${value.toFixed(digits)} ${unit}`);
  const xTicks = useMemo(() => {
    if (times.length < 2) return [];
    const count = Math.max(2, Math.min(6, Math.floor(plotWidth / 110)));
    return Array.from({ length: count }, (_, index) => start + (span * index) / (count - 1));
  }, [times.length, plotWidth, start, span]);
  const drawn = useMemo(() => {
    let max = yMax ?? 0, any = false;
    for (const item of series) for (const value of item.values) if (value !== null) { any = true; if (value > max) max = value; }
    const ticks = niceTicks(max), top = ticks.at(-1)!;
    const x = (at: number) => MARGIN.left + ((at - start) / span) * plotWidth;
    const y = (value: number) => MARGIN.top + PLOT_HEIGHT - (value / top) * PLOT_HEIGHT;
    const paths = series.map((item) => {
      let d = "", open = false;
      item.values.forEach((value, index) => {
        if (value === null) { open = false; return; }
        d += `${open ? "L" : "M"}${x(times[index]).toFixed(1)},${y(value).toFixed(1)}`;
        open = true;
      });
      return d;
    });
    let area = "";
    if (series.length === 1) {
      const points = times.map((at, index) => [at, series[0].values[index]] as const).filter(([, value]) => value !== null);
      if (points.length >= 2) area = `M${x(points[0][0])},${y(0)}` + points.map(([at, value]) => `L${x(at).toFixed(1)},${y(value!).toFixed(1)}`).join("") + `L${x(points.at(-1)![0])},${y(0)}Z`;
    }
    const last = series.map((item) => item.values.findLastIndex((value) => value !== null));
    return { any, ticks, x, y, paths, area, last };
  }, [times, series, yMax, plotWidth, start, span]);

  if (!drawn.any) return <div ref={ref} className="chart-empty">{empty}</div>;

  const { ticks, x, y, paths, area } = drawn;
  const lastIndex = (item: LineSeries) => drawn.last[series.indexOf(item)];
  // End labels for up to four series, skipped where they would overlap.
  const endLabels: { y: number; text: string }[] = [];
  if (series.length <= 4) {
    for (const item of series) {
      const index = lastIndex(item);
      if (index < 0) continue;
      const labelY = y(item.values[index]!);
      if (endLabels.every((label) => Math.abs(label.y - labelY) > 14)) endLabels.push({ y: labelY, text: format(item.values[index]) });
    }
  }
  const pick = (clientX: number, element: SVGSVGElement) => {
    const box = element.getBoundingClientRect();
    const at = start + ((clientX - box.left - MARGIN.left) / plotWidth) * span;
    let best = 0;
    times.forEach((time, index) => { if (Math.abs(time - at) < Math.abs(times[best] - at)) best = index; });
    setHover(best);
  };
  const hoverX = hover === null ? 0 : x(times[hover]);

  return (
    <div ref={ref} className="chart">
      <Legend series={series} />
      <div className="chart-plot">
        <svg
          width={width}
          height={PLOT_HEIGHT + MARGIN.top + MARGIN.bottom}
          role="img"
          aria-label={`${series.map((item) => item.label).join(", ")} over time`}
          tabIndex={0}
          onPointerMove={(event) => pick(event.clientX, event.currentTarget)}
          onPointerLeave={() => setHover(null)}
          onBlur={() => setHover(null)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            setHover((current) => Math.max(0, Math.min(times.length - 1, (current ?? times.length - 1) + (event.key === "ArrowLeft" ? -1 : 1))));
          }}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line className="chart-grid" x1={MARGIN.left} x2={MARGIN.left + plotWidth} y1={y(tick)} y2={y(tick)} />
              <text className="chart-axis" x={MARGIN.left - 8} y={y(tick)} dy="0.32em" textAnchor="end">{tick.toLocaleString()}</text>
            </g>
          ))}
          {xTicks.map((at, index) => (
            <text key={at} className="chart-axis" x={x(at)} y={MARGIN.top + PLOT_HEIGHT + 18} textAnchor={index === 0 ? "start" : index === xTicks.length - 1 ? "end" : "middle"}>{formatTime(at, span)}</text>
          ))}
          {area && <path d={area} fill={seriesColor(0)} opacity={0.1} />}
          {paths.map((d, index) => <path key={series[index].id} d={d} fill="none" stroke={seriesColor(index)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />)}
          {series.map((item, index) => {
            const last = lastIndex(item);
            return last < 0 ? null : <circle key={item.id} cx={x(times[last])} cy={y(item.values[last]!)} r={4} fill={seriesColor(index)} stroke="var(--surface)" strokeWidth={2} />;
          })}
          {hover !== null && (
            <g>
              <line className="chart-crosshair" x1={hoverX} x2={hoverX} y1={MARGIN.top} y2={MARGIN.top + PLOT_HEIGHT} />
              {series.map((item, index) => item.values[hover] === null ? null : (
                <circle key={item.id} cx={hoverX} cy={y(item.values[hover]!)} r={4} fill={seriesColor(index)} stroke="var(--surface)" strokeWidth={2} />
              ))}
            </g>
          )}
        </svg>
        {hover === null && endLabels.map((label) => (
          <span key={label.text + label.y} className="chart-end-label" style={{ top: label.y }}>{label.text}</span>
        ))}
        {hover !== null && (
          <div className="chart-tooltip" style={{ left: Math.min(hoverX + 12, width - 180), top: MARGIN.top }}>
            <small>{dateTime.format(times[hover])}</small>
            {series.map((item, index) => (
              <div key={item.id}><i style={{ background: seriesColor(index) }} /><b>{format(item.values[hover])}</b><span>{item.label}</span></div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

type ColumnChartProps = {
  labels: string[];
  series: BarSeries[];
  unit: string;
  digits?: number;
  empty?: string;
};
// Stacked columns with a 2px surface gap between segments and rounded tops.
export const ColumnChart = memo(function ColumnChart({ labels, series, unit, digits = 2, empty = "No data in this range yet." }: ColumnChartProps) {
  const { ref, width } = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const plotWidth = width - MARGIN.left - MARGIN.right;
  const totals = labels.map((_, index) => series.reduce((sum, item) => sum + (item.values[index] || 0), 0));
  if (!totals.some((total) => total > 0)) return <div ref={ref} className="chart-empty">{empty}</div>;
  const ticks = niceTicks(Math.max(...totals));
  const top = ticks.at(-1)!;
  const band = plotWidth / labels.length;
  const barWidth = Math.min(24, Math.max(4, band - 4));
  const y = (value: number) => MARGIN.top + PLOT_HEIGHT - (value / top) * PLOT_HEIGHT;
  const every = Math.ceil(labels.length / Math.max(2, Math.floor(plotWidth / 56)));
  const format = (value: number) => `${value.toFixed(digits)} ${unit}`;
  const hoverLeft = hover === null ? 0 : MARGIN.left + band * hover + band / 2;
  return (
    <div ref={ref} className="chart">
      <Legend series={series} shape="square" />
      <div className="chart-plot">
        <svg width={width} height={PLOT_HEIGHT + MARGIN.top + MARGIN.bottom} role="img" aria-label={`${unit} per period`} onPointerLeave={() => setHover(null)}>
          {ticks.map((tick) => (
            <g key={tick}>
              <line className="chart-grid" x1={MARGIN.left} x2={MARGIN.left + plotWidth} y1={y(tick)} y2={y(tick)} />
              <text className="chart-axis" x={MARGIN.left - 8} y={y(tick)} dy="0.32em" textAnchor="end">{tick.toLocaleString()}</text>
            </g>
          ))}
          {labels.map((label, index) => {
            const left = MARGIN.left + band * index + (band - barWidth) / 2;
            let cumulative = 0;
            const segments = series.map((item, seriesIndex) => {
              const value = item.values[index] || 0;
              if (value <= 0) return null;
              // A segment above another starts 2px higher: the surface gap.
              const bottom = y(cumulative) - (cumulative > 0 ? 2 : 0);
              cumulative += value;
              const topY = Math.min(bottom - 1, y(cumulative));
              const isTop = series.slice(seriesIndex + 1).every((next) => !(next.values[index] > 0));
              const radius = isTop ? Math.min(4, barWidth / 2, bottom - topY) : 0;
              const d = `M${left},${bottom}V${topY + radius}`
                + (radius ? `Q${left},${topY} ${left + radius},${topY}H${left + barWidth - radius}Q${left + barWidth},${topY} ${left + barWidth},${topY + radius}` : `H${left + barWidth}`)
                + `V${bottom}Z`;
              return <path key={item.id} d={d} fill={seriesColor(seriesIndex)} opacity={hover === null || hover === index ? 1 : 0.55} />;
            });
            return (
              <g key={label}>
                {segments}
                <rect
                  x={MARGIN.left + band * index}
                  y={MARGIN.top}
                  width={band}
                  height={PLOT_HEIGHT}
                  fill="transparent"
                  tabIndex={0}
                  aria-label={`${label}: ${format(totals[index])}`}
                  onPointerEnter={() => setHover(index)}
                  onFocus={() => setHover(index)}
                  onBlur={() => setHover(null)}
                />
                {index % every === 0 && <text className="chart-axis" x={MARGIN.left + band * index + band / 2} y={MARGIN.top + PLOT_HEIGHT + 18} textAnchor="middle">{label}</text>}
              </g>
            );
          })}
        </svg>
        {hover !== null && (
          <div className="chart-tooltip" style={{ left: Math.min(hoverLeft + 12, width - 180), top: MARGIN.top }}>
            <small>{labels[hover]}</small>
            {series.length > 1 && <div><i /><b>{format(totals[hover])}</b><span>Total</span></div>}
            {series.map((item, index) => (
              <div key={item.id}><i style={{ background: seriesColor(index) }} /><b>{format(item.values[hover] || 0)}</b><span>{item.label}</span></div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

export type Range = "24h" | "7d" | "30d";
const RANGES = [["24h", "Last 24 hours"], ["7d", "Last 7 days"], ["30d", "Last 30 days"]] as const;
// One range selector above the charts it scopes.
export function RangeFilter({ value, onChange }: { value: string; onChange: (value: Range) => void }) {
  return <div className="chart-filters">
    <div className="container-filters" role="radiogroup" aria-label="Time range">
      {RANGES.map(([id, label]) => <button key={id} type="button" role="radio" aria-checked={value === id} className={value === id ? "active" : ""} title={label} onClick={() => onChange(id)}>{label}</button>)}
    </div>
  </div>;
}
