/**
 * @fileoverview TimingBar — horizontal stacked bar chart for request phases.
 *
 * Renders DNS, TCP, TLS, TTFB, and Download phases as proportionally-sized
 * colored bars with hover tooltips showing the duration in ms.
 * TLS bar is omitted when tls === 0 (plain HTTP).
 *
 * @see REQ-RV-004
 */

import React, { memo, useState, useCallback } from 'react';
import type { TimingBreakdown } from '../../shared/models';
import './TimingBar.css';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PhaseConfig {
  key: keyof Omit<TimingBreakdown, 'total'>;
  label: string;
  colorVar: string;
}

const PHASES: PhaseConfig[] = [
  { key: 'dns',  label: 'DNS',      colorVar: '--volt-timing-dns' },
  { key: 'tcp',  label: 'TCP',      colorVar: '--volt-timing-tcp' },
  { key: 'tls',  label: 'TLS',      colorVar: '--volt-timing-tls' },
  { key: 'ttfb', label: 'TTFB',     colorVar: '--volt-timing-ttfb' },
  { key: 'body', label: 'Download', colorVar: '--volt-timing-body' },
];

export interface TimingBarProps {
  timing: TimingBreakdown;
}

// ---------------------------------------------------------------------------
// Single bar segment
// ---------------------------------------------------------------------------

interface SegmentProps {
  phase: PhaseConfig;
  ms: number;
  percent: number;
}

const Segment = memo(function Segment({ phase, ms, percent }: SegmentProps): React.ReactElement {
  const [tooltipVisible, setTooltipVisible] = useState(false);

  const show = useCallback(() => setTooltipVisible(true), []);
  const hide = useCallback(() => setTooltipVisible(false), []);

  return (
    <div
      className="tb-segment"
      style={{
        width: `${percent}%`,
        backgroundColor: `var(${phase.colorVar})`,
      }}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      tabIndex={0}
      role="listitem"
      aria-label={`${phase.label}: ${ms.toFixed(1)} ms`}
    >
      {tooltipVisible && (
        <div className="tb-tooltip" role="tooltip">
          <span className="tb-tooltip__label">{phase.label}</span>
          <span className="tb-tooltip__value">{ms.toFixed(1)} ms</span>
        </div>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Legend item
// ---------------------------------------------------------------------------

const LegendItem = memo(function LegendItem({ phase, ms }: { phase: PhaseConfig; ms: number }): React.ReactElement {
  return (
    <div className="tb-legend-item">
      <span className="tb-legend-dot" style={{ backgroundColor: `var(${phase.colorVar})` }} />
      <span className="tb-legend-label">{phase.label}</span>
      <span className="tb-legend-value">{ms.toFixed(0)} ms</span>
    </div>
  );
});

// ---------------------------------------------------------------------------
// TimingBar
// ---------------------------------------------------------------------------

export const TimingBar = memo(function TimingBar({ timing }: TimingBarProps): React.ReactElement {
  // Filter out zero-duration phases (e.g. TLS for HTTP)
  const activePhases = PHASES.filter((p) => timing[p.key] > 0);

  // Total for percentage calculation (sum of active phases, not timing.total)
  // Using timing.total ensures the bar represents wall-clock proportions
  const base = timing.total > 0 ? timing.total : 1;

  return (
    <div className="tb-root">
      {/* Total */}
      <div className="tb-total">
        <span className="tb-total__label">Total</span>
        <span className="tb-total__value">{timing.total.toFixed(0)} ms</span>
      </div>

      {/* Stacked bar */}
      <div className="tb-bar-track" role="list" aria-label="Request timing breakdown">
        {activePhases.map((phase) => {
          const ms = timing[phase.key];
          const percent = Math.max((ms / base) * 100, 0.5); // min 0.5% for visibility
          return <Segment key={phase.key} phase={phase} ms={ms} percent={percent} />;
        })}
        {/* Fill remainder for phases that don't account for full total */}
        {activePhases.reduce((sum, p) => sum + timing[p.key], 0) < timing.total && (
          <div
            className="tb-segment tb-segment--gap"
            style={{ flex: 1 }}
            aria-label="Other"
            role="listitem"
          />
        )}
      </div>

      {/* Legend */}
      <div className="tb-legend">
        {activePhases.map((phase) => (
          <LegendItem key={phase.key} phase={phase} ms={timing[phase.key]} />
        ))}
      </div>
    </div>
  );
});
