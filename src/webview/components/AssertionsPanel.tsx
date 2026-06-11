/**
 * @fileoverview AssertionsPanel — GUI-based test assertions for HTTP requests.
 *
 * Displays a list of assertion rules. Each rule has:
 *   - Subject dropdown (status, time, body JSON path, header)
 *   - Operator dropdown (equals, not equals, contains, greater than, less than, exists)
 *   - Expected value input
 *   - Pass/fail indicator after execution
 *   - Delete button
 *
 * Assertions are stored in the request store and persisted to YAML.
 */

import React, { memo, useCallback } from 'react';
import { useRequestStore } from '../stores/request-store';
import type { AssertionRule, AssertionSubject, AssertionOperator } from '../../shared/models';
import './AssertionsPanel.css';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUBJECT_OPTIONS: Array<{ value: AssertionSubject; label: string }> = [
  { value: 'status', label: 'Status Code' },
  { value: 'time', label: 'Response Time' },
  { value: 'jsonpath', label: 'Body (JSON path)' },
  { value: 'header', label: 'Header' },
];

const OPERATOR_OPTIONS: Array<{ value: AssertionOperator; label: string }> = [
  { value: 'eq', label: 'equals' },
  { value: 'neq', label: 'not equals' },
  { value: 'contains', label: 'contains' },
  { value: 'gt', label: 'greater than' },
  { value: 'lt', label: 'less than' },
  { value: 'exists', label: 'exists' },
];

// ---------------------------------------------------------------------------
// AssertionsPanel
// ---------------------------------------------------------------------------

export const AssertionsPanel = memo(function AssertionsPanel(): React.ReactElement {
  const assertions = useRequestStore((s) => s.assertions);
  const assertionResults = useRequestStore((s) => s.assertionResults);
  const addAssertion = useRequestStore((s) => s.addAssertion);
  const updateAssertion = useRequestStore((s) => s.updateAssertion);
  const removeAssertion = useRequestStore((s) => s.removeAssertion);

  const handleSubjectChange = useCallback(
    (id: string, value: string) => {
      updateAssertion(id, { subject: value as AssertionSubject, property: '' });
    },
    [updateAssertion],
  );

  const handleOperatorChange = useCallback(
    (id: string, value: string) => {
      updateAssertion(id, { operator: value as AssertionOperator });
    },
    [updateAssertion],
  );

  const handlePropertyChange = useCallback(
    (id: string, value: string) => {
      updateAssertion(id, { property: value });
    },
    [updateAssertion],
  );

  const handleExpectedChange = useCallback(
    (id: string, value: string) => {
      updateAssertion(id, { expected: value });
    },
    [updateAssertion],
  );

  if (assertions.length === 0) {
    return (
      <div className="ap-root">
        <div className="ap-empty">
          <span className="ap-empty__icon" aria-hidden="true">✓</span>
          <span className="ap-empty__text">No assertions yet — add rules to auto-validate responses</span>
        </div>
        <div className="ap-footer">
          <button
            type="button"
            className="ap-add-btn"
            onClick={addAssertion}
            aria-label="Add assertion rule"
          >
            + Add Rule
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="ap-root">
      <div className="ap-list" role="list" aria-label="Assertion rules">
        {assertions.map((rule) => {
          const result = assertionResults.find((r) => r.id === rule.id);
          return (
            <AssertionRow
              key={rule.id}
              rule={rule}
              result={result}
              onSubjectChange={handleSubjectChange}
              onOperatorChange={handleOperatorChange}
              onPropertyChange={handlePropertyChange}
              onExpectedChange={handleExpectedChange}
              onRemove={removeAssertion}
            />
          );
        })}
      </div>
      <div className="ap-footer">
        <button
          type="button"
          className="ap-add-btn"
          onClick={addAssertion}
          aria-label="Add assertion rule"
        >
          + Add Rule
        </button>
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// AssertionRow
// ---------------------------------------------------------------------------

interface AssertionRowProps {
  rule: AssertionRule;
  result: { id: string; pass: boolean; actual: string } | undefined;
  onSubjectChange: (id: string, value: string) => void;
  onOperatorChange: (id: string, value: string) => void;
  onPropertyChange: (id: string, value: string) => void;
  onExpectedChange: (id: string, value: string) => void;
  onRemove: (id: string) => void;
}

const AssertionRow = memo(function AssertionRow({
  rule,
  result,
  onSubjectChange,
  onOperatorChange,
  onPropertyChange,
  onExpectedChange,
  onRemove,
}: AssertionRowProps): React.ReactElement {
  const needsProperty = rule.subject === 'jsonpath' || rule.subject === 'header';
  const hideExpected = rule.operator === 'exists';

  return (
    <div className="ap-row" role="listitem">
      {/* Pass/fail indicator */}
      <span
        className={`ap-indicator${result ? (result.pass ? ' ap-indicator--pass' : ' ap-indicator--fail') : ''}`}
        aria-label={result ? (result.pass ? 'Assertion passed' : `Assertion failed — actual: ${result.actual}`) : 'Not run'}
        title={result ? (result.pass ? `✓ Passed (actual: ${result.actual})` : `✗ Failed (actual: ${result.actual})`) : 'Run the request to evaluate'}
      >
        {result ? (result.pass ? '✓' : '✗') : '○'}
      </span>

      {/* Subject dropdown */}
      <select
        className="ap-select ap-select--subject"
        value={rule.subject}
        onChange={(e) => onSubjectChange(rule.id, e.target.value)}
        aria-label="Assertion subject"
      >
        {SUBJECT_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>

      {/* Property input (JSON path or header name) */}
      {needsProperty && (
        <input
          type="text"
          className="ap-input ap-input--property"
          value={rule.property}
          onChange={(e) => onPropertyChange(rule.id, e.target.value)}
          placeholder={rule.subject === 'jsonpath' ? 'e.g. user.id' : 'e.g. Content-Type'}
          spellCheck={false}
          aria-label={rule.subject === 'jsonpath' ? 'JSON path' : 'Header name'}
        />
      )}

      {/* Operator dropdown */}
      <select
        className="ap-select ap-select--operator"
        value={rule.operator}
        onChange={(e) => onOperatorChange(rule.id, e.target.value)}
        aria-label="Assertion operator"
      >
        {OPERATOR_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>

      {/* Expected value input */}
      {!hideExpected && (
        <input
          type="text"
          className="ap-input ap-input--expected"
          value={rule.expected}
          onChange={(e) => onExpectedChange(rule.id, e.target.value)}
          placeholder="Expected value"
          spellCheck={false}
          aria-label="Expected value"
        />
      )}

      {/* Delete button */}
      <button
        type="button"
        className="ap-delete-btn"
        onClick={() => onRemove(rule.id)}
        aria-label="Remove assertion rule"
        title="Remove"
      >
        ×
      </button>
    </div>
  );
});
