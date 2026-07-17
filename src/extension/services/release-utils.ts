/**
 * @fileoverview Pure (no-`vscode`) helpers used by {@link update-service}.
 *
 * Kept in a separate module so they can be unit-tested without the VS Code
 * runtime — the update service itself imports `vscode` and is therefore not
 * directly loadable in a Node test environment.
 */

export interface ReleaseInfo {
  readonly version: string;
  readonly vsixUrl: string;
}

/**
 * Parse the JSON body of a GitHub Releases API response into a {@link ReleaseInfo}.
 *
 * Returns `null` for any malformed or unexpected payload — callers treat that
 * as "no usable release info available" and bail out without notifying.
 */
export function parseReleaseInfo(parsed: unknown): ReleaseInfo | null {
  if (typeof parsed !== 'object' || parsed === null) return null;

  const obj = parsed as Record<string, unknown>;

  const tagName = typeof obj['tag_name'] === 'string' ? obj['tag_name'] : null;
  if (!tagName) return null;

  const version = tagName.replace(/^v/, '');
  if (!version) return null;

  if (!Array.isArray(obj['assets'])) return null;
  const assets = obj['assets'] as Array<Record<string, unknown>>;

  const vsixAsset = assets.find(
    (a) => typeof a['name'] === 'string' && a['name'].endsWith('.vsix'),
  );
  if (!vsixAsset) return null;

  const vsixUrl =
    typeof vsixAsset['browser_download_url'] === 'string'
      ? vsixAsset['browser_download_url']
      : null;
  if (!vsixUrl) return null;

  return { version, vsixUrl };
}

/**
 * Strict semver comparison: returns `true` iff `remote` is newer than `current`.
 *
 * Both inputs may carry a leading `v` (e.g. `v1.2.3`); the prefix is stripped.
 * Missing parts default to `0`, so `0.8` is treated as `0.8.0`. Non-numeric
 * parts yield `NaN` and the comparison falls back to `false` (treated as
 * "not newer" rather than throwing).
 *
 * Empty strings are treated as malformed and always return `false`. This is
 * important because JavaScript's `Number('')` returns `0`, which would
 * otherwise turn an empty `currentVersion` into `0.0.0` and cause spurious
 * "update available" prompts against a broken local state.
 */
export function isNewerVersion(remote: string, current: string): boolean {
  if (remote === '' || current === '') return false;

  const parse = (v: string): [number, number, number] => {
    const parts = v.replace(/^v/, '').split('.').map(Number);
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  };

  const [rMaj, rMin, rPat] = parse(remote);
  const [cMaj, cMin, cPat] = parse(current);

  if (Number.isNaN(rMaj) || Number.isNaN(rMin) || Number.isNaN(rPat)) return false;
  if (Number.isNaN(cMaj) || Number.isNaN(cMin) || Number.isNaN(cPat)) return false;

  if (rMaj !== cMaj) return rMaj > cMaj;
  if (rMin !== cMin) return rMin > cMin;
  return rPat > cPat;
}
