/**
 * @fileoverview Volt Collection Runner Service.
 *
 * Executes all requests in a named folder sequentially, emitting per-request
 * progress events and a final summary event via a callback.
 *
 * Design decisions:
 * - Requests are executed in alphabetical (filesystem) order.
 * - Runner does NOT stop on failure — all requests always run.
 * - Optional delay (ms) between requests is respected.
 * - Assertions are evaluated from the request's `postScript` field when present
 *   (pm.test() calls tracked via ScriptRunner). For now, assertion counts are
 *   derived from the post-script execution result.
 * - Environment variables are resolved before each request.
 * - Cookie jar integration: cookies are applied before each request and
 *   captured after each response.
 */

import * as vscode from 'vscode';
import type { IHttpService, ICollectionService, IEnvironmentService } from '../message-router';
import type { RunnerProgressMessage, RunnerCompleteMessage } from '../../shared/protocol';
import type { CookieService } from './cookie-service';

// ---------------------------------------------------------------------------
// Callback types
// ---------------------------------------------------------------------------

export type RunnerProgressCallback = (
  payload: RunnerProgressMessage['payload'],
) => void;

export type RunnerCompleteCallback = (
  payload: RunnerCompleteMessage['payload'],
) => void;

// ---------------------------------------------------------------------------
// CollectionRunner
// ---------------------------------------------------------------------------

export class CollectionRunner {
  private readonly output: vscode.OutputChannel;
  private readonly http: IHttpService;
  private readonly collection: ICollectionService;
  private readonly environment: IEnvironmentService | undefined;
  private readonly cookieService: CookieService | undefined;

  constructor(
    output: vscode.OutputChannel,
    http: IHttpService,
    collection: ICollectionService,
    environment?: IEnvironmentService,
    cookieService?: CookieService,
  ) {
    this.output = output;
    this.http = http;
    this.collection = collection;
    this.environment = environment;
    this.cookieService = cookieService;
  }

  /**
   * Run all requests inside `folderName` (top-level folder only) in
   * alphabetical order.
   *
   * @param folderName - The folder name as shown in the collection tree.
   * @param delay - Milliseconds to wait between requests (default: 0).
   * @param onProgress - Fired after each request with per-request results.
   * @param onComplete - Fired once all requests have run with summary totals.
   */
  async runFolder(
    folderName: string,
    delay: number,
    onProgress: RunnerProgressCallback,
    onComplete: RunnerCompleteCallback,
  ): Promise<void> {
    this.output.appendLine(`[CollectionRunner] Starting run for folder: "${folderName}"`);

    // Load the collection tree to find all requests in the folder
    const tree = await this.collection.loadTree();
    const folderNode = tree.nodes.find(
      (n) => n.kind === 'folder' && n.name === folderName,
    );

    if (!folderNode || folderNode.kind !== 'folder') {
      this.output.appendLine(`[CollectionRunner] Folder not found: "${folderName}"`);
      onComplete({ total: 0, passed: 0, failed: 0, totalTime: 0 });
      return;
    }

    // Collect request paths sorted alphabetically (filesystem order)
    const requestPaths = collectRequestPaths(folderNode.children);

    const total = requestPaths.length;
    let passed = 0;
    let failed = 0;
    const runStart = Date.now();

    for (let i = 0; i < requestPaths.length; i++) {
      const reqPath = requestPaths[i];
      if (!reqPath) continue;

      const requestDef = await this.collection.getRequest(reqPath);
      if (!requestDef) {
        this.output.appendLine(`[CollectionRunner] Request not found: "${reqPath}" — skipping`);
        continue;
      }

      // Resolve environment variables
      const resolved = this.environment?.resolveRequest?.(requestDef) ?? requestDef;

      // Inject cookies if cookie service is available
      const cookieHeader = this.cookieService?.getCookies(resolved.url) ?? '';
      const requestWithCookies =
        cookieHeader
          ? {
              ...resolved,
              headers: { ...resolved.headers, Cookie: cookieHeader },
            }
          : resolved;

      const requestName =
        requestDef.name ?? reqPath.split('/').pop() ?? reqPath;
      const correlationId = `runner-${folderName}-${i}-${Date.now()}`;

      let status = 0;
      let time = 0;
      let pass = false;
      let assertionsPassed = 0;
      let assertionsTotal = 0;

      const reqStart = Date.now();
      try {
        const response = await this.http.execute(requestWithCookies, correlationId);

        // Capture cookies from response
        if (this.cookieService) {
          this.cookieService.captureCookies(resolved.url, response.headers);
        }

        status = response.status;
        time = Date.now() - reqStart;
        pass = status >= 200 && status < 400;

        // Run post-script assertions if present
        if (requestDef.postScript) {
          try {
            const { ScriptRunner } = await import('./script-runner');
            const envVars =
              (await this.environment?.getResolved())?.variables ?? {};
            const runner = new ScriptRunner(this.output, envVars);
            const result = await runner.runPostScript(requestDef.postScript, response);

            assertionsPassed = result.assertionsPassed;
            assertionsTotal = result.assertionsTotal;

            // If assertions ran, use assertion pass/fail as the "pass" flag
            if (assertionsTotal > 0) {
              pass = assertionsPassed === assertionsTotal;
            }
          } catch (scriptErr: unknown) {
            this.output.appendLine(
              `[CollectionRunner] Post-script error for "${reqPath}": ${String(scriptErr)}`,
            );
          }
        }
      } catch (err: unknown) {
        status = 0;
        time = Date.now() - reqStart;
        pass = false;
        this.output.appendLine(
          `[CollectionRunner] Request "${reqPath}" failed: ${String(err)}`,
        );
      }

      if (pass) {
        passed++;
      } else {
        failed++;
      }

      onProgress({
        index: i,
        total,
        requestName,
        status,
        time,
        pass,
        assertionsPassed,
        assertionsTotal,
      });

      this.output.appendLine(
        `[CollectionRunner] [${i + 1}/${total}] "${requestName}" — status: ${status}, time: ${time}ms, pass: ${pass}`,
      );

      // Apply delay before the next request (not after the last one)
      if (delay > 0 && i < requestPaths.length - 1) {
        await sleep(delay);
      }
    }

    const totalTime = Date.now() - runStart;
    onComplete({ total, passed, failed, totalTime });
    this.output.appendLine(
      `[CollectionRunner] Run complete — ${passed}/${total} passed, ${totalTime}ms total`,
    );
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Collect all request paths from a folder's children, sorted alphabetically.
 * Only processes the top-level children (non-recursive for Sprint 3).
 */
function collectRequestPaths(
  nodes: readonly import('../../shared/models').CollectionTreeNode[],
): string[] {
  return nodes
    .filter((n): n is import('../../shared/models').CollectionRequestItem => n.kind === 'request')
    .map((n) => n.path)
    .sort();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
