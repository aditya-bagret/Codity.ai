import type { ThroughputBucket } from "../api/types";

/** Stacked per-minute bar chart of succeeded (green) vs failed (red) executions. */
export function ThroughputChart({
  buckets,
  height = 120,
}: {
  buckets: ThroughputBucket[];
  height?: number;
}) {
  const width = 720;
  const n = buckets.length || 1;
  const barW = width / n;
  const max = Math.max(1, ...buckets.map((b) => b.succeeded + b.failed));
  const scale = (height - 4) / max;
  const total = buckets.reduce((sum, b) => sum + b.succeeded + b.failed, 0);

  return (
    <div className="chart-wrap">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="throughput-chart"
        role="img"
        aria-label="Throughput over the last hour"
      >
        {buckets.map((b, i) => {
          const okH = b.succeeded * scale;
          const errH = b.failed * scale;
          const x = i * barW + 0.5;
          const w = Math.max(barW - 1.5, 1);
          const label = `${new Date(b.minute).toLocaleTimeString()} — ${b.succeeded} ok, ${b.failed} failed`;
          return (
            <g key={b.minute}>
              <title>{label}</title>
              <rect x={x} y={height - okH} width={w} height={okH} className="bar-ok" />
              <rect x={x} y={height - okH - errH} width={w} height={errH} className="bar-err" />
              {okH + errH === 0 && (
                <rect x={x} y={height - 1} width={w} height={1} className="bar-zero" />
              )}
            </g>
          );
        })}
      </svg>
      <div className="chart-legend">
        <span>
          <i className="dot dot-ok" /> succeeded
        </span>
        <span>
          <i className="dot dot-err" /> failed
        </span>
        <span className="chart-total">{total} executions / 60 min</span>
      </div>
    </div>
  );
}

/** Tiny line chart of a worker's in-flight job count over time. */
export function Sparkline({ points, height = 36 }: { points: number[]; height?: number }) {
  const width = 220;
  if (points.length === 0) return <span className="muted">no data</span>;
  const max = Math.max(1, ...points);
  const step = width / Math.max(points.length - 1, 1);
  const path = points
    .map((v, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${(height - 2 - (v / max) * (height - 4)).toFixed(1)}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="sparkline" preserveAspectRatio="none">
      <path d={path} fill="none" />
    </svg>
  );
}
