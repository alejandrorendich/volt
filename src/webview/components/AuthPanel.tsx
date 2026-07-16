/**
 * @fileoverview AuthPanel — authentication configuration UI for request builder.
 *
 * Renders a type selector (None / Bearer / Basic / API Key / OAuth2 / AWS SigV4)
 * and the appropriate input fields for each auth type. Values are stored in
 * `useRequestStore`. The OAuth2 panel includes a "Get Token" button that
 * sends `request:oauth2-get-token` to the host and stores the result.
 */

import React, { memo, useCallback, useState } from 'react';
import type { AuthConfig } from '../../shared/models';
import { useRequestStore } from '../stores/request-store';
import { useMessage } from '../hooks/useMessage';
import './AuthPanel.css';

// ---------------------------------------------------------------------------
// Auth type label map
// ---------------------------------------------------------------------------

const AUTH_TYPE_LABELS: Record<AuthConfig['type'], string> = {
  none: 'None',
  bearer: 'Bearer Token',
  basic: 'Basic Auth',
  apikey: 'API Key',
  oauth2: 'OAuth 2.0',
  aws: 'AWS Signature V4',
};

const AUTH_TYPES = ['none', 'bearer', 'basic', 'apikey', 'oauth2', 'aws'] as const;

// ---------------------------------------------------------------------------
// AuthPanel
// ---------------------------------------------------------------------------

