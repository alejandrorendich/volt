/**
 * @fileoverview Environment switcher — dropdown in the app header.
 *
 * Shows the active environment name and lists all available environments.
 * Selecting one sends a `set-environment` message to the host, which resolves
 * the new variable map and pushes back an `environment-changed` event.
 *
 * When no environments exist the dropdown shows a "No environments" placeholder
 * and is disabled.
 *
 * @see REQ-ENV-005 — Environment Switcher
 * @see REQ-ENV-006 — Sensitive Variable Masking
 */

import React, { memo, useCallback, useId, useState, useRef } from 'react';
import { useEnvStore } from '../stores/env-store';
import { useMessage } from '../hooks/useMessage';
import './EnvSwitcher.css';

// ---------------------------------------------------------------------------
// Sensitive key pattern — keys matching any of these patterns have their
// displayed value masked. Interpolation still uses the actual value.
// ---------------------------------------------------------------------------

const SENSITIVE_PATTERN = /secret|token|password|key/i;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_PATTERN.test(key);
}

// ---------------------------------------------------------------------------
// EditableVarRow — a single variable row with inline editing
// ---------------------------------------------------------------------------

interface EditableVarRowProps {
  varKey: string;
  varValue: string;
  onSave: (key: string, value: string) => void;
  onDelete: (key: string) => void;
}

const EditableVarRow = memo(function EditableVarRow({
  varKey,
  varValue,
  onSave,
  onDelete,
}: EditableVarRowProps): React.ReactElement {
  const sensitive = isSensitiveKey(varKey);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(varValue);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFocus = useCallback(() => {
    setDraft(varValue); // always start from the current persisted value
    setEditing(true);
  }, [varValue]);

  const commit = useCallback(() => {
    setEditing(false);
    if (draft !== varValue) {
      onSave(varKey, draft);
    }
  }, [draft, varKey, varValue, onSave]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        inputRef.current?.blur();
      } else if (e.key === 'Escape') {
        setDraft(varValue);
        setEditing(false);
        inputRef.current?.blur();
      }
    },
    [varValue],
  );

  const handleDeleteClick = useCallback(() => {
    onDelete(varKey);
  }, [varKey, onDelete]);

  return (
    <tr className="env-editor__row">
      <td className="env-editor__key" title={varKey}>{varKey}</td>
      <td className="env-editor__value-cell">
        <input
          ref={inputRef}
          type={sensitive && !editing ? 'password' : 'text'}
          className="env-editor__value-input"
          value={editing ? draft : varValue}
          placeholder={sensitive ? '••••• (click to edit)' : ''}
          onFocus={handleFocus}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={handleKeyDown}
          aria-label={`Value for ${varKey}`}
        />
      </td>
      <td className="env-editor__delete-cell">
        <button
          type="button"
          className="env-editor__delete-btn"
          onClick={handleDeleteClick}
          aria-label={`Delete variable ${varKey}`}
          title={`Delete ${varKey}`}
        >
          ×
        </button>
      </td>
    </tr>
  );
});

// ---------------------------------------------------------------------------
// AddVarRow — bottom row for adding a new variable
// ---------------------------------------------------------------------------

interface AddVarRowProps {
  onAdd: (key: string, value: string) => void;
}

const AddVarRow = memo(function AddVarRow({ onAdd }: AddVarRowProps): React.ReactElement {
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const keyRef = useRef<HTMLInputElement>(null);

  const trySubmit = useCallback(() => {
    const k = newKey.trim();
    const v = newValue.trim();
    // Submit whenever key is non-empty — empty string is a valid env value (H-06)
    if (k) {
      onAdd(k, v);
      setNewKey('');
      setNewValue('');
      keyRef.current?.focus();
    }
  }, [newKey, newValue, onAdd]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') trySubmit();
      if (e.key === 'Escape') {
        setNewKey('');
        setNewValue('');
      }
    },
    [trySubmit],
  );

  return (
    <tr className="env-editor__row env-editor__add-row">
      <td className="env-editor__key">
        <input
          ref={keyRef}
          type="text"
          className="env-editor__add-input"
          placeholder="KEY"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-label="New variable key"
        />
      </td>
      <td className="env-editor__value-cell">
        <input
          type="text"
          className="env-editor__add-input env-editor__add-value"
          placeholder="value"
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-label="New variable value"
        />
      </td>
      <td className="env-editor__delete-cell" />
    </tr>
  );
});

