/**
 * @fileoverview Volt Update Service.
 *
 * Checks GitHub Releases for a newer version of Volt and offers to install it.
 *
 * Design decisions:
 * - Uses Node's built-in `https` module — no extra runtime dependencies.
 * - Runs once per VS Code session (`checked` guard).
 * - Fully non-blocking: `checkForUpdates` is fire-and-forget from `activate`.
 * - Silent on all network errors (offline, rate-limited, timeout, etc.).
 * - Follows HTTP 302 redirects for the .vsix asset download (GitHub → CDN).
 * - 5-second timeout on the GitHub API call.
 * - Simple three-part semver comparison (major.minor.patch); no library needed.
 */

import * as https from 'https';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GITHUB_API_URL =
  'https://api.github.com/repos/alejandrorendich/volt/releases/latest';
const API_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ReleaseInfo {
  readonly version: string;
  readonly vsixUrl: string;
}

// ---------------------------------------------------------------------------
// UpdateService
// ---------------------------------------------------------------------------

export class UpdateService {
  private readonly currentVersion: string;
  private readonly output: vscode.OutputChannel;
  /** Guards so we only check once per VS Code session. */
  private checked = false;

  constructor(output: vscode.OutputChannel, currentVersion: string) {
    this.output = output;
    this.currentVersion = currentVersion;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Check GitHub Releases for a newer Volt version.
   *
   * Call once at extension activation — fire-and-forget (`void checkForUpdates()`).
   * All errors are swallowed silently so the user is never bothered when offline
   * or if the API is rate-limited.
   */
  async checkForUpdates(): Promise<void> {
    if (this.checked) return;
    this.checked = true;

    try {
      const latest = await this.fetchLatestRelease();
      if (!latest || !this.isNewer(latest.version)) return;

      this.output.appendLine(
        `[Volt] Update available: v${latest.version} (installed: v${this.currentVersion})`,
      );

      const choice = await vscode.window.showInformationMessage(
        `Volt v${latest.version} is available (you have v${this.currentVersion}). Update now?`,
        'Update',
        'Later',
      );

      if (choice === 'Update') {
        await this.installUpdate(latest.vsixUrl, latest.version);
      }
    } catch (err: unknown) {
      // Silently ignore — network issues, API rate limits, parse errors, etc.
      this.output.appendLine(
        `[Volt] Update check failed (silent): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Fetch the latest release metadata from the GitHub Releases API.
   * Returns `null` if the response is malformed or cannot be parsed.
   */
  private fetchLatestRelease(): Promise<ReleaseInfo | null> {
    return new Promise((resolve, reject) => {
      const req = https.get(
        GITHUB_API_URL,
        {
          headers: {
            'User-Agent': 'Volt-Extension',
            Accept: 'application/vnd.github.v3+json',
          },
          timeout: API_TIMEOUT_MS,
        },
        (res) => {
          if (res.statusCode !== 200) {
            // Non-200 (404, 403, etc.) → treat as "no release found"
            res.resume();
            resolve(null);
            return;
          }

          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => { raw += chunk; });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(raw) as Record<string, unknown>;

              // tag_name may be "v1.2.3" or "1.2.3"
              const tagName = typeof parsed['tag_name'] === 'string'
                ? parsed['tag_name']
                : null;

              if (!tagName) {
                resolve(null);
                return;
              }

              const version = tagName.replace(/^v/, '');

              // Find the .vsix asset
              const assets = Array.isArray(parsed['assets'])
                ? (parsed['assets'] as Array<Record<string, unknown>>)
                : [];

              const vsixAsset = assets.find(
                (a) =>
                  typeof a['name'] === 'string' &&
                  (a['name'] as string).endsWith('.vsix'),
              );

              if (!vsixAsset) {
                resolve(null);
                return;
              }

              const vsixUrl =
                typeof vsixAsset['browser_download_url'] === 'string'
                  ? (vsixAsset['browser_download_url'] as string)
                  : null;

              if (!vsixUrl) {
                resolve(null);
                return;
              }

              resolve({ version, vsixUrl });
            } catch {
              resolve(null);
            }
          });
          res.on('error', reject);
        },
      );

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('GitHub API request timed out'));
      });
      req.on('error', reject);
    });
  }

  /**
   * Compare `remoteVersion` against the installed version.
   * Returns `true` only if the remote is strictly newer (major → minor → patch).
   */
  private isNewer(remoteVersion: string): boolean {
    const parse = (v: string): [number, number, number] => {
      const parts = v.replace(/^v/, '').split('.').map(Number);
      return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
    };

    const [rMaj, rMin, rPat] = parse(remoteVersion);
    const [cMaj, cMin, cPat] = parse(this.currentVersion);

    if (rMaj !== cMaj) return rMaj > cMaj;
    if (rMin !== cMin) return rMin > cMin;
    return rPat > cPat;
  }

  /**
   * Download the .vsix from `vsixUrl` to a temp file, then install it via the
   * VS Code extension host and offer a window reload.
   */
  private async installUpdate(vsixUrl: string, newVersion: string): Promise<void> {
    const tempFile = path.join(os.tmpdir(), `volt-${newVersion}.vsix`);

    this.output.appendLine(`[Volt] Downloading update to ${tempFile}…`);

    await this.downloadFile(vsixUrl, tempFile);

    const vsixUri = vscode.Uri.file(tempFile);

    await vscode.commands.executeCommand(
      'workbench.extensions.installExtension',
      vsixUri,
    );

    this.output.appendLine(`[Volt] Installed v${newVersion}`);

    const action = await vscode.window.showInformationMessage(
      `Volt updated to v${newVersion}. Reload VS Code to apply.`,
      'Reload Now',
    );

    if (action === 'Reload Now') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  }

  /**
   * Download a file from `url` to `dest`, following up to one redirect (GitHub
   * asset downloads return a 302 to a CDN URL).
   */
  private downloadFile(url: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.doDownload(url, dest, /* followedRedirect */ false, resolve, reject);
    });
  }

  private doDownload(
    url: string,
    dest: string,
    followedRedirect: boolean,
    resolve: () => void,
    reject: (err: Error) => void,
  ): void {
    https.get(
      url,
      { headers: { 'User-Agent': 'Volt-Extension' } },
      (res) => {
        // Follow a single redirect (GitHub → S3/CDN)
        if (
          (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) &&
          typeof res.headers['location'] === 'string' &&
          !followedRedirect
        ) {
          res.resume();
          this.doDownload(res.headers['location'], dest, true, resolve, reject);
          return;
        }

        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Download failed with HTTP ${res.statusCode ?? 'unknown'}`));
          return;
        }

        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
        file.on('error', (err) => {
          fs.unlink(dest, () => { /* ignore cleanup error */ });
          reject(err);
        });
        res.on('error', (err) => {
          fs.unlink(dest, () => { /* ignore cleanup error */ });
          reject(err);
        });
      },
    ).on('error', reject);
  }
}
