/**
 * @fileoverview KeyValueEditor — reusable key/value table editor.
 *
 * Used by headers, query params, and form-data body editors.
 * Each row has: enabled toggle, key input, value input, delete button.
 * An empty trailing row is always present for adding new entries.
 * Supports bulk-edit mode (toggle to raw "key: value" text).
 * Variable highlights (`{{var}}`) rendered in value inputs via a background
 * gradient trick (CSS ::before) — the input itself stays editable.
 *
 * @see REQ-RB-003, REQ-RB-005
 */

import React, { useCallback, useId, memo } from 'react';
import './KeyValueEditor.css';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KVRow {
  readonly id: string;
  readonly key: string;
  readonly value: string;
  readonly enabled: boolean;
}

export interface KeyValueEditorProps {
  rows: KVRow[];
  onAdd: () => void;
  onUpdate: (id: string, patch: Partial<Pick<KVRow, 'key' | 'value' | 'enabled'>>) => void;
  onRemove: (id: string) => void;
  /**
   * Optional callback invoked when exiting bulk-edit mode with the fully
   * parsed replacement rows (without trailing empty row).
   * When provided, the editor delegates the replace entirely to the parent
   * instead of using the individual onAdd/onRemove calls.
   */
  onBulkReplace?: (rows: KVRow[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  /** Suggest common keys in a datalist. */
  keySuggestions?: readonly string[];
  disabled?: boolean;
  /** Environment variable map for resolving {{var}} tooltips in values. */
  envVariables?: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Var-highlight overlay
// ---------------------------------------------------------------------------

/** Returns JSX that renders a value with {{var}} tokens highlighted. */
function HighlightedValue({
  value,
  envVariables,
}: {
  value: string;
  envVariables?: Readonly<Record<string, string>>;
}): React.ReactElement {
  const parts = value.split(/({{[^}]+}})/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('{{') && part.endsWith('}}')) {
          const varName = part.slice(2, -2).trim();
          const resolved = envVariables?.[varName];
          const title = resolved !== undefined
            ? `${part} → ${resolved}`
            : `${part} (not resolved)`;
          return (
            <mark key={i} className="kv-var" title={title}>
              {part}
            </mark>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// Single row
// ---------------------------------------------------------------------------

interface RowProps {
  row: KVRow;
  isLast: boolean;
  keySuggestions?: readonly string[];
  keyPlaceholder: string;
  valuePlaceholder: string;
  disabled: boolean;
  datalistId: string;
  envVariables?: Readonly<Record<string, string>>;
  onUpdate: (id: string, patch: Partial<Pick<KVRow, 'key' | 'value' | 'enabled'>>) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
}

const KVRow = memo(function KVRow({
  row,
  isLast,
  keyPlaceholder,
  valuePlaceholder,
  disabled,
  datalistId,
  envVariables,
  onUpdate,
  onRemove,
  onAdd,
}: RowProps): React.ReactElement {
  const handleKeyChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onUpdate(row.id, { key: e.target.value });
      // Auto-add trailing row when user starts typing in the last empty row
      if (isLast && e.target.value !== '') {
        onAdd();
      }
    },
    [row.id, isLast, onUpdate, onAdd],
  );

  const handleValueChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onUpdate(row.id, { value: e.target.value });
    },
    [row.id, onUpdate],
  );

  const handleToggle = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onUpdate(row.id, { enabled: e.target.checked });
    },
    [row.id, onUpdate],
  );

  const handleRemove = useCallback(() => onRemove(row.id), [row.id, onRemove]);

