/**
 * @fileoverview Pure helpers for building the final request URL.
 *
 * Extracted from {@link http-service} so the URL-merge logic can be
 * unit-tested without the VS Code runtime.
 *
 * History: prior to this module `buildUrl` lived inside `http-service.ts`
 * and simply appended every enabled `QueryParam` to whatever query string
 * was already encoded in `req.url`. The webview stores BOTH the full URL
 * (as typed by the user) AND the parsed query-param array, so for any URL
 * that includes a query string — e.g. SAP OData endpoints that embed a
 * `$filter` clause directly in the URL — the param ended up duplicated:
 *
 *   input    : ?$filter=ItemCode eq '2606000310038'
 *   emitted  : ?$filter=ItemCode eq '2606000310038'&$filter=ItemCode eq '2606000310038'
 *
 * That breaks OData parsing. This module de-duplicates by key: if `req.url`
 * already carries the same key as one of `queryParams`, the URL value is
 * discarded and the queryParams value wins (so `{{var}}` placeholders inside
 * the param array still resolve correctly).
 */

import type { QueryParam } from '../../shared/models';

/**
 * Minimal shape needed to build the final URL — accept anything that exposes
 * `url` and `queryParams`. Keeps the helper free of the full `HttpRequestDef`
 * type so it stays cheap to call from tests.
 */
export interface RequestUrlSource {
  readonly url: string;
  readonly queryParams: readonly QueryParam[];
}

/**
 * Build the final request URL: the user's `url` (auto-prepended with
 * `https://` if it has no scheme) with every enabled `QueryParam` merged in.
 *
 * When a key appears in BOTH the URL's query string AND the `queryParams`
 * array, the value from `queryParams` wins. This handles the common case of
 * a user pasting `https://server/path?foo=bar` into the URL bar — the
 * webview parses `foo=bar` into the params list, and we must not emit it
 * twice.
 *
 * Params with `enabled: false` or empty/whitespace-only keys are skipped.
 */
export function buildRequestUrl(req: RequestUrlSource): string {
  let rawUrl = req.url;
  if (!/^https?:\/\//i.test(rawUrl)) {
    rawUrl = 'https://' + rawUrl;
  }

  const enabledParams = req.queryParams.filter((p) => p.enabled && p.key.trim() !== '');
  if (enabledParams.length === 0) {
    return rawUrl;
  }

  const urlObj = new URL(rawUrl);
  for (const p of enabledParams) {
    // De-dupe: if the URL already carries this key, drop the URL's copy so
    // the param array's value (which may carry an interpolated `{{var}}`)
    // becomes the only occurrence in the final URL.
    if (urlObj.searchParams.has(p.key)) {
      urlObj.searchParams.delete(p.key);
    }
    urlObj.searchParams.append(p.key, p.value);
  }
  return urlObj.toString();
}