export const AuthPanel = memo(function AuthPanel(): React.ReactElement {
  const auth = useRequestStore((s) => s.auth);
  const setAuth = useRequestStore((s) => s.setAuth);
  const { request: sendRequest } = useMessage();

  const [tokenLoading, setTokenLoading] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);

  const handleTypeChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const type = e.target.value as AuthConfig['type'];
      setTokenError(null);
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
        case 'oauth2':
          setAuth({
            type: 'oauth2',
            grantType: auth.type === 'oauth2' ? auth.grantType : 'client_credentials',
            tokenUrl: auth.type === 'oauth2' ? auth.tokenUrl : '',
            clientId: auth.type === 'oauth2' ? auth.clientId : '',
            clientSecret: auth.type === 'oauth2' ? auth.clientSecret : '',
            scope: auth.type === 'oauth2' ? auth.scope : '',
            accessToken: auth.type === 'oauth2' ? auth.accessToken : '',
          });
          break;
        case 'aws':
          setAuth({
            type: 'aws',
            accessKeyId: auth.type === 'aws' ? auth.accessKeyId : '',
            secretAccessKey: auth.type === 'aws' ? auth.secretAccessKey : '',
            region: auth.type === 'aws' ? auth.region : '',
            service: auth.type === 'aws' ? auth.service : '',
          });
          break;
      }
    },
    [auth, setAuth],
  );

  /** Fetch an OAuth2 token via the extension host. */
  const handleGetToken = useCallback(async () => {
    if (auth.type !== 'oauth2') return;
    setTokenLoading(true);
    setTokenError(null);
    try {
      const correlationId = `oauth2-${Date.now()}`;
      const response = await sendRequest({
        type: 'request:oauth2-get-token',
        correlationId,
        payload: {
          tokenUrl: auth.tokenUrl,
          clientId: auth.clientId,
          clientSecret: auth.clientSecret,
          scope: auth.scope,
          grantType: auth.grantType,
        },
      });
      if (response.type !== 'response:oauth2-token') return;
      const msg = response;
      if ('error' in msg.payload) {
        setTokenError(msg.payload.error);
      } else {
        setAuth({ ...auth, accessToken: msg.payload.accessToken });
      }
    } catch (err: unknown) {
      setTokenError(err instanceof Error ? err.message : String(err));
    } finally {
      setTokenLoading(false);
    }
  }, [auth, setAuth, sendRequest]);

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

      {/* OAuth 2.0 */}
      {auth.type === 'oauth2' && (
        <div className="auth-panel__fields">
          <label className="auth-panel__label" htmlFor="auth-oauth2-grant">
            Grant Type
          </label>
          <select
            id="auth-oauth2-grant"
            className="auth-panel__select"
            value={auth.grantType}
            onChange={(e) =>
              setAuth({
                ...auth,
                grantType: e.target.value as 'client_credentials' | 'authorization_code',
              })
            }
            aria-label="OAuth2 grant type"
          >
            <option value="client_credentials">Client Credentials</option>
            <option value="authorization_code">Authorization Code</option>
          </select>

          <label className="auth-panel__label" htmlFor="auth-oauth2-tokenurl">
            Token URL
          </label>
          <input
            id="auth-oauth2-tokenurl"
            type="text"
            className="auth-panel__input"
            value={auth.tokenUrl}
            onChange={(e) => setAuth({ ...auth, tokenUrl: e.target.value })}
            placeholder="{{tokenUrl}} or https://auth.example.com/oauth/token"
            spellCheck={false}
            autoComplete="off"
            aria-label="OAuth2 token endpoint URL"
          />

          <label className="auth-panel__label" htmlFor="auth-oauth2-clientid">
            Client ID
          </label>
          <input
            id="auth-oauth2-clientid"
            type="text"
            className="auth-panel__input"
            value={auth.clientId}
            onChange={(e) => setAuth({ ...auth, clientId: e.target.value })}
            placeholder="{{clientId}}"
            spellCheck={false}
            autoComplete="off"
            aria-label="OAuth2 client ID"
          />

          <label className="auth-panel__label" htmlFor="auth-oauth2-secret">
            Client Secret
          </label>
          <input
            id="auth-oauth2-secret"
            type="password"
            className="auth-panel__input"
            value={auth.clientSecret}
            onChange={(e) => setAuth({ ...auth, clientSecret: e.target.value })}
            placeholder="{{clientSecret}}"
            autoComplete="new-password"
            aria-label="OAuth2 client secret"
          />

          <label className="auth-panel__label" htmlFor="auth-oauth2-scope">
            Scope
          </label>
          <input
            id="auth-oauth2-scope"
            type="text"
            className="auth-panel__input"
            value={auth.scope}
            onChange={(e) => setAuth({ ...auth, scope: e.target.value })}
            placeholder="openid profile email"
            spellCheck={false}
            autoComplete="off"
            aria-label="OAuth2 requested scopes"
          />

          {/* Get Token button + error */}
          <span className="auth-panel__label" />
          <div className="auth-panel__oauth2-actions">
            <button
              type="button"
              className="auth-panel__btn"
              onClick={() => { void handleGetToken(); }}
              disabled={tokenLoading || !auth.tokenUrl || !auth.clientId}
              aria-label="Fetch OAuth2 access token"
            >
              {tokenLoading ? 'Fetching…' : 'Get Token'}
            </button>
            {tokenError && (
              <span className="auth-panel__error" role="alert">
                {tokenError}
              </span>
            )}
          </div>

          {/* Access Token (read-only display) */}
          <label className="auth-panel__label" htmlFor="auth-oauth2-token">
            Access Token
          </label>
          <input
            id="auth-oauth2-token"
            type="text"
            className="auth-panel__input auth-panel__input--token"
            value={auth.accessToken}
            onChange={(e) => setAuth({ ...auth, accessToken: e.target.value })}
            placeholder="Token appears here after 'Get Token' — or paste manually"
            spellCheck={false}
            autoComplete="off"
            aria-label="OAuth2 access token (used as Bearer)"
          />

          <span className="auth-panel__hint">
            {auth.grantType === 'client_credentials'
              ? <>Sends <code>POST</code> to Token URL with <code>grant_type=client_credentials</code>. Token is used as <code>Authorization: Bearer</code>.</>
              : <>Authorization Code flow requires a browser redirect. Obtain the token externally and paste it into Access Token.</>
            }
          </span>
        </div>
      )}

      {/* AWS Signature V4 */}
      {auth.type === 'aws' && (
        <div className="auth-panel__fields">
          <label className="auth-panel__label" htmlFor="auth-aws-keyid">
            Access Key ID
          </label>
          <input
            id="auth-aws-keyid"
            type="text"
            className="auth-panel__input"
            value={auth.accessKeyId}
            onChange={(e) => setAuth({ ...auth, accessKeyId: e.target.value })}
            placeholder="{{awsAccessKeyId}} or AKIAIOSFODNN7EXAMPLE"
            spellCheck={false}
            autoComplete="off"
            aria-label="AWS access key ID"
          />

          <label className="auth-panel__label" htmlFor="auth-aws-secret">
            Secret Key
          </label>
          <input
            id="auth-aws-secret"
            type="password"
            className="auth-panel__input"
            value={auth.secretAccessKey}
            onChange={(e) => setAuth({ ...auth, secretAccessKey: e.target.value })}
            placeholder="{{awsSecretKey}}"
            autoComplete="new-password"
            aria-label="AWS secret access key"
          />

          <label className="auth-panel__label" htmlFor="auth-aws-region">
            Region
          </label>
          <input
            id="auth-aws-region"
            type="text"
            className="auth-panel__input"
            value={auth.region}
            onChange={(e) => setAuth({ ...auth, region: e.target.value })}
            placeholder="us-east-1"
            spellCheck={false}
            autoComplete="off"
            aria-label="AWS region"
          />

          <label className="auth-panel__label" htmlFor="auth-aws-service">
            Service
          </label>
          <input
            id="auth-aws-service"
            type="text"
            className="auth-panel__input"
            value={auth.service}
            onChange={(e) => setAuth({ ...auth, service: e.target.value })}
            placeholder="execute-api"
            spellCheck={false}
            autoComplete="off"
            aria-label="AWS service name"
          />

          <label className="auth-panel__label" htmlFor="auth-aws-session">
            Session Token
          </label>
          <input
            id="auth-aws-session"
            type="password"
            className="auth-panel__input"
            value={auth.sessionToken ?? ''}
            onChange={(e) => {
              const val = e.target.value;
              if (val) {
                setAuth({ ...auth, sessionToken: val });
              } else {
                // Remove sessionToken key when empty (exactOptionalPropertyTypes)
                const { sessionToken: _omit, ...rest } = auth;
                void _omit;
                setAuth(rest);
              }
            }}
            placeholder="Optional — for STS temporary credentials"
            autoComplete="new-password"
            aria-label="AWS session token (optional)"
          />

          <span className="auth-panel__hint">
            Signs with <code>AWS4-HMAC-SHA256</code>. Injects <code>Authorization</code> and{' '}
            <code>X-Amz-Date</code> headers. Signing happens after{' '}
            <code>{'{{variable}}'}</code> interpolation.
          </span>
        </div>
      )}
    </div>
  );
});
