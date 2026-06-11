/**
 * @fileoverview CodegenPanel — code generation panel for HTTP requests.
 *
 * Renders a modal/overlay that shows the current request as runnable code
 * in multiple languages. Triggered by the "</>" button in the request toolbar.
 *
 * Languages supported: cURL, JavaScript fetch, JavaScript axios,
 * Python requests, Node.js http, PHP cURL.
 */

import React, { memo, useCallback, useRef, useState } from 'react';
import { useRequestStore } from '../stores/request-store';
import { generateCode, CODEGEN_LANGUAGE_LABELS } from '../utils/codegen';
import type { CodegenLanguage } from '../utils/codegen';
import './CodegenPanel.css';

// ---------------------------------------------------------------------------
// Language selector order
// ---------------------------------------------------------------------------

const LANGUAGES: CodegenLanguage[] = ['curl', 'fetch', 'axios', 'python', 'node', 'php'];

// ---------------------------------------------------------------------------
// CodegenPanel
// ---------------------------------------------------------------------------

interface CodegenPanelProps {
  onClose: () => void;
}

export const CodegenPanel = memo(function CodegenPanel({ onClose }: CodegenPanelProps): React.ReactElement {
  const toRequestDef = useRequestStore((s) => s.toRequestDef);
  const [language, setLanguage] = useState<CodegenLanguage>('curl');
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const requestDef = toRequestDef();
  const code = generateCode(requestDef, language);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => setCopied(false), 1500);
    });
  }, [code]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose],
  );

  return (
    <div
      className="cg-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Generate code"
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
    >
      <div className="cg-panel">
        {/* Header */}
        <div className="cg-header">
          <span className="cg-header__title">Generate Code</span>
          <button
            type="button"
            className="cg-close-btn"
            onClick={onClose}
            aria-label="Close code generator"
            title="Close (Esc)"
          >
            ×
          </button>
        </div>

        {/* Language tabs */}
        <div className="cg-lang-bar" role="tablist" aria-label="Code language">
          {LANGUAGES.map((lang) => (
            <button
              key={lang}
              role="tab"
              type="button"
              className={`cg-lang-btn${language === lang ? ' cg-lang-btn--active' : ''}`}
              onClick={() => setLanguage(lang)}
              aria-selected={language === lang}
            >
              {CODEGEN_LANGUAGE_LABELS[lang]}
            </button>
          ))}
        </div>

        {/* Code output */}
        <div className="cg-code-wrap">
          <pre className="cg-code volt-monospace" aria-label={`${CODEGEN_LANGUAGE_LABELS[language]} code`}>
            {code}
          </pre>
        </div>

        {/* Footer */}
        <div className="cg-footer">
          <button
            type="button"
            className={`cg-copy-btn${copied ? ' cg-copy-btn--copied' : ''}`}
            onClick={handleCopy}
            aria-label="Copy code to clipboard"
          >
            {copied ? '✓ Copied!' : 'Copy'}
          </button>
        </div>
      </div>
    </div>
  );
});
