/**
 * @fileoverview Volt ScriptRunner — executes pre/post request scripts.
 *
 * Scripts run in the extension host using the AsyncFunction constructor.
 * They have access to a sandboxed API and fully support async/await (H-09).
 *
 * Pre-script globals:
 *   - request: { method, url, headers, body }
 *   - env: { get(name), set(name, value) }
 *   - console: { log(...args) }
 *
 * Post-script globals:
 *   - response: { status, statusText, body, headers, time }
 *   - env: { get(name), set(name, value) }
 *   - console: { log(...args) }
 *   - json: parsed response body (if JSON), or null
 *
 * env.set() calls are collected and persisted to the active environment file.
 */

import type * as vscode from 'vscode';
import type { HttpRequestDef, HttpResponseDef } from '../../shared/models';

// ---------------------------------------------------------------------------
// Script context types
// ---------------------------------------------------------------------------

export interface ScriptEnvApi {
  get: (name: string) => string | undefined;
  set: (name: string, value: string) => void;
}

export interface ScriptConsole {
  log: (...args: unknown[]) => void;
}

export interface PreScriptContext {
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string | null;
  };
  env: ScriptEnvApi;
  console: ScriptConsole;
}

export interface PostScriptContext {
  response: {
    status: number;
    statusText: string;
    body: string;
    headers: Record<string, string>;
    time: number;
  };
  json: unknown;
  env: ScriptEnvApi;
  console: ScriptConsole;
}

// ---------------------------------------------------------------------------
// Script result
// ---------------------------------------------------------------------------

export interface ScriptResult {
  success: boolean;
  /** Variables set via env.set() during script execution */
  envUpdates: Record<string, string>;
  /** Console output captured during execution */
  logs: string[];
  /** Error message if script failed */
  error?: string;
  /** Number of pm.test() assertions that passed */
  assertionsPassed: number;
  /** Total number of pm.test() assertions executed */
  assertionsTotal: number;
}

// ---------------------------------------------------------------------------
// ScriptRunner
// ---------------------------------------------------------------------------

export class ScriptRunner {
  private readonly output: vscode.OutputChannel;
  private readonly envVars: Record<string, string>;

  constructor(output: vscode.OutputChannel, currentEnvVars: Record<string, string>) {
    this.output = output;
    this.envVars = { ...currentEnvVars };
  }

  /**
   * Execute a pre-request script.
   */
  async runPreScript(script: string, request: HttpRequestDef): Promise<ScriptResult> {
    if (!script.trim()) return { success: true, envUpdates: {}, logs: [], assertionsPassed: 0, assertionsTotal: 0 };

    const envUpdates: Record<string, string> = {};
    const logs: string[] = [];

    const env: ScriptEnvApi = {
      get: (name: string) => this.envVars[name],
      set: (name: string, value: string) => {
        envUpdates[name] = String(value);
        this.envVars[name] = String(value);
      },
    };

    const console: ScriptConsole = {
      log: (...args: unknown[]) => {
        const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
        logs.push(line);
        this.output.appendLine(`[Script:pre] ${line}`);
      },
    };

    const context: PreScriptContext = {
      request: {
        method: request.method,
        url: request.url,
        headers: { ...request.headers },
        body: request.body?.type !== 'none' && request.body?.type !== 'binary'
          ? request.body?.type === 'graphql'
            ? JSON.stringify({ query: request.body.query, variables: request.body.variables, operationName: request.body.operationName })
            : (request.body?.content ?? null)
          : null,
      },
      env,
      console,
    };

    return this.execute(script, context as unknown as Record<string, unknown>, logs, envUpdates);
  }

  /**
   * Execute a post-request script.
   */
  async runPostScript(script: string, response: HttpResponseDef): Promise<ScriptResult> {
    if (!script.trim()) return { success: true, envUpdates: {}, logs: [], assertionsPassed: 0, assertionsTotal: 0 };

    const envUpdates: Record<string, string> = {};
    const logs: string[] = [];

    const env: ScriptEnvApi = {
      get: (name: string) => this.envVars[name],
      set: (name: string, value: string) => {
        envUpdates[name] = String(value);
        this.envVars[name] = String(value);
      },
    };

    const console: ScriptConsole = {
      log: (...args: unknown[]) => {
        const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
        logs.push(line);
        this.output.appendLine(`[Script:post] ${line}`);
      },
    };

    // Try to parse JSON body
    let json: unknown = null;
    try {
      if (response.body) {
        json = JSON.parse(response.body);
      }
    } catch {
      // Not JSON — that's fine
    }

    const context: PostScriptContext = {
      response: {
        status: response.status,
        statusText: response.statusText,
        body: response.body ?? '',
        headers: response.headers,
        time: response.timing.total,
      },
      json,
      env,
      console,
    };

    return this.execute(script, context as unknown as Record<string, unknown>, logs, envUpdates);
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async execute(
    script: string,
    context: Record<string, unknown>,
    logs: string[],
    envUpdates: Record<string, string>,
  ): Promise<ScriptResult> {
    let assertionsPassed = 0;
    let assertionsTotal = 0;

    // pm.test() shim — Postman-compatible assertion tracker
    const pm = {
      test: (name: string, fn: () => void): void => {
        assertionsTotal++;
        try {
          fn();
          assertionsPassed++;
          logs.push(`✓ ${name}`);
          this.output.appendLine(`[Script:assertion] PASS: ${name}`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          logs.push(`✗ ${name}: ${msg}`);
          this.output.appendLine(`[Script:assertion] FAIL: ${name} — ${msg}`);
        }
      },
      expect: (value: unknown) => ({
        to: {
          equal: (expected: unknown) => {
            if (value !== expected) {
              throw new Error(`Expected ${JSON.stringify(value)} to equal ${JSON.stringify(expected)}`);
            }
          },
          be: {
            ok: () => {
              if (!value) throw new Error(`Expected ${JSON.stringify(value)} to be truthy`);
            },
          },
          include: (substr: string) => {
            if (typeof value !== 'string' || !value.includes(substr)) {
              throw new Error(`Expected "${String(value)}" to include "${substr}"`);
            }
          },
        },
        not: {
          to: {
            equal: (expected: unknown) => {
              if (value === expected) {
                throw new Error(`Expected value to not equal ${JSON.stringify(expected)}`);
              }
            },
          },
        },
      }),
    };

    try {
      // Build async function with context variables as parameters (H-09)
      // AsyncFunction supports await inside user scripts.
      const AsyncFunction = (Object.getPrototypeOf(async function () {
        // empty
      }) as { constructor: new (...args: string[]) => (...values: unknown[]) => Promise<unknown> })
        .constructor;

      const contextWithPm = { ...context, pm };
      const paramNames = Object.keys(contextWithPm);
      const paramValues = Object.values(contextWithPm);

      const wrappedScript = `"use strict";\n${script}`;

      const fn = new AsyncFunction(...paramNames, wrappedScript);
      await fn(...paramValues);

      return { success: true, envUpdates, logs, assertionsPassed, assertionsTotal };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[ScriptRunner] ERROR: ${message}`);
      return { success: false, envUpdates, logs, error: message, assertionsPassed, assertionsTotal };
    }
  }
}
