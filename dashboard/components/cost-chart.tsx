import type { SeriesPoint } from "@/lib/proxy";

const WIDTH = 760;
const HEIGHT = 190;
const PADDING = { top: 14, right: 16, bottom: 26, left: 62 };

function usd(value: number): string {
  return `$${value.toFixed(4)}`;
}

/** A small inline SVG chart. No chart library, no client-side canvas. */
export function CostChart({ points }: { points: SeriesPoint[] }) {
  const innerWidth = WIDTH - PADDING.left - PADDING.right;
  const innerHeight = HEIGHT - PADDING.top - PADDING.bottom;
  const maxCost = points.reduce((max, point) => Math.max(max, point.cost), 0);
  const scaleMax = maxCost > 0 ? maxCost * 1.25 : 0.0001;

  const x = (index: number): number =>
    points.length <= 1
      ? PADDING.left + innerWidth / 2
      : PADDING.left + (index / (points.length - 1)) * innerWidth;
  const y = (cost: number): number => PADDING.top + innerHeight - (cost / scaleMax) * innerHeight;

  const line = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(point.cost).toFixed(1)}`)
    .join(" ");
  const area =
    points.length > 1
      ? `${line} L${x(points.length - 1).toFixed(1)},${PADDING.top + innerHeight} L${x(0).toFixed(1)},${PADDING.top + innerHeight} Z`
      : "";

  const gridLines = [0, 0.25, 0.5, 0.75, 1];
  const labelIndexes = [0, Math.floor(points.length / 2), Math.max(points.length - 1, 0)];

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="h-auto w-full"
      role="img"
      aria-label="Cost per minute"
    >
      {gridLines.map((ratio) => {
        const gy = PADDING.top + innerHeight - ratio * innerHeight;
        return (
          <g key={ratio}>
            <line
              x1={PADDING.left}
              x2={WIDTH - PADDING.right}
              y1={gy}
              y2={gy}
              stroke="rgb(63 63 70)"
              strokeDasharray={ratio === 0 ? undefined : "3 4"}
              strokeOpacity={0.5}
            />
            <text x={PADDING.left - 8} y={gy + 4} textAnchor="end" className="fill-zinc-500 text-[10px]">
              {usd(scaleMax * ratio)}
            </text>
          </g>
        );
      })}

      {area ? <path d={area} fill="rgb(45 212 191)" fillOpacity={0.12} /> : null}
      {line ? <path d={line} fill="none" stroke="rgb(45 212 191)" strokeWidth={2} /> : null}

      {points.map((point, index) => (
        <circle
          key={point.minute}
          cx={x(index)}
          cy={y(point.cost)}
          r={2.5}
          fill="rgb(45 212 191)"
        >
          <title>
            {`${point.minute} — ${usd(point.cost)}, ${point.requests} request(s)`}
          </title>
        </circle>
      ))}

      {labelIndexes.map((index) =>
        points[index] ? (
          <text
            key={`label-${index}`}
            x={x(index)}
            y={HEIGHT - 8}
            textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}
            className="fill-zinc-500 text-[10px]"
          >
            {points[index]!.minute.slice(11, 16)}
          </text>
        ) : null,
      )}
    </svg>
  );
}
