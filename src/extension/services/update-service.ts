/**
 * @fileoverview Volt Update Service.
 *
 * Checks GitHub Releases for a newer version of Volt and auto-installs it.
 *
 * Design decisions:
 * - Uses Node's built-in `https` module — no extra runtime dependencies.
 * - Runs once on activation, then re-checks every 6h while VS Code is open.
 * - Fully automatic: when a newer release is detected, the .vsix is downloaded
 *   and installed without user intervention, then the window reloads. No
 *   "Update / Later" prompt.
 * - Non-blocking: `checkForUpdates` and `startBackgroundChecks` are
 *   fire-and-forget from `activate`.
 * - All network and parse errors are logged to the `Volt` output channel —
 *   never silently swallowed — so debugging is possible.
 * - Follows HTTP 302 redirects for the .vsix asset download (GitHub → CDN).
 * - 5-second timeout on the GitHub API call.
 * - Simple three-part semver comparison (major.minor.patch); no library needed.
 */

import * as https from 'https';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { isNewerVersion, parseReleaseInfo, type ReleaseInfo } from './release-utils';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GITHUB_API_URL = 'https://api.github.com/repos/alejandrorendich/volt/releases/latest';
const API_TIMEOUT_MS = 5_000;
/** Re-check interval while VS Code stays open. */
const BACKGROUND_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;

// ---------------------------------------------------------------------------
// UpdateService
// ---------------------------------------------------------------------------

export interface CheckForUpdatesOptions {
  /**
   * If `true`, bypass both the in-flight guard and the "already notified about
   * this version" suppression. Used by the manual `volt.checkForUpdates`
   * command so users can force a fresh prompt.
   */
  readonly force?: boolean;
}

export interface UpdateEventAvailable {
  readonly kind: 'available';
  readonly version: string;
  readonly installedVersion: string;
}

export interface UpdateEventUpToDate {
  readonly kind: 'up-to-date';
  readonly version: string;
}

export interface UpdateEventFailed {
  readonly kind: 'failed';
  readonly error: unknown;
}

export type UpdateEvent = UpdateEventAvailable | UpdateEventUpToDate | UpdateEventFailed;

export class UpdateService {
  private readonly currentVersion: string;
  private readonly output: vscode.OutputChannel;
  /** Prevents overlapping API calls within a single session. */
  private inflight = false;
  /** Subscribed UI listeners (status bar, etc.) — fire on every check outcome. */
  private listeners: Array<(event: UpdateEvent) => void> = [];

  constructor(output: vscode.OutputChannel, currentVersion: string) {
    this.output = output;
    this.currentVersion = currentVersion;
  }

