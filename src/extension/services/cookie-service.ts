/**
 * @fileoverview Volt Cookie Service.
 *
 * In-memory cookie jar that automatically captures `Set-Cookie` response
 * headers and injects matching cookies into subsequent requests to the same
 * domain.
 *
 * Design decisions:
 * - Pure in-memory store — resets on VS Code restart (no persistence).
 * - Domain matching supports leading-dot notation (`.example.com` matches
 *   `api.example.com` and `example.com`).
 * - Path matching: cookie path must be a prefix of the request path.
 * - Expired cookies are filtered out at read time (lazy expiry).
 * - HttpOnly and Secure flags are stored but not enforced (extension context
 *   is not a browser).
 */

import type * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Cookie struct
// ---------------------------------------------------------------------------

export interface Cookie {
  readonly name: string;
  value: string;
  readonly domain: string;
  readonly path: string;
  expires: Date | null;
  readonly httpOnly: boolean;
  readonly secure: boolean;
}

// ---------------------------------------------------------------------------
// CookieService
// ---------------------------------------------------------------------------

export class CookieService {
  private readonly output: vscode.OutputChannel;
  /** domain → Cookie[] */
  private readonly store = new Map<string, Cookie[]>();

  constructor(output: vscode.OutputChannel) {
    this.output = output;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Parse `Set-Cookie` headers from the response and store matching cookies.
   * Handles both `Set-Cookie` (single) and multiple headers via a header map
   * where multi-value headers may be comma-joined or newline-joined.
   */
  captureCookies(url: string, responseHeaders: Record<string, string>): void {
    const requestDomain = extractDomain(url);
    if (!requestDomain) return;

    // Collect all Set-Cookie header values — they may appear as a single header
    // with multiple values joined by a newline (undici header folding) or as a
    // repeated header key lowercased.
    const rawValues: string[] = [];
    for (const [key, value] of Object.entries(responseHeaders)) {
      if (key.toLowerCase() === 'set-cookie') {
        // Values may be newline-separated when undici folds repeated headers
        rawValues.push(...value.split('\n').map((v) => v.trim()).filter(Boolean));
      }
    }

    for (const raw of rawValues) {
      const cookie = parseSetCookie(raw, requestDomain);
      if (!cookie) continue;

      const domain = cookie.domain;
      const existing = this.store.get(domain) ?? [];
      // Replace cookie with same name + path, or append
      const idx = existing.findIndex(
        (c) => c.name === cookie.name && c.path === cookie.path,
      );
      if (idx !== -1) {
        existing.splice(idx, 1, cookie);
      } else {
        existing.push(cookie);
      }
      this.store.set(domain, existing);
      this.output.appendLine(
        `[CookieService] Captured cookie "${cookie.name}" for domain "${domain}"`,
      );
    }
  }

  /**
   * Build the `Cookie` header value for the given URL by collecting all
   * matching, non-expired cookies.
   *
   * Returns an empty string if no cookies match.
   */
  getCookies(url: string): string {
    const requestDomain = extractDomain(url);
    const requestPath = extractPath(url);
    if (!requestDomain) return '';

    const now = new Date();
    const matching: Cookie[] = [];

    for (const [domain, cookies] of this.store.entries()) {
      if (!domainMatches(domain, requestDomain)) continue;

      for (const cookie of cookies) {
        if (cookie.expires && cookie.expires < now) continue;
        if (!requestPath.startsWith(cookie.path)) continue;
        matching.push(cookie);
      }
    }

    if (matching.length === 0) return '';

    return matching.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  /** Clear all stored cookies. */
  clearAll(): void {
    this.store.clear();
    this.output.appendLine('[CookieService] Cleared all cookies');
  }

  /** Clear all cookies for a specific domain (exact match). */
  clearDomain(domain: string): void {
    this.store.delete(domain);
    this.output.appendLine(`[CookieService] Cleared cookies for domain "${domain}"`);
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Extract the hostname from a URL string.
 * Returns `null` on parse failure.
 */
function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Extract the path from a URL string. Defaults to `/` on parse failure.
 */
function extractPath(url: string): string {
  try {
    const p = new URL(url).pathname;
    return p || '/';
  } catch {
    return '/';
  }
}

/**
 * Return true if the cookie domain matches the request domain.
 *
 * Rules:
 * - Exact match: `example.com` === `example.com`
 * - Leading-dot: `.example.com` matches `example.com` AND `api.example.com`
 * - Without leading dot, treat as exact (per RFC 6265 §5.1.3)
 */
function domainMatches(cookieDomain: string, requestDomain: string): boolean {
  const cd = cookieDomain.toLowerCase();
  const rd = requestDomain.toLowerCase();

  if (cd.startsWith('.')) {
    const base = cd.slice(1);
    return rd === base || rd.endsWith(`.${base}`);
  }

  return cd === rd;
}

/**
 * Parse a raw `Set-Cookie` header value into a `Cookie` struct.
 * Returns `null` if the header is malformed.
 *
 * Format: `name=value; attr=val; flag`
 */
function parseSetCookie(raw: string, requestDomain: string): Cookie | null {
  const parts = raw.split(';').map((p) => p.trim());
  const first = parts[0];
  if (!first) return null;

  const eqIdx = first.indexOf('=');
  if (eqIdx === -1) return null;

  const name = first.slice(0, eqIdx).trim();
  const value = first.slice(eqIdx + 1).trim();

  if (!name) return null;

  let domain = requestDomain;
  let path = '/';
  let expires: Date | null = null;
  let httpOnly = false;
  let secure = false;

  for (let i = 1; i < parts.length; i++) {
    const attr = parts[i];
    if (!attr) continue;
    const attrLower = attr.toLowerCase();

    if (attrLower === 'httponly') {
      httpOnly = true;
    } else if (attrLower === 'secure') {
      secure = true;
    } else if (attrLower.startsWith('domain=')) {
      const d = attr.slice('domain='.length).trim();
      if (d) domain = d.toLowerCase();
    } else if (attrLower.startsWith('path=')) {
      const p = attr.slice('path='.length).trim();
      if (p) path = p;
    } else if (attrLower.startsWith('expires=')) {
      const d = attr.slice('expires='.length).trim();
      if (d) {
        const parsed = new Date(d);
        if (!isNaN(parsed.getTime())) expires = parsed;
      }
    } else if (attrLower.startsWith('max-age=')) {
      const maxAge = parseInt(attr.slice('max-age='.length).trim(), 10);
      if (!isNaN(maxAge)) {
        if (maxAge <= 0) {
          expires = new Date(0); // Force expiry
        } else {
          expires = new Date(Date.now() + maxAge * 1000);
        }
      }
    }
  }

  return { name, value, domain, path, expires, httpOnly, secure };
}
