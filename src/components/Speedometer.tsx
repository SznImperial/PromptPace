'use client';

import React from 'react';
import { Gauge, Flame, TrendingUp } from 'lucide-react';

interface SpeedometerProps {
  currentBurnRate: number; // in $/min
  maxBurnRate: number;     // in $/min
  requestsPerMin: number;
  tokensPerMin: number;
  zone: 'safe' | 'caution' | 'danger';
}

export function Speedometer({
  currentBurnRate,
  maxBurnRate,
  requestsPerMin,
  tokensPerMin,
  zone,
}: SpeedometerProps) {
  // Normalize ratio: 0.0 to 1.0 (clamped max at 1.2 for over-speed display)
  const ratio = Math.min(1.2, maxBurnRate > 0 ? currentBurnRate / maxBurnRate : 0);
  
  // Angle for speedometer needle: -120deg (0) to +120deg (max)
  const startAngle = -120;
  const endAngle = 120;
  const currentAngle = startAngle + ratio * (endAngle - startAngle);

  // SVG Geometry
  const size = 260;
  const strokeWidth = 14;
  const radius = (size - strokeWidth * 2) / 2;
  const center = size / 2;

  // Compute arc paths for Safe (Green), Caution (Yellow), Danger (Red)
  const describeArc = (startDeg: number, endDeg: number) => {
    const toRad = (deg: number) => ((deg - 90) * Math.PI) / 180;
    const x1 = center + radius * Math.cos(toRad(startDeg));
    const y1 = center + radius * Math.sin(toRad(startDeg));
    const x2 = center + radius * Math.cos(toRad(endDeg));
    const y2 = center + radius * Math.sin(toRad(endDeg));
    const largeArcFlag = endDeg - startDeg <= 180 ? '0' : '1';
    return `M ${x1} ${y1} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${x2} ${y2}`;
  };

  const safeArc = describeArc(-120, 24);    // 0% to 60%
  const cautionArc = describeArc(24, 84);   // 60% to 85%
  const dangerArc = describeArc(84, 120);   // 85% to 100%

  const getZoneColor = () => {
    switch (zone) {
      case 'danger':
        return 'text-red-400 border-red-500/30 bg-red-500/10 shadow-red-500/20';
      case 'caution':
        return 'text-amber-400 border-amber-500/30 bg-amber-500/10 shadow-amber-500/20';
      default:
        return 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10 shadow-emerald-500/20';
    }
  };

  return (
    <div className="relative flex flex-col items-center justify-between p-6 rounded-2xl bg-neutral-900/90 border border-neutral-800 shadow-xl overflow-hidden backdrop-blur-sm">
      {/* Top Header */}
      <div className="w-full flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-neutral-800 text-emerald-400">
            <Gauge className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-neutral-100">Speedometer</h3>
            <p className="text-[11px] text-neutral-400 font-mono">Agent Token Velocity Governor</p>
          </div>
        </div>

        <div className={`px-2.5 py-1 rounded-md text-xs font-mono font-semibold border ${getZoneColor()}`}>
          {zone === 'danger' && '🔥 HIGH BURN'}
          {zone === 'caution' && '⚡ ACCELERATING'}
          {zone === 'safe' && '🟢 CRUISE SAFE'}
        </div>
      </div>

      {/* Speedometer SVG Dial */}
      <div className="relative my-2 flex items-center justify-center">
        <svg width={size} height={size * 0.75} viewBox={`0 0 ${size} ${size * 0.85}`} className="overflow-visible">
          {/* Background Track */}
          <path
            d={describeArc(-120, 120)}
            fill="none"
            stroke="#262626"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
          />

          {/* Color Segments */}
          <path d={safeArc} fill="none" stroke="#10b981" strokeWidth={strokeWidth} strokeOpacity="0.8" />
          <path d={cautionArc} fill="none" stroke="#f59e0b" strokeWidth={strokeWidth} strokeOpacity="0.8" />
          <path d={dangerArc} fill="none" stroke="#ef4444" strokeWidth={strokeWidth} strokeOpacity="0.9" />

          {/* Needle & Center Pivot */}
          <g
            style={{
              transform: `rotate(${currentAngle}deg)`,
              transformOrigin: `${center}px ${center}px`,
              transition: 'transform 0.45s cubic-bezier(0.34, 1.56, 0.64, 1)',
            }}
          >
            {/* Needle line */}
            <line
              x1={center}
              y1={center}
              x2={center}
              y2={center - radius + strokeWidth + 4}
              stroke={zone === 'danger' ? '#ef4444' : zone === 'caution' ? '#f59e0b' : '#34d399'}
              strokeWidth="4"
              strokeLinecap="round"
            />
            {/* Center Pivot Circle */}
            <circle cx={center} cy={center} r="9" fill="#171717" stroke="#525252" strokeWidth="3" />
            <circle
              cx={center}
              cy={center}
              r="4"
              fill={zone === 'danger' ? '#ef4444' : zone === 'caution' ? '#f59e0b' : '#34d399'}
            />
          </g>

          {/* Min & Max Labels */}
          <text x={center - radius + 10} y={center + 18} fill="#737373" fontSize="10" fontFamily="monospace" textAnchor="middle">
            $0/m
          </text>
          <text x={center + radius - 10} y={center + 18} fill="#737373" fontSize="10" fontFamily="monospace" textAnchor="middle">
            ${maxBurnRate.toFixed(2)}/m
          </text>
        </svg>

        {/* Live Digital Readout Centered Below Needle Pivot */}
        <div className="absolute bottom-2 flex flex-col items-center">
          <div className="text-3xl font-black tracking-tight text-white font-mono flex items-baseline gap-1">
            <span>${currentBurnRate.toFixed(3)}</span>
            <span className="text-xs text-neutral-400 font-sans font-medium">/ min</span>
          </div>
          <span className="text-[11px] text-neutral-500 font-mono">
            Speed Limit: ${maxBurnRate.toFixed(2)}/min
          </span>
        </div>
      </div>

      {/* Sub-Metrics Telemetry Grid */}
      <div className="w-full grid grid-cols-2 gap-3 mt-4 pt-4 border-t border-neutral-800/80">
        <div className="flex flex-col p-2.5 rounded-xl bg-neutral-950/60 border border-neutral-800">
          <span className="text-[11px] text-neutral-400 font-medium">Request Frequency</span>
          <div className="flex items-baseline gap-1 mt-1">
            <span className="text-lg font-bold font-mono text-neutral-100">{requestsPerMin}</span>
            <span className="text-[10px] text-neutral-500">reqs / min</span>
          </div>
        </div>

        <div className="flex flex-col p-2.5 rounded-xl bg-neutral-950/60 border border-neutral-800">
          <span className="text-[11px] text-neutral-400 font-medium">Token Velocity</span>
          <div className="flex items-baseline gap-1 mt-1">
            <span className="text-lg font-bold font-mono text-cyan-400">
              {tokensPerMin > 1000 ? `${(tokensPerMin / 1000).toFixed(1)}k` : tokensPerMin}
            </span>
            <span className="text-[10px] text-neutral-500">tok / min</span>
          </div>
        </div>
      </div>
    </div>
  );
}
