/**
 * @fileoverview Volt Environment Service.
 *
 * Loads environment files from `.volt/envs/*.yaml`, maintains a scope chain,
 * and interpolates `{{variableName}}` placeholders in request fields.
 *
 * Scope chain (highest → lowest priority):
 *   request variables → collection variables → project variables → global variables
 *
 * Rules (REQ-ENV-001 through REQ-ENV-003):
 * - The FIRST match in the chain wins.
 * - Undefined variables are left as literal `{{var}}` text — never empty string.
 * - Variable names: alphanumeric, underscore, hyphen only. Spaces are ignored.
 * - Interpolation is a single pass (no recursive expansion).
 * - `.secrets.local.yaml` is merged at the highest priority if present.
 * - Secret values are NEVER written to logs or error messages.
 *
 * @see REQ-ENV-001 — Scope Hierarchy
 * @see REQ-ENV-002 — Variable Storage
 * @see REQ-ENV-003 — Interpolation Engine
 */

import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import type { IEnvironmentService } from '../message-router';
import type { EnvironmentDef, ResolvedEnv, HttpRequestDef } from '../../shared/models';
import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Matches `{{variableName}}` — name must be [a-zA-Z0-9_-]+. */
const VAR_PATTERN = /\{\{([a-zA-Z0-9_-]+)\}\}/g;

/** Environment files directory relative to workspace root. */
const ENVS_DIR = '.volt/envs';

/** Secrets file name (never committed). */
const SECRETS_FILE = '.secrets.local.yaml';

// ---------------------------------------------------------------------------
// Interpolation result
// ---------------------------------------------------------------------------

export interface InterpolationResult {
  /** The interpolated string. */
  readonly value: string;
  /** Variable names that were referenced but not found in any scope. */
  readonly unresolved: readonly string[];
}

// ---------------------------------------------------------------------------
// EnvironmentService
// ---------------------------------------------------------------------------

export class EnvironmentService implements IEnvironmentService, vscode.Disposable {
  private readonly output: vscode.OutputChannel;
  private readonly workspaceRoot: string;

  /** All loaded environment definitions, keyed by environment name. */
  private environments: Map<string, EnvironmentDef> = new Map();

  /** Currently active environment name (empty = no env selected). */
  private activeName = '';

  /** FileSystem watcher for env directory changes. */
  private watcher: vscode.FileSystemWatcher | undefined;

