/**
 * @fileoverview Pure (no-`vscode`) helpers for the "large response body" offload
 * path used by {@link http-service} and consumed by {@link message-router}.
 *
 * Extracted into a separate module so the URI construction can be unit-tested
 * without the VS Code runtime.
 *
 * History: prior versions hand-built the `file://` URI by string concatenation
 * (`` `file:///${path.replace(/\\/g, '/')}` ``). That breaks on POSIX systems
 * where `os.tmpdir()` already starts with `/`, producing `file:////var/...`
 * — a URI with an empty authority and a path that begins with `//`, which the
 * WHATWG parser rejects with:
 *
 *   [UriError]: If a URI does not contain an authority component, then the
 *               path cannot begin with two slash characters ("//")
 *
 * Always go through {@link pathToFileURL} so the encoding is correct on every
 * platform.
 */

import { pathToFileURL } from 'node:url';

/**
 * Build a `file://` URI that points at the temp file holding an offloaded
 * response body.
 *
 * Round-trips cleanly through `vscode.Uri.parse(...)` and `new URL(...)` on
 * every platform — including macOS/Linux where `os.tmpdir()` returns an
 * absolute POSIX path beginning with `/`.
 */
export function bodyRefFor(tmpFile: string): string {
  return pathToFileURL(tmpFile).href;
}

/**
 * Returns `true` iff `value` is a `file://` URI that the save-to-file handler
 * can safely round-trip through `vscode.Uri.parse(...)`.
 *
 * `URL.canParse` alone is not enough: the WHATWG parser is lenient enough to
 * accept `file:////var/folders/...` (empty authority + `//`-prefixed path),
 * which `vscode.Uri.parse` then rejects with the UriError documented above.
 * We additionally require that the pathname does not start with `//`.
 *
 * Why not just `startsWith('file:///')`? Because that prefix check is exactly
 * what allowed the bug in the first place — it returned `true` for the
 * broken `file:////var/...` shape and sent it straight into `vscode.Uri.parse`.
 */
export function isFileUri(value: string): boolean {
  if (!URL.canParse(value)) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'file:') return false;
  if (parsed.pathname.startsWith('//')) return false;
  return true;
}