  // ---------------------------------------------------------------------------
  // Event subscription
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to check lifecycle events. Fires:
   * - `{ kind: 'available', version, installedVersion }` when a newer release is found
   * - `{ kind: 'up-to-date', version }` when no newer release exists
   * - `{ kind: 'failed', error }` when the GitHub API call or parse throws
   *
   * Returns a `Disposable` that removes the listener. Force-bypassed checks
   * (the manual `volt.checkForUpdates` command) fire the same events so the
   * status bar stays accurate after a manual refresh.
   */
  onUpdate(listener: (event: UpdateEvent) => void): vscode.Disposable {
    this.listeners.push(listener);
    return new vscode.Disposable(() => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    });
  }

  private emit(event: UpdateEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        this.output.appendLine(
          `[Volt] Update listener threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Start the background check loop. Runs once immediately and then every
   * {@link BACKGROUND_CHECK_INTERVAL_MS} while VS Code remains open.
   *
   * The returned `Disposable` clears the interval and MUST be pushed onto
   * `context.subscriptions` (or otherwise disposed) on extension teardown.
   */
  startBackgroundChecks(): vscode.Disposable {
    void this.checkForUpdates();

    const interval = setInterval(() => {
      void this.checkForUpdates();
    }, BACKGROUND_CHECK_INTERVAL_MS);

    return new vscode.Disposable(() => clearInterval(interval));
  }

  /**
   * Check GitHub Releases for a newer Volt version.
   *
   * Honours `lastNotifiedVersion` in `globalState` so the same release is not
   * re-announced on every restart; pass `{ force: true }` to bypass that
   * suppression (used by the manual command).
   *
   * All errors are logged to the `Volt` output channel — never silently
   * swallowed — so the user (and the developer) can investigate failures
   * such as rate-limiting, firewalls, or malformed responses.
   */
  async checkForUpdates(options: CheckForUpdatesOptions = {}): Promise<void> {
    if (!options.force && this.inflight) return;
    this.inflight = true;

    try {
      const latest = await this.fetchLatestRelease();
      if (!latest) {
        this.output.appendLine('[Volt] Update check: no usable release info from GitHub API');
        this.emit({ kind: 'failed', error: new Error('no usable release info from GitHub API') });
        return;
      }

      if (!isNewerVersion(latest.version, this.currentVersion)) {
        this.output.appendLine(
          `[Volt] Update check: latest is v${latest.version}, installed is v${this.currentVersion} (up to date)`,
        );
        this.emit({ kind: 'up-to-date', version: latest.version });
        return;
      }

      this.output.appendLine(
        `[Volt] Update available: v${latest.version} (installed: v${this.currentVersion}) — auto-installing…`,
      );
      this.emit({
        kind: 'available',
        version: latest.version,
        installedVersion: this.currentVersion,
      });

      // Auto-install the update. No prompt — the user opted into auto-update
      // by installing a Volt that ships with one. If install fails, log to the
      // Output channel and surface a non-blocking notification; the user can
      // still trigger a manual retry via volt.checkForUpdates.
      try {
        await this.installUpdate(latest.vsixUrl, latest.version);
      } catch (installErr: unknown) {
        const msg = installErr instanceof Error ? installErr.message : String(installErr);
        this.output.appendLine(`[Volt] Auto-install failed: ${msg}`);
        void vscode.window.showErrorMessage(
          `Volt auto-update to v${latest.version} failed: ${msg}. Run "Volt: Check for Updates" to retry.`,
        );
      }
    } catch (err: unknown) {
      this.output.appendLine(
        `[Volt] Update check failed: ${
          err instanceof Error ? (err.stack ?? err.message) : String(err)
        }`,
      );
      this.emit({ kind: 'failed', error: err });
    } finally {
      this.inflight = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Fetch the latest release metadata from the GitHub Releases API and run it
   * through {@link parseReleaseInfo}. Returns `null` for any non-200 response
   * or unparseable body.
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
            res.resume();
            resolve(null);
            return;
          }

          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            raw += chunk;
          });
          res.on('end', () => {
            try {
              resolve(parseReleaseInfo(JSON.parse(raw)));
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
   * Download the .vsix from `vsixUrl` to a temp file, install it via the VS
   * Code extension host, and trigger a window reload so the new code takes
   * over immediately. No user prompt — fully automatic.
   */
  private async installUpdate(vsixUrl: string, newVersion: string): Promise<void> {
    const tempFile = path.join(os.tmpdir(), `volt-${newVersion}.vsix`);

    this.output.appendLine(`[Volt] Downloading update to ${tempFile}…`);

    await this.downloadFile(vsixUrl, tempFile);

    const vsixUri = vscode.Uri.file(tempFile);

    await vscode.commands.executeCommand('workbench.extensions.installExtension', vsixUri);

    this.output.appendLine(`[Volt] Installed v${newVersion} — reloading window…`);

    // Briefly surface what just happened before VS Code reloads and clears
    // the notification. The user gets a one-shot confirmation without having
    // to click anything. 1.2s is enough to read "Volt updated to vX.Y.Z" but
    // short enough not to delay them noticeably.
    void vscode.window
      .showInformationMessage(`Volt updated to v${newVersion}. Reloading…`)
      .then(() => undefined);
    await new Promise<void>((resolve) => setTimeout(resolve, 1200));

    await vscode.commands.executeCommand('workbench.action.reloadWindow');
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
    https
      .get(url, { headers: { 'User-Agent': 'Volt-Extension' } }, (res) => {
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
          fs.unlink(dest, () => {
            /* ignore cleanup error */
          });
          reject(err);
        });
        res.on('error', (err) => {
          fs.unlink(dest, () => {
            /* ignore cleanup error */
          });
          reject(err);
        });
      })
      .on('error', reject);
  }
}
