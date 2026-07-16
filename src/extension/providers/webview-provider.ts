/**
 * @fileoverview Volt Webview Panel provider.
 *
 * Manages the lifecycle of the single Volt webview panel:
 * - Singleton: at most one panel open at a time (focuses existing if present)
 * - CSP: strict nonce-based policy — no inline scripts or untrusted styles
 * - Serializer: registers a `WebviewPanelSerializer` so VS Code can restore the
 *   panel across restarts without losing state
 * - HTML generation: injects the Vite-built webview bundle via a nonce'd script
 *
 * @see REQ-EXT-003 — Webview Panel Lifecycle
 * @see REQ-EXT-005 — Content Security Policy
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import type { MessageRouter } from '../message-router';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PANEL_VIEW_TYPE = 'volt.requestPanel';
const PANEL_TITLE = 'Volt';

/** Title prefix used to indicate the panel has unsaved changes (VS Code convention). */
const DIRTY_TITLE_PREFIX = '\u25CF ';

// ---------------------------------------------------------------------------
// WebviewProvider
// ---------------------------------------------------------------------------

/**
 * Owns the singleton Volt webview panel.
 *
 * Usage:
 * ```ts
 * const provider = new WebviewProvider(context, router);
 * context.subscriptions.push(provider);
 * vscode.window.registerWebviewPanelSerializer(PANEL_VIEW_TYPE, provider);
 * ```
 */
export class WebviewProvider implements vscode.Disposable, vscode.WebviewPanelSerializer {
  private panel: vscode.WebviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly extensionUri: vscode.Uri;
  private readonly router: MessageRouter;

  /**
   * Last reported dirty state from the webview. Captured so the `onDidDispose`
   * handler can show a warning when the user closes the panel with unsaved
   * changes (VS Code's WebviewPanel does not let us cancel the close).
   */
  private isDirty = false;

  constructor(context: vscode.ExtensionContext, router: MessageRouter) {
    this.extensionUri = context.extensionUri;
    this.router = router;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Update the panel's dirty marker. Called by `MessageRouter` whenever the
   * webview reports a `webview:set-dirty` message. No-op if no panel is open
   * or the state is unchanged.
   */
  setDirty(dirty: boolean): void {
    if (this.isDirty === dirty) return;
    this.isDirty = dirty;
    if (this.panel) {
      this.applyPanelTitle();
    }
  }

  /**
   * Opens the Volt panel. If a panel already exists, it is revealed instead of
   * creating a duplicate (satisfies REQ-EXT-003 singleton rule).
   */
  openPanel(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      PANEL_VIEW_TYPE,
      PANEL_TITLE,
      vscode.ViewColumn.Active,
      this.webviewOptions(),
    );

    // Set panel icon (bolt/lightning)
    const iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'bolt.svg');
    this.panel.iconPath = iconPath;

    this.initPanel(this.panel);
  }

  // ---------------------------------------------------------------------------
  // WebviewPanelSerializer (panel restoration after VS Code restart)
  // ---------------------------------------------------------------------------

  /**
   * Called by VS Code when restoring a persisted panel across restarts.
   * @see REQ-EXT-003 — Panel restoration scenario
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async deserializeWebviewPanel(
    webviewPanel: vscode.WebviewPanel,
    _state: unknown,
  ): Promise<void> {
    // If another panel was somehow already in memory, dispose it.
    this.panel?.dispose();
    this.panel = webviewPanel;
    this.initPanel(webviewPanel);
  }

  // ---------------------------------------------------------------------------
  // Disposable
  // ---------------------------------------------------------------------------

  dispose(): void {
    this.panel?.dispose();
    this.disposables.forEach((d) => {
      d.dispose();
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Common options for all panel instances. */
  private webviewOptions(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return {
      enableScripts: true,
      // Restrict resource loading to the extension's dist directory
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')],
      retainContextWhenHidden: true,
    };
  }

  /**
   * Wire up event listeners and initial HTML for a freshly created or restored
   * panel.
   */
  private initPanel(panel: vscode.WebviewPanel): void {
    panel.webview.html = this.getHtmlForWebview(panel.webview);

    // Route messages from webview → host
    panel.webview.onDidReceiveMessage(
      (raw: unknown) => {
        this.router.receive(raw, panel.webview);
      },
      undefined,
      this.disposables,
    );

    // Allow the router to send messages back to the webview
    this.router.setWebview(panel.webview);

    // Clean up on panel close
    panel.onDidDispose(
      () => {
        // Best-effort warning: VS Code does not let the extension host cancel
        // a WebviewPanel close, so the changes are already lost by this point.
        if (this.isDirty) {
          void vscode.window.showWarningMessage(
            'Volt: panel closed with unsaved changes — they have been discarded.',
            'OK',
          );
        }
        this.isDirty = false;
        this.panel = undefined;
        this.router.setWebview(undefined);
      },
      undefined,
      this.disposables,
    );
  }

  /** Sync the panel title with the current dirty state. */
  private applyPanelTitle(): void {
    if (!this.panel) return;
    this.panel.title = this.isDirty ? `${DIRTY_TITLE_PREFIX}${PANEL_TITLE}` : PANEL_TITLE;
  }

  /**
   * Build the HTML document served inside the webview.
   *
   * Security model (REQ-EXT-005):
   * - `default-src 'none'` — deny everything by default
   * - `style-src ${webview.cspSource}` — allow styles from extension dist
   * - `script-src 'nonce-${nonce}'` — only the nonce'd bundle script runs
   * - No inline scripts or styles beyond the nonce'd entry point
   */
  private getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = generateNonce();

    // VS Code webview URIs for the built assets
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'webview.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'webview.css'),
    );

    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data: https:`,
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Volt</title>
  <link rel="stylesheet" href="${styleUri.toString()}" />
</head>
<body>
  <div id="root">
    <p style="color: var(--vscode-foreground, #ccc); padding: 16px; font-family: var(--vscode-font-family, sans-serif);">
      Volt is loading&hellip;
    </p>
  </div>
  <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically-random 128-bit nonce for the CSP.
 * A new nonce is created per panel render, so no two panels share one.
 */
function generateNonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

// Re-export view type constant for registration in activate.ts
export { PANEL_VIEW_TYPE };
