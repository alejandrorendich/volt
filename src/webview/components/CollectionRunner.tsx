/**
 * @fileoverview CollectionRunner — results panel for the collection runner feature.
 *
 * Shows a list of per-request results when a collection run is in progress or
 * complete. Each row displays the request name, status badge, response time,
 * and assertion counts. A summary bar at the bottom shows totals.
 *
 * This component is shown as an overlay in the response area when
 * `runnerStore.status !== 'idle'`.
 */

import React, { memo, useCallback } from 'react';
import { useRunnerStore } from '../stores/runner-store';
import type { RunnerResult } from '../stores/runner-store';
import './CollectionRunner.css';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusClass(status: number): string {
  if (status === 0) return 'cr-badge--error';
  if (status >= 200 && status < 300) return 'cr-badge--success';
  if (status >= 300 && status < 400) return 'cr-badge--redirect';
  if (status >= 400 && status < 500) return 'cr-badge--client';
  if (status >= 500) return 'cr-badge--server';
  return 'cr-badge--unknown';
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface ResultRowProps {
  result: RunnerResult;
  index: number;
}

const ResultRow = memo(function ResultRow({ result, index }: ResultRowProps) {
  const statusLabel = result.status === 0 ? 'ERR' : String(result.status);
  const passLabel = result.pass ? 'PASS' : 'FAIL';

  return (
    <tr className={`cr-row ${result.pass ? 'cr-row--pass' : 'cr-row--fail'}`}>
      <td className="cr-cell cr-cell--index">{index + 1}</td>
      <td className="cr-cell cr-cell--name" title={result.requestName}>
        {result.requestName}
      </td>
      <td className="cr-cell cr-cell--status">
        <span className={`cr-badge ${statusClass(result.status)}`}>{statusLabel}</span>
      </td>
      <td className="cr-cell cr-cell--time">{formatMs(result.time)}</td>
      <td className="cr-cell cr-cell--pass">
        <span className={`cr-pass-badge ${result.pass ? 'cr-pass-badge--pass' : 'cr-pass-badge--fail'}`}>
          {passLabel}
        </span>
      </td>
      <td className="cr-cell cr-cell--assertions">
        {result.assertionsTotal > 0
          ? `${result.assertionsPassed}/${result.assertionsTotal}`
          : '—'}
      </td>
    </tr>
  );
});

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export const CollectionRunner = memo(function CollectionRunner() {
  const status = useRunnerStore((s) => s.status);
  const folderName = useRunnerStore((s) => s.folderName);
  const results = useRunnerStore((s) => s.results);
  const summary = useRunnerStore((s) => s.summary);
  const total = useRunnerStore((s) => s.total);
  const reset = useRunnerStore((s) => s.reset);

  const handleClose = useCallback(() => {
    reset();
  }, [reset]);

  if (status === 'idle') return null;

  const progressLabel =
    status === 'running'
      ? `Running "${folderName}"… (${results.length}/${total})`
      : `Run complete — "${folderName}"`;

  return (
    <div className="cr-panel" role="region" aria-label="Collection runner results">
      {/* Header */}
      <div className="cr-header">
        <div className="cr-header__left">
          {status === 'running' && <span className="cr-spinner" aria-hidden="true" />}
          <span className="cr-header__title">{progressLabel}</span>
        </div>
        <button
          className="cr-close-btn"
          onClick={handleClose}
          aria-label="Close runner panel"
          title="Close"
        >
          ×
        </button>
      </div>

      {/* Results table */}
      <div className="cr-table-wrapper">
        <table className="cr-table" aria-label="Request results">
          <thead>
            <tr>
              <th className="cr-th cr-th--index">#</th>
              <th className="cr-th cr-th--name">Request</th>
              <th className="cr-th cr-th--status">Status</th>
              <th className="cr-th cr-th--time">Time</th>
              <th className="cr-th cr-th--pass">Result</th>
              <th className="cr-th cr-th--assertions">Assertions</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r, i) => (
              <ResultRow key={`${r.index}-${r.requestName}`} result={r} index={i} />
            ))}
            {status === 'running' && results.length < total && (
              <tr className="cr-row cr-row--pending">
                <td colSpan={6} className="cr-cell cr-cell--pending">
                  <span className="cr-spinner cr-spinner--sm" aria-hidden="true" />
                  {' '}Waiting for next request…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Summary */}
      {status === 'complete' && summary && (
        <div className="cr-summary">
          <span className={`cr-summary__stat ${summary.passed > 0 ? 'cr-summary__stat--pass' : ''}`}>
            ✓ {summary.passed} passed
          </span>
          <span className={`cr-summary__stat ${summary.failed > 0 ? 'cr-summary__stat--fail' : ''}`}>
            ✗ {summary.failed} failed
          </span>
          <span className="cr-summary__stat cr-summary__stat--total">
            {summary.total} total
          </span>
          <span className="cr-summary__time">{formatMs(summary.totalTime)}</span>
        </div>
      )}
    </div>
  );
});