  return (
    <div className={`kv-row${row.enabled ? '' : ' kv-row--disabled'}`} role="row">
      {/* Enabled toggle */}
      <label className="kv-toggle volt-sr-only-label" aria-label={`Enable ${row.key || 'row'}`}>
        <input
          type="checkbox"
          checked={row.enabled}
          onChange={handleToggle}
          disabled={disabled}
          className="kv-toggle__input"
          aria-label="enabled"
        />
        <span className="kv-toggle__visual" aria-hidden="true" />
      </label>

      {/* Key input */}
      <div className="kv-cell kv-cell--key">
        <input
          type="text"
          value={row.key}
          onChange={handleKeyChange}
          placeholder={keyPlaceholder}
          disabled={disabled || !row.enabled}
          list={datalistId || undefined}
          className="kv-input"
          aria-label="key"
        />
      </div>

      {/* Value input + highlight overlay */}
      <div className="kv-cell kv-cell--value">
        <div className="kv-value-wrap">
          <div className="kv-value-highlight" aria-hidden="true">
            {envVariables !== undefined
              ? <HighlightedValue value={row.value} envVariables={envVariables} />
              : <HighlightedValue value={row.value} />}
          </div>
          <input
            type="text"
            value={row.value}
            onChange={handleValueChange}
            placeholder={valuePlaceholder}
            disabled={disabled || !row.enabled}
            className="kv-input kv-input--value"
            aria-label="value"
            spellCheck={false}
          />
        </div>
      </div>

      {/* Delete button (hidden for trailing empty row) */}
      <button
        type="button"
        className="kv-delete"
        onClick={handleRemove}
        disabled={disabled || isLast}
        aria-label={`Delete ${row.key || 'row'}`}
        tabIndex={isLast ? -1 : 0}
      >
        ×
      </button>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Bulk-edit mode: parse raw text → KVRow[]
// ---------------------------------------------------------------------------

/**
 * Serialize rows to text. Disabled rows get a `# ` prefix so they survive
 * round-trips through the bulk editor without losing their disabled state.
 */
function rowsToText(rows: KVRow[]): string {
  return rows
    .filter((r) => r.key.trim() !== '')
    .map((r) => `${r.enabled ? '' : '# '}${r.key}: ${r.value}`)
    .join('\n');
}

/**
 * Parse bulk text into KVRow[].
 * Lines starting with `# ` are treated as disabled rows.
 * Lines without `:` are skipped.
 * Empty lines are skipped.
 */
function textToRows(text: string): KVRow[] {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  return lines.flatMap((line) => {
    const disabled = line.startsWith('# ');
    const cleaned = disabled ? line.slice(2) : line;
    const colon = cleaned.indexOf(':');
    if (colon === -1) return []; // Skip lines without a colon
    const key = cleaned.slice(0, colon).trim();
    const value = cleaned.slice(colon + 1).trim();
    if (key === '') return []; // Skip lines with empty key
    return [{ id: `bulk-${Math.random().toString(36).slice(2)}`, key, value, enabled: !disabled }];
  });
}

// ---------------------------------------------------------------------------
// KeyValueEditor
// ---------------------------------------------------------------------------

export const KeyValueEditor = memo(function KeyValueEditor({
  rows,
  onAdd,
  onUpdate,
  onRemove,
  onBulkReplace,
  keyPlaceholder = 'Key',
  valuePlaceholder = 'Value',
  keySuggestions,
  disabled = false,
  envVariables,
}: KeyValueEditorProps): React.ReactElement {
  const uid = useId();
  const datalistId = keySuggestions && keySuggestions.length > 0 ? `kv-suggestions-${uid}` : '';
  const [bulkMode, setBulkMode] = React.useState(false);
  const [bulkText, setBulkText] = React.useState('');

  const enterBulk = useCallback(() => {
    setBulkText(rowsToText(rows));
    setBulkMode(true);
  }, [rows]);

  const exitBulk = useCallback(() => {
    const parsed = textToRows(bulkText);
    if (onBulkReplace) {
      // Preferred path: parent handles the atomic replace
      onBulkReplace(parsed);
    } else {
      // Fallback: individual remove + add cycle
      for (const r of rows) {
        if (r.key.trim() !== '') onRemove(r.id);
      }
      for (const _p of parsed) {
        onAdd();
      }
      // eslint-disable-next-line no-console -- dev-mode bulk workaround signal
      console.debug('[Volt] bulk-replace (no onBulkReplace provided)', parsed);
    }
    setBulkMode(false);
  }, [bulkText, rows, onRemove, onAdd, onBulkReplace]);

  // Ensure there is always an empty trailing row
  const displayRows = React.useMemo(() => {
    const hasEmptyTrailer = rows.length > 0 && rows[rows.length - 1]?.key === '' && rows[rows.length - 1]?.value === '';
    if (!hasEmptyTrailer && !disabled) {
      return rows; // parent is responsible for maintaining trailing row
    }
    return rows;
  }, [rows, disabled]);

  return (
    <div className="kv-editor" role="table" aria-label="Key-value editor">
      {/* Header row */}
      <div className="kv-header" role="row">
        <span className="kv-header__toggle" />
        <span className="kv-header__key">Key</span>
        <span className="kv-header__value">Value</span>
        <button
          type="button"
          className="kv-bulk-btn"
          onClick={bulkMode ? exitBulk : enterBulk}
          disabled={disabled}
          title={bulkMode ? 'Exit bulk edit' : 'Bulk edit'}
          aria-label={bulkMode ? 'Exit bulk edit' : 'Bulk edit'}
        >
          {bulkMode ? '⊠ Done' : '⊞ Bulk'}
        </button>
      </div>

      {bulkMode ? (
        <textarea
          className="kv-bulk-textarea"
          value={bulkText}
          onChange={(e) => setBulkText(e.target.value)}
          placeholder="key: value (one per line)"
          spellCheck={false}
          rows={Math.max(4, bulkText.split('\n').length + 1)}
        />
      ) : (
        <div className="kv-rows">
          {displayRows.map((row, i) => (
            <KVRow
              key={row.id}
              row={row}
              isLast={i === displayRows.length - 1}
              keyPlaceholder={keyPlaceholder}
              valuePlaceholder={valuePlaceholder}
              disabled={disabled}
              datalistId={datalistId}
              {...(envVariables !== undefined ? { envVariables } : {})}
              onUpdate={onUpdate}
              onRemove={onRemove}
              onAdd={onAdd}
            />
          ))}
        </div>
      )}

      {datalistId && (
        <datalist id={datalistId}>
          {keySuggestions!.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </div>
  );
});