  constructor(output: vscode.OutputChannel, workspaceRoot: string) {
    this.output = output;
    this.workspaceRoot = workspaceRoot;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Perform initial load of all env files and start file watcher.
   * Call this once after construction (from `activate.ts`).
   */
  async initialise(): Promise<void> {
    await this.loadAll();
    this.startWatcher();
    // Default: activate the first available environment (alphabetically)
    const names = Array.from(this.environments.keys()).sort();
    if (names.length > 0 && this.activeName === '') {
      this.activeName = names[0]!;
      this.output.appendLine(`[EnvironmentService] Auto-selected environment: ${this.activeName}`);
    }
  }

  // ---------------------------------------------------------------------------
  // IEnvironmentService
  // ---------------------------------------------------------------------------

  async setActive(name: string): Promise<void> {
    if (!this.environments.has(name)) {
      // Try reloading from disk in case the file was just created
      await this.loadAll();
    }

    if (!this.environments.has(name)) {
      throw new Error(`Environment "${name}" not found. Available: ${[...this.environments.keys()].join(', ')}`);
    }

    this.activeName = name;
    this.output.appendLine(`[EnvironmentService] Switched to environment: ${name}`);
  }

  async getResolved(): Promise<ResolvedEnv> {
    return this.buildResolved();
  }

  // ---------------------------------------------------------------------------
  // Interpolation — public API
  // ---------------------------------------------------------------------------

  /**
   * Interpolate `{{var}}` references in a string using the scope chain.
   *
   * @param template - String that may contain `{{var}}` placeholders.
   * @param requestVars - Request-level variables (highest priority scope).
   * @param collectionVars - Collection-level variables.
   */
  interpolate(
    template: string,
    requestVars: Record<string, string> = {},
    collectionVars: Record<string, string> = {},
  ): InterpolationResult {
    const projectVars = this.getProjectVars();
    const secretVars = this.getSecretVars();

    // Build merged scope chain (high → low): secrets > request > collection > project
    const chain: Record<string, string>[] = [secretVars, requestVars, collectionVars, projectVars];

    const unresolved: string[] = [];

    const value = template.replace(VAR_PATTERN, (_match, varName: string) => {
      for (const scope of chain) {
        if (Object.prototype.hasOwnProperty.call(scope, varName)) {
          return scope[varName]!;
        }
      }
      // Not found — warn and keep literal
      if (!unresolved.includes(varName)) {
        unresolved.push(varName);
      }
      return _match; // keep {{var}} verbatim
    });

    if (unresolved.length > 0) {
      this.output.appendLine(
        `[EnvironmentService] WARNING: unresolved variables — ${unresolved.join(', ')}`,
      );
    }

    return { value, unresolved };
  }

  /**
   * Apply variable interpolation to all interpolatable fields of an
   * `HttpRequestDef`, returning a new (mutated-copy) definition ready for
   * execution.
   *
   * @param request - Raw request with `{{var}}` templates.
   * @param requestVars - Per-request variable overrides.
   * @param collectionVars - Per-collection variable overrides.
   */
  resolveRequest(
    request: HttpRequestDef,
    requestVars: Record<string, string> = {},
    collectionVars: Record<string, string> = {},
  ): HttpRequestDef {
    const interp = (s: string) => this.interpolate(s, requestVars, collectionVars).value;

    // Interpolate URL
    const url = interp(request.url);

    // Interpolate header keys and values
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(request.headers)) {
      headers[interp(k)] = interp(v);
    }

    // Interpolate query param values
    const queryParams = request.queryParams.map((p) => ({
      ...p,
      key: interp(p.key),
      value: interp(p.value),
    }));

    // Interpolate body content
    let body = request.body;
    if (body && body.type !== 'none') {
      body = { ...body, content: interp(body.content) };
    }

    return {
      ...request,
      url,
      headers,
      queryParams,
      ...(body !== undefined ? { body } : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------

  private async loadAll(): Promise<void> {
    this.environments.clear();

    const envsDir = path.join(this.workspaceRoot, ENVS_DIR);

    if (!fs.existsSync(envsDir)) {
      this.output.appendLine(`[EnvironmentService] No envs directory found at: ${envsDir}`);
      return;
    }

    let files: string[];
    try {
      files = fs.readdirSync(envsDir);
    } catch (err: unknown) {
      this.output.appendLine(`[EnvironmentService] ERROR reading envs directory: ${String(err)}`);
      return;
    }

    for (const file of files) {
      // Skip secrets file — loaded separately
      if (file === SECRETS_FILE) continue;
      if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;

      const filePath = path.join(envsDir, file);
      await this.loadEnvFile(filePath);
    }

    this.output.appendLine(
      `[EnvironmentService] Loaded ${this.environments.size} environment(s): ${[...this.environments.keys()].join(', ')}`,
    );
  }

  private async loadEnvFile(filePath: string): Promise<void> {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = yaml.load(raw) as Record<string, unknown>;

      if (typeof parsed !== 'object' || parsed === null) {
        this.output.appendLine(`[EnvironmentService] WARNING: invalid env file (not an object): ${filePath}`);
        return;
      }

      // Support both flat key-value format AND {name, variables} format
      let name: string;
      let variables: Record<string, string>;

      if (typeof parsed['name'] === 'string' && typeof parsed['variables'] === 'object') {
        // {name, variables} format
        name = parsed['name'];
        variables = flattenVariables(parsed['variables'] as Record<string, unknown>);
      } else {
        // Flat key-value format: the env name is derived from the filename
        name = path.basename(filePath, path.extname(filePath));
        variables = flattenVariables(parsed);
      }

      const envDef: EnvironmentDef = { name, variables };
      this.environments.set(name, envDef);
    } catch (err: unknown) {
      this.output.appendLine(`[EnvironmentService] ERROR loading env file ${filePath}: ${String(err)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Secrets handling
  // ---------------------------------------------------------------------------

  /**
   * Load secrets from `.volt/envs/.secrets.local.yaml`.
   * Returns an empty object if the file does not exist.
   * Validates that the file is gitignored (warns if not).
   *
   * IMPORTANT: Secret values are NEVER logged.
   */
  private getSecretVars(): Record<string, string> {
    const secretsPath = path.join(this.workspaceRoot, ENVS_DIR, SECRETS_FILE);

    if (!fs.existsSync(secretsPath)) {
      return {};
    }

    this.validateSecretsGitignored(secretsPath);

    try {
      const raw = fs.readFileSync(secretsPath, 'utf8');
      const parsed = yaml.load(raw);

      if (typeof parsed !== 'object' || parsed === null) {
        this.output.appendLine('[EnvironmentService] WARNING: .secrets.local.yaml is not a valid key-value map');
        return {};
      }

      return flattenVariables(parsed as Record<string, unknown>);
    } catch (err: unknown) {
      // Never log the error message as it might contain secret path info
      this.output.appendLine('[EnvironmentService] ERROR loading .secrets.local.yaml');
      return {};
    }
  }

  private validateSecretsGitignored(secretsPath: string): void {
    const gitignorePath = path.join(this.workspaceRoot, '.gitignore');

    if (!fs.existsSync(gitignorePath)) {
      this.output.appendLine(
        '[EnvironmentService] WARNING: .secrets.local.yaml exists but no .gitignore found. Add it to .gitignore to prevent accidental commits.',
      );
      return;
    }

    try {
      const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
      const isIgnored =
        gitignoreContent.includes('.secrets.local.yaml') ||
        gitignoreContent.includes('.secrets.local.*') ||
        gitignoreContent.includes('*.local.yaml');

      if (!isIgnored) {
        this.output.appendLine(
          '[EnvironmentService] ⚠️  WARNING: .secrets.local.yaml is NOT in .gitignore. Add "*.local.yaml" or ".secrets.local.yaml" to .gitignore immediately.',
        );
      }
    } catch {
      // Non-critical — just warn
      this.output.appendLine('[EnvironmentService] WARNING: could not read .gitignore to validate secrets exclusion');
    }
  }

  // ---------------------------------------------------------------------------
  // Scope helpers
  // ---------------------------------------------------------------------------

  private getProjectVars(): Record<string, string> {
    if (!this.activeName) return {};
    const env = this.environments.get(this.activeName);
    return env?.variables ?? {};
  }

  private buildResolved(): ResolvedEnv {
    const projectVars = this.getProjectVars();
    const secretVars = this.getSecretVars();

    // Merge: secrets override project vars
    const merged = { ...projectVars, ...secretVars };

    return {
      active: this.activeName,
      available: Array.from(this.environments.keys()).sort(),
      variables: merged,
    };
  }

  // ---------------------------------------------------------------------------
  // File watching
  // ---------------------------------------------------------------------------

  private startWatcher(): void {
    if (this.watcher) {
      this.watcher.dispose();
    }

    const pattern = new vscode.RelativePattern(
      this.workspaceRoot,
      '.volt/envs/**/*.{yaml,yml}',
    );

    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const reload = async () => {
      this.output.appendLine('[EnvironmentService] Env file change detected — reloading');
      await this.loadAll();
    };

    this.watcher.onDidChange(() => void reload());
    this.watcher.onDidCreate(() => void reload());
    this.watcher.onDidDelete(() => void reload());

    this.output.appendLine('[EnvironmentService] File watcher started for .volt/envs/');
  }

  // ---------------------------------------------------------------------------
  // Disposable
  // ---------------------------------------------------------------------------

  dispose(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
    this.environments.clear();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Flatten an arbitrary YAML object to `Record<string, string>`.
 * All values are coerced to strings; nested objects are skipped with a warning.
 */
function flattenVariables(obj: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === 'string') {
      result[key] = val;
    } else if (typeof val === 'number' || typeof val === 'boolean') {
      result[key] = String(val);
    }
    // Objects and arrays are silently skipped — not valid variable values
  }
  return result;
}
