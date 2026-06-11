/**
 * @fileoverview AuthPanel — authentication configuration UI for request builder.
 *
 * Renders a type selector (None / Bearer / Basic / API Key) and the appropriate
 * input fields for each auth type. Values are stored in `useRequestStore`.
 */

import React, { memo, useCallback } from 'react';
import type { AuthConfig } from '../../shared/models';
import { useRequestStore } from '../stores/request-store';
import './AuthPanel.css';

// ---------------------------------------------------------------------------
// Auth type label map
// ---------------------------------------------------------------------------

const AUTH_TYPE_LABELS: Record<AuthConfig['type'], string> = {
  none: 'None',
  bearer: 'Bearer Token',
  basic: 'Basic Auth',
  apikey: 'API Key',
};

const AUTH_TYPES = ['none', 'bearer', 'basic', 'apikey'] as const;

// ---------------------------------------------------------------------------
// AuthPanel
// ---------------------------------------------------------------------------

export const AuthPanel = memo(function AuthPanel(): React.ReactElement {
  const auth = useRequestStore((s) => s.auth);
  const setAuth = useRequestStore((s) => s.setAuth);

  const handleTypeChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const type = e.target.value as AuthConfig['type'];
      switch (type) {
        case 'none':
          setAuth({ type: 'none' });
          break;
        case 'bearer':
          setAuth({ type: 'bearer', token: auth.type === 'bearer' ? auth.token : '' });
          break;
        case 'basic':
          setAuth({
            type: 'basic',
            username: auth.type === 'basic' ? auth.username : '',
            password: auth.type === 'basic' ? auth.password : '',
          });
          break;
        case 'apikey':
          setAuth({
            type: 'apikey',
            key: auth.type === 'apikey' ? auth.key : '',
            value: auth.type === 'apikey' ? auth.value : '',
            addTo: auth.type === 'apikey' ? auth.addTo : 'header',
          });
          break;
      }
    },
    [auth, setAuth],
  );

  return (
    <div className="auth-panel">
      {/* Type selector */}
      <div className="auth-panel__row auth-panel__row--type">
        <label className="auth-panel__label" htmlFor="auth-type-select">
          Auth Type
        </label>
        <select
          id="auth-type-select"
          className="auth-panel__select"
          value={auth.type}
          onChange={handleTypeChange}
          aria-label="Authentication type"
        >
          {AUTH_TYPES.map((t) => (
            <option key={t} value={t}>
              {AUTH_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </div>

      {/* None — no inputs needed */}
      {auth.type === 'none' && (
        <div className="auth-panel__empty">
          <span className="auth-panel__empty-text">
            No authentication will be added to this request.
          </span>
        </div>
      )}

      {/* Bearer Token */}
      {auth.type === 'bearer' && (
        <div className="auth-panel__fields">
          <label className="auth-panel__label" htmlFor="auth-bearer-token">
            Token
          </label>
          <input
            id="auth-bearer-token"
            type="text"
            className="auth-panel__input"
            value={auth.token}
            onChange={(e) => setAuth({ type: 'bearer', token: e.target.value })}
            placeholder="{{token}} or paste your token"
            spellCheck={false}
            autoComplete="off"
            aria-label="Bearer token value"
          />
          <span className="auth-panel__hint">
            Generates: <code>Authorization: Bearer &lt;token&gt;</code>
          </span>
        </div>
      )}

      {/* Basic Auth */}
      {auth.type === 'basic' && (
        <div className="auth-panel__fields">
          <label className="auth-panel__label" htmlFor="auth-basic-username">
            Username
          </label>
          <input
            id="auth-basic-username"
            type="text"
            className="auth-panel__input"
            value={auth.username}
            onChange={(e) =>
              setAuth({ type: 'basic', username: e.target.value, password: auth.password })
            }
            placeholder="{{username}} or enter username"
            spellCheck={false}
            autoComplete="off"
            aria-label="Basic auth username"
          />
          <label className="auth-panel__label" htmlFor="auth-basic-password">
            Password
          </label>
          <input
            id="auth-basic-password"
            type="password"
            className="auth-panel__input"
            value={auth.password}
            onChange={(e) =>
              setAuth({ type: 'basic', username: auth.username, password: e.target.value })
            }
            placeholder="{{password}} or enter password"
            autoComplete="current-password"
            aria-label="Basic auth password"
          />
          <span className="auth-panel__hint">
            Generates: <code>Authorization: Basic &lt;base64(user:pass)&gt;</code>
          </span>
        </div>
      )}

      {/* API Key */}
      {auth.type === 'apikey' && (
        <div className="auth-panel__fields">
          <label className="auth-panel__label" htmlFor="auth-apikey-name">
            Key Name
          </label>
          <input
            id="auth-apikey-name"
            type="text"
            className="auth-panel__input"
            value={auth.key}
            onChange={(e) =>
              setAuth({ type: 'apikey', key: e.target.value, value: auth.value, addTo: auth.addTo })
            }
            placeholder="X-Api-Key"
            spellCheck={false}
            autoComplete="off"
            aria-label="API key header/param name"
          />
          <label className="auth-panel__label" htmlFor="auth-apikey-value">
            Value
          </label>
          <input
            id="auth-apikey-value"
            type="text"
            className="auth-panel__input"
            value={auth.value}
            onChange={(e) =>
              setAuth({ type: 'apikey', key: auth.key, value: e.target.value, addTo: auth.addTo })
            }
            placeholder="{{apiKey}} or paste key value"
            spellCheck={false}
            autoComplete="off"
            aria-label="API key value"
          />
          <label className="auth-panel__label" htmlFor="auth-apikey-location">
            Add to
          </label>
          <select
            id="auth-apikey-location"
            className="auth-panel__select auth-panel__select--small"
            value={auth.addTo}
            onChange={(e) =>
              setAuth({
                type: 'apikey',
                key: auth.key,
                value: auth.value,
                addTo: e.target.value as 'header' | 'query',
              })
            }
            aria-label="Where to add the API key"
          >
            <option value="header">Header</option>
            <option value="query">Query Param</option>
          </select>
        </div>
      )}
    </div>
  );
});