// ---------------------------------------------------------------------------
// EnvEditor — the full editable panel (replaces the old VarPreview)
// ---------------------------------------------------------------------------

interface EnvEditorProps {
  envName: string;
  variables: Record<string, string>;
  canDelete: boolean;
  onUpdateVar: (key: string, value: string) => void;
  onDeleteVar: (key: string) => void;
  onDeleteEnv: (name: string) => void;
  onRenameEnv: (oldName: string, newName: string) => void;
}

const EnvEditor = memo(function EnvEditor({
  envName,
  variables,
  canDelete,
  onUpdateVar,
  onDeleteVar,
  onDeleteEnv,
  onRenameEnv,
}: EnvEditorProps): React.ReactElement {
  const entries = Object.entries(variables);
  const varCount = entries.length;
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(envName);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const renameRef = useRef<HTMLInputElement>(null);
  // Tracks whether Escape was pressed so onBlur can skip the rename (H-05)
  const escapedRef = useRef(false);

  const handleDeleteEnv = useCallback(() => {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    onDeleteEnv(envName);
  }, [envName, onDeleteEnv, confirmingDelete]);

  const handleStartRename = useCallback(() => {
    setRenameValue(envName);
    setIsRenaming(true);
    setTimeout(() => renameRef.current?.select(), 0);
  }, [envName]);

  const handleRenameSubmit = useCallback(() => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== envName && /^[a-zA-Z0-9_-]+$/.test(trimmed)) {
      onRenameEnv(envName, trimmed);
    }
    setIsRenaming(false);
  }, [renameValue, envName, onRenameEnv]);

  const handleRenameKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleRenameSubmit();
      if (e.key === 'Escape') {
        escapedRef.current = true;
        setIsRenaming(false);
      }
    },
    [handleRenameSubmit],
  );

  const handleRenameBlur = useCallback(() => {
    if (escapedRef.current) {
      escapedRef.current = false;
      return;
    }
    handleRenameSubmit();
  }, [handleRenameSubmit]);

  return (
    <div className="env-editor" aria-label={`Edit environment: ${envName}`}>
      <div className="env-preview__header">
        {isRenaming ? (
          <input
            ref={renameRef}
            type="text"
            className="env-editor__rename-input"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={handleRenameKeyDown}
            onBlur={handleRenameBlur}
            aria-label="Rename environment"
          />
        ) : (
          <span
            className="env-preview__title env-preview__title--editable"
            onDoubleClick={handleStartRename}
            title="Double-click to rename"
          >
            {envName}
          </span>
        )}
        <span className="env-preview__subtitle">
          {varCount} variable{varCount !== 1 ? 's' : ''}
        </span>
      </div>

      <table className="env-editor__table" aria-label="Environment variables">
        <tbody>
          {entries.length === 0 && (
            <tr>
              <td colSpan={3} className="env-preview__empty">
                No variables defined — add one below
              </td>
            </tr>
          )}
          {entries.map(([key, value]) => (
            <EditableVarRow
              key={key}
              varKey={key}
              varValue={value}
              onSave={onUpdateVar}
              onDelete={onDeleteVar}
            />
          ))}
          <AddVarRow onAdd={onUpdateVar} />
        </tbody>
      </table>

      {/* Always show delete — even for last env */}
      <div className="env-editor__danger-zone">
        <button
          type="button"
          className={`env-editor__delete-env-btn${confirmingDelete ? ' env-editor__delete-env-btn--confirming' : ''}`}
          onClick={handleDeleteEnv}
          onBlur={() => setConfirmingDelete(false)}
          aria-label={`Delete environment ${envName}`}
        >
          {confirmingDelete ? 'Click again to confirm' : 'Delete environment'}
        </button>
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// EnvSwitcher
// ---------------------------------------------------------------------------

export const EnvSwitcher = memo(function EnvSwitcher(): React.ReactElement {
  const active = useEnvStore((s) => s.active);
  const available = useEnvStore((s) => s.available);
  const variables = useEnvStore((s) => s.variables);
  const { send } = useMessage();
  const selectId = useId();
  const [showInput, setShowInput] = useState(false);
  const [showEditor, setShowEditor] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const name = e.target.value;
      if (!name || name === active) return;
      send({
        type: 'request:set-environment',
        correlationId: `env-${Date.now()}`,
        payload: { name },
      });
    },
    [active, send],
  );

  const handleCreate = useCallback(() => {
    setShowInput(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const handleInputSubmit = useCallback(() => {
    const raw = inputRef.current?.value.trim() ?? '';
    // Replace spaces with hyphens for filesystem-safe name
    const value = raw.replace(/\s+/g, '-');
    if (!value || !/^[a-zA-Z0-9_-]+$/.test(value)) {
      setShowInput(false);
      return;
    }
    send({
      type: 'request:create-environment',
      correlationId: `env-create-${Date.now()}`,
      payload: { name: value },
    });
    setShowInput(false);
  }, [send]);

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleInputSubmit();
      if (e.key === 'Escape') setShowInput(false);
    },
    [handleInputSubmit],
  );

  // --- Editor callbacks ---

  const handleUpdateVar = useCallback(
    (key: string, value: string) => {
      send({
        type: 'request:update-env-var',
        correlationId: `env-update-var-${Date.now()}`,
        payload: { key, value },
      });
    },
    [send],
  );

  const handleDeleteVar = useCallback(
    (key: string) => {
      send({
        type: 'request:delete-env-var',
        correlationId: `env-delete-var-${Date.now()}`,
        payload: { key },
      });
    },
    [send],
  );

  const handleDeleteEnv = useCallback(
    (name: string) => {
      send({
        type: 'request:delete-environment',
        correlationId: `env-delete-${Date.now()}`,
        payload: { name },
      });
      setShowEditor(false);
    },
    [send],
  );

  const handleRenameEnv = useCallback(
    (oldName: string, newName: string) => {
      send({
        type: 'request:rename-environment',
        correlationId: `env-rename-${Date.now()}`,
        payload: { oldName, newName },
      });
    },
    [send],
  );

  const hasEnvs = available.length > 0;
  const varCount = Object.keys(variables).length;

  return (
    <div className="env-switcher">
      <label htmlFor={selectId} className="env-switcher__label">
        Env
      </label>

      <div className="env-switcher__dropdown-wrap">
        <select
          id={selectId}
          className="env-switcher__select"
          value={active}
          onChange={handleChange}
          disabled={!hasEnvs}
          aria-label={hasEnvs ? `Active environment: ${active || 'none'}` : 'No environments configured'}
          title={hasEnvs ? 'Switch active environment' : 'No .volt/envs/*.yaml files found'}
        >
          {!hasEnvs && (
            <option value="">No environments</option>
          )}
          {hasEnvs && !active && (
            <option value="" disabled>
              Select environment…
            </option>
          )}
          {available.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>

      {/* Create new environment button */}
      <button
        type="button"
        className="env-switcher__add-btn"
        onClick={handleCreate}
        aria-label="Create new environment"
        title="Create new environment"
      >
        +
      </button>

      {/* Inline input for new env name */}
      {showInput && (
        <input
          ref={inputRef}
          type="text"
          className="env-switcher__input"
          placeholder="env name"
          onKeyDown={handleInputKeyDown}
          onBlur={handleInputSubmit}
          aria-label="New environment name"
        />
      )}

      {/* Variable count badge — click to toggle editor */}
      {hasEnvs && active && (
        <div className="env-switcher__vars-wrap">
          <button
            type="button"
            className="env-switcher__vars-badge"
            aria-label={`${varCount} variable${varCount === 1 ? '' : 's'} in ${active}`}
            title="Click to manage environment variables"
            onClick={() => setShowEditor((v) => !v)}
          >
            {varCount} var{varCount !== 1 ? 's' : ''}
          </button>
          {/* Editable variable panel */}
          {showEditor && (
            <EnvEditor
              envName={active}
              variables={variables}
              canDelete={available.length > 1}
              onUpdateVar={handleUpdateVar}
              onDeleteVar={handleDeleteVar}
              onDeleteEnv={handleDeleteEnv}
              onRenameEnv={handleRenameEnv}
            />
          )}
        </div>
      )}
    </div>
  );
});
