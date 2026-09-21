/**
 * @fileoverview Regression tests for the URL builder used by {@link http-service}.
 *
 * Locks down the bug where a URL containing a query string (e.g. SAP OData
 * `?$filter=ItemCode eq '2606000310038'`) ALSO had the same params parsed into
 * the `queryParams` array by the webview — `buildRequestUrl` then emitted the
 * param twice and OData parse rejected the request. The fix is in
 * `buildRequestUrl`: when a key already exists in the URL, the param array
 * wins and the URL value is discarded.
 */

import { describe, expect, it } from 'vitest';
import { buildRequestUrl } from './url-utils';
import type { QueryParam } from '../../shared/models';

const param = (key: string, value: string, enabled = true): QueryParam => ({
  key,
  value,
  enabled,
});

describe('buildRequestUrl', () => {
  // ---------------------------------------------------------------------
  // The bug we're fixing: SAP OData $filter duplication
  // ---------------------------------------------------------------------

  it('does NOT duplicate a query param that already exists in the URL (SAP OData $filter case)', () => {
    // This is the exact URL the user reported. They paste it into the URL
    // bar, the webview parses the $filter into queryParams, and the
    // extension previously emitted it twice — which OData parse rejects.
    const req = {
      url: "https://server/b1s/v1/view.svc/VWMS_GetBatchesB1SLQuery?%24filter=ItemCode%20eq%20'2606000310038'",
      queryParams: [param('$filter', "ItemCode eq '2606000310038'")],
    };

    const result = buildRequestUrl(req);
    const u = new URL(result);

    expect(u.searchParams.getAll('$filter')).toEqual(["ItemCode eq '2606000310038'"]);
    expect(result.match(/%24filter/g)?.length ?? 0).toBe(1);
  });

  it('handles the un-encoded form of the same URL', () => {
    // User pastes the URL as-is (browsers commonly render $ unencoded).
    const req = {
      url: "https://server/b1s/v1/view.svc/VWMS_GetBatchesB1SLQuery?$filter=ItemCode eq '2606000310038'",
      queryParams: [param('$filter', "ItemCode eq '2606000310038'")],
    };

    const u = new URL(buildRequestUrl(req));
    expect(u.searchParams.getAll('$filter')).toEqual(["ItemCode eq '2606000310038'"]);
  });

  // ---------------------------------------------------------------------
  // General behaviour
  // ---------------------------------------------------------------------

  it('returns the URL unchanged when queryParams is empty', () => {
    const req = {
      url: 'https://api.example.com/users?id=42',
      queryParams: [] as QueryParam[],
    };
    expect(buildRequestUrl(req)).toBe('https://api.example.com/users?id=42');
  });

  it('appends queryParams when the URL has no query string', () => {
    const req = {
      url: 'https://api.example.com/users',
      queryParams: [param('page', '1'), param('limit', '20')],
    };
    const u = new URL(buildRequestUrl(req));
    expect(u.searchParams.get('page')).toBe('1');
    expect(u.searchParams.get('limit')).toBe('20');
  });

  it('keeps existing URL params and appends new queryParams alongside', () => {
    const req = {
      url: 'https://api.example.com/users?id=42',
      queryParams: [param('page', '1')],
    };
    const u = new URL(buildRequestUrl(req));
    expect(u.searchParams.get('id')).toBe('42');
    expect(u.searchParams.get('page')).toBe('1');
  });

  it('lets queryParams override URL params with the same key (so {{var}} interpolation wins)', () => {
    // Auth flow: webview sends resolved base + a {{token}}-bearing param
    // that may also be encoded in the URL. The param array version wins
    // because EnvironmentService.resolveRequest runs after the URL is
    // already a string but BEFORE the params array is merged.
    const req = {
      url: 'https://api.example.com/users?token=OLD',
      queryParams: [param('token', 'INTERPOLATED')],
    };
    const u = new URL(buildRequestUrl(req));
    expect(u.searchParams.getAll('token')).toEqual(['INTERPOLATED']);
  });

  it('skips disabled params', () => {
    const req = {
      url: 'https://api.example.com/users',
      queryParams: [param('page', '1', /* enabled */ false), param('limit', '20')],
    };
    const u = new URL(buildRequestUrl(req));
    expect(u.searchParams.has('page')).toBe(false);
    expect(u.searchParams.get('limit')).toBe('20');
  });

  it('skips params with empty or whitespace-only keys', () => {
    const req = {
      url: 'https://api.example.com/users',
      queryParams: [param('  ', 'value'), param('', 'value'), param('limit', '20')],
    };
    const u = new URL(buildRequestUrl(req));
    expect(u.searchParams.has('  ')).toBe(false);
    expect(u.searchParams.has('')).toBe(false);
    expect(u.searchParams.get('limit')).toBe('20');
  });

  it('preserves URL values for keys that are NOT in queryParams', () => {
    // URL has `kept=1`, queryParams only overrides a different key.
    const req = {
      url: 'https://api.example.com/users?kept=1',
      queryParams: [param('page', '2')],
    };
    const u = new URL(buildRequestUrl(req));
    expect(u.searchParams.get('kept')).toBe('1');
    expect(u.searchParams.get('page')).toBe('2');
  });

  it('auto-prepends https:// when the URL has no scheme', () => {
    const req = {
      url: 'api.example.com/users',
      queryParams: [] as QueryParam[],
    };
    expect(buildRequestUrl(req)).toBe('https://api.example.com/users');
  });

  it('preserves http:// when explicitly given', () => {
    const req = {
      url: 'http://localhost:3000/health',
      queryParams: [] as QueryParam[],
    };
    expect(buildRequestUrl(req)).toBe('http://localhost:3000/health');
  });

  it('handles a queryParam whose value is itself URL-encoded safely (round-trip)', () => {
    // Common case: user pastes an OData $filter with embedded single
    // quotes and spaces. After URL round-trip the encoding may switch
    // between %20 and +, but the parsed value stays semantically equal.
    const req = {
      url: "https://server/odata/Users?%24filter=Name%20eq%20'jane'",
      queryParams: [param('$filter', "Name eq 'jane'")],
    };

    const u = new URL(buildRequestUrl(req));
    expect(u.searchParams.getAll('$filter')).toEqual(["Name eq 'jane'"]);
  });
});
