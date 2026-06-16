/**
 * @fileoverview Volt Collection Service.
 *
 * Provides CRUD operations on request YAML files under `.volt/requests/`,
 * reads and writes `.volt/collection.yaml` for ordering metadata, and
 * maintains a `FileSystemWatcher` that fires change events (debounced) when
 * files are modified externally (git pull, manual edits, etc.).
 *
 * Design decisions:
 * - All writes use write-to-temp-then-rename to be as atomic as possible on
 *   local file systems (no partial-write state visible to readers).
 * - YAML serialisation uses `js-yaml`; ajv validation runs on every read/write.
 * - Folder paths are always normalised to posix-style relative paths so
 *   cross-platform consistency is guaranteed.
 * - Debounce timer is 100 ms (REQ-COL-006).
 *
 * @see REQ-COL-001 — Tree View Display
 * @see REQ-COL-002 — CRUD Operations
 * @see REQ-COL-003 — YAML Schema
 * @see REQ-COL-005 — Folder Organisation
 * @see REQ-COL-006 — File Watcher Scope
 */

import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import * as vscode from 'vscode';
import { validateRequestDef } from '../../shared/schemas';
import type {
  HttpRequestDef,
  HttpMethod,
  CollectionTree,
  CollectionTreeNode,
  CollectionFolderItem,
  CollectionRequestItem,
  CollectionOrderEntry,
  AuthConfig,
} from '../../shared/models';
import type { ICollectionService } from '../message-router';

// ---------------------------------------------------------------------------
// Internal YAML shape
// ---------------------------------------------------------------------------

/**
 * Loose type for the raw parsed collection.yaml — we coerce it to safe types.
 */
interface RawCollectionYaml {
  name?: unknown;
  version?: unknown;
  order?: unknown[];
}

/**
 * Loose type for a raw request YAML file (before validation + coercion).
 */
interface RawRequestYaml {
  id?: unknown;
  name?: unknown;
  method?: unknown;
  url?: unknown;
  headers?: unknown;
  body?: unknown;
  queryParams?: unknown;
  variables?: unknown;
  description?: unknown;
  preScript?: unknown;
  postScript?: unknown;
  settings?: unknown;
  auth?: unknown;
  timeout?: unknown;
  assertions?: unknown;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Root directory for the collection manifest. */
const COLLECTION_YAML = '.volt/collection.yaml';

/** Root directory for request YAML files. */
const REQUESTS_DIR = '.volt/requests';

/** Sentinel file to keep empty directories tracked in git. */
const KEEP_FILE = '.keep';

/** Default collection manifest content for new collections. */
const DEFAULT_COLLECTION_YAML_CONTENT = `# Volt Collection
name: "My API"
version: 1
order: []
`;

/** Supported HTTP methods for validation. */
const VALID_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

// ---------------------------------------------------------------------------
// CollectionService
// ---------------------------------------------------------------------------

/**
 * Event emitted when the collection changes on disk.
 */
export type CollectionChangeEvent = {
  /** Kind of change that triggered the event. */
  readonly kind: 'request' | 'folder' | 'manifest';
};

export class CollectionService implements ICollectionService, vscode.Disposable {
  private readonly output: vscode.OutputChannel;
  private readonly workspaceRoot: string;

  /** Disposable watcher registrations. */
  private readonly disposables: vscode.Disposable[] = [];

  /** Debounce timer handle for rapid change events. */
  private debounceHandle: ReturnType<typeof setTimeout> | undefined;

  /** EventEmitter for tree / webview refresh. */
  private readonly _onDidChange = new vscode.EventEmitter<CollectionChangeEvent>();

  /**
   * Fires (debounced, 100 ms) whenever a file under `.volt/` changes.
   * Subscribers (TreeProvider, MessageRouter) connect here to refresh.
   */
  readonly onDidChange = this._onDidChange.event;

  constructor(output: vscode.OutputChannel, workspaceRoot: string) {
    this.output = output;
    this.workspaceRoot = workspaceRoot;
    this.disposables.push(this._onDidChange);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start file watchers. Call once after construction from `activate.ts`.
   */
  initialise(): void {
    this.startWatchers();
    this.output.appendLine('[CollectionService] Initialised');
  }

  // ---------------------------------------------------------------------------
  // ICollectionService
  // ---------------------------------------------------------------------------

  /**
   * Scan `.volt/requests/` recursively and build a `CollectionTree`.
   * Ordering from `collection.yaml` is respected; unordered items are appended.
   */
  async loadTree(): Promise<CollectionTree> {
    const requestsDir = path.join(this.workspaceRoot, REQUESTS_DIR);
    const manifestPath = path.join(this.workspaceRoot, COLLECTION_YAML);

    // Read collection manifest (name, version, order)
    let collectionName = '';
    let collectionVersion = 1;
    let orderEntries: CollectionOrderEntry[] = [];

    if (fs.existsSync(manifestPath)) {
      try {
        const raw = yaml.load(fs.readFileSync(manifestPath, 'utf8')) as RawCollectionYaml;
        if (raw && typeof raw === 'object') {
          collectionName = typeof raw.name === 'string' ? raw.name : '';
          collectionVersion = typeof raw.version === 'number' ? raw.version : 1;
          orderEntries = parseOrderEntries(raw.order ?? []);
        }
      } catch (err: unknown) {
        this.output.appendLine(`[CollectionService] WARNING: could not parse collection.yaml — ${String(err)}`);
      }
    }

    // Scan requests directory
    const nodes = fs.existsSync(requestsDir)
      ? this.scanDirectory(requestsDir, requestsDir, orderEntries)
      : [];

    return { name: collectionName, version: collectionVersion, nodes };
  }

  /**
   * Write a request definition to a YAML file at `relativeFilePath`.
   * The path is relative to `.volt/requests/` (e.g., `"auth/login"`).
   * A `.yaml` extension is appended if absent.
   */
  async saveRequest(relativeFilePath: string, request: HttpRequestDef): Promise<string> {
    const normalized = normalizeRelPath(relativeFilePath);
    let absPath = path.join(this.workspaceRoot, REQUESTS_DIR, normalized + '.yaml');

    // Validate before writing
    const result = validateRequestDef(request);
    if (!result.valid) {
      const msg = `Invalid request definition: ${result.errors.join('; ')}`;
      this.output.appendLine(`[CollectionService] ERROR ${msg}`);
      throw new Error(msg);
    }

    // If file already exists with a different method, disambiguate with method suffix
    let finalNormalized = normalized;
    if (fs.existsSync(absPath)) {
      const existingMethod = this.readMethodFromFile(absPath);
      const newMethod = (request.method ?? 'GET').toUpperCase();
      if (existingMethod && existingMethod !== newMethod) {
        finalNormalized = `${normalized}-${newMethod.toLowerCase()}`;
        absPath = path.join(this.workspaceRoot, REQUESTS_DIR, finalNormalized + '.yaml');
      }
    }

    await this.ensureDir(path.dirname(absPath));
    await this.atomicWrite(absPath, buildRequestYaml(request));
    this.output.appendLine(`[CollectionService] Saved request: ${finalNormalized}`);
    return finalNormalized;
  }

  /**
   * Load a single request from disk.
   * @param relativeFilePath - Relative to `.volt/requests/`, without extension.
   */
  async loadRequest(relativeFilePath: string): Promise<HttpRequestDef> {
    const normalized = normalizeRelPath(relativeFilePath);
    const absPath = path.join(this.workspaceRoot, REQUESTS_DIR, normalized + '.yaml');

    if (!fs.existsSync(absPath)) {
      throw new Error(`Request file not found: ${absPath}`);
    }

    return this.parseRequestFile(absPath);
  }

  /**
   * Null-safe variant of `loadRequest` — returns `null` if the file does not
   * exist instead of throwing. Satisfies the `ICollectionService` interface.
   * @param relativeFilePath - Relative to `.volt/requests/`, without extension.
   */
  async getRequest(relativeFilePath: string): Promise<HttpRequestDef | null> {
    try {
      return await this.loadRequest(relativeFilePath);
    } catch {
      return null;
    }
  }

  /**
   * Delete a request YAML file from disk.
   * @param relativeFilePath - Relative to `.volt/requests/`, without extension.
   */
  async deleteRequest(relativeFilePath: string): Promise<void> {
    const normalized = normalizeRelPath(relativeFilePath);
    const absPath = path.join(this.workspaceRoot, REQUESTS_DIR, normalized + '.yaml');

    if (!fs.existsSync(absPath)) {
      throw new Error(`Request file not found: ${absPath}`);
    }

    fs.unlinkSync(absPath);
    // Remove from order manifest
    await this.removeFromOrder(normalized);
    this.output.appendLine(`[CollectionService] Deleted request: ${normalized}`);
  }

  /**
   * Rename a request YAML file from `oldPath` to `newPath`.
   * Both paths are relative to `.volt/requests/`, without extension.
   * Updates the order manifest if the old path was referenced there.
   */
  async renameRequest(oldPath: string, newPath: string): Promise<void> {
    const oldNorm = normalizeRelPath(oldPath);
    let newNorm = normalizeRelPath(newPath);
    const oldAbs = path.join(this.workspaceRoot, REQUESTS_DIR, oldNorm + '.yaml');
    let newAbs = path.join(this.workspaceRoot, REQUESTS_DIR, newNorm + '.yaml');

    if (!fs.existsSync(oldAbs)) {
      throw new Error(`Request file not found: ${oldAbs}`);
    }
    if (fs.existsSync(newAbs) && oldAbs !== newAbs) {
      // Allow same name if methods differ — disambiguate with method suffix
      const existingMethod = this.readMethodFromFile(newAbs);
      const sourceMethod = this.readMethodFromFile(oldAbs);
      if (existingMethod && sourceMethod && existingMethod !== sourceMethod) {
        // Append method suffix to disambiguate on disk
        newNorm = `${newNorm}-${sourceMethod.toLowerCase()}`;
        newAbs = path.join(this.workspaceRoot, REQUESTS_DIR, newNorm + '.yaml');
        if (fs.existsSync(newAbs)) {
          throw new Error(`A request named "${newNorm}" already exists.`);
        }
      } else {
        throw new Error(`A request named "${newNorm}" already exists with the same method.`);
      }
    }

    // Update the `name` field inside the YAML before renaming the file
    try {
      const content = fs.readFileSync(oldAbs, 'utf8');
      const raw = yaml.load(content) as Record<string, unknown> | null;
      if (raw && typeof raw === 'object') {
        const newName = newNorm.split('/').pop() ?? newNorm;
        raw['name'] = newName;
        const updated = yaml.dump(raw, { lineWidth: -1, noRefs: true });
        fs.writeFileSync(oldAbs, updated, 'utf8');
      }
    } catch {
      // Non-fatal — file will still be renamed even if YAML update fails
    }

    await this.ensureDir(path.dirname(newAbs));
    fs.renameSync(oldAbs, newAbs);

    // Update order manifest to reflect the new path
    await this.updateOrderPath(oldNorm, newNorm);
    this.output.appendLine(`[CollectionService] Renamed request: ${oldNorm} → ${newNorm}`);
  }

  /**
   * Create a new folder (directory) under `.volt/requests/`.
   * Idempotent — does nothing if the folder already exists.
   * Adds a `.keep` sentinel to make git track the empty directory.
   *
   * @param relativeFolderPath - e.g., `"auth"` or `"api/v2"`.
   */
  async createFolder(relativeFolderPath: string): Promise<void> {
    const absDir = path.join(this.workspaceRoot, REQUESTS_DIR, relativeFolderPath);
    await this.ensureDir(absDir);
    // Touch .keep so git tracks the empty folder
    const keepPath = path.join(absDir, KEEP_FILE);
    if (!fs.existsSync(keepPath)) {
      fs.writeFileSync(keepPath, '');
    }
    this.output.appendLine(`[CollectionService] Created folder: ${relativeFolderPath}`);
  }

  /**
   * Rename a folder by moving its directory.
   * @param oldPath - Current relative path.
   * @param newPath - New relative path.
   */
  async renameFolder(oldPath: string, newPath: string): Promise<void> {
    const oldAbs = path.join(this.workspaceRoot, REQUESTS_DIR, oldPath);
    const newAbs = path.join(this.workspaceRoot, REQUESTS_DIR, newPath);

    if (!fs.existsSync(oldAbs)) {
      throw new Error(`Folder not found: ${oldPath}`);
    }
    if (fs.existsSync(newAbs)) {
      throw new Error(`Destination folder already exists: ${newPath}`);
    }

    fs.renameSync(oldAbs, newAbs);
    this.output.appendLine(`[CollectionService] Renamed folder: ${oldPath} → ${newPath}`);
  }

  /**
   * Delete a folder and all its contents from disk.
   * @param relativeFolderPath - Relative to `.volt/requests/`.
   */
  async deleteFolder(relativeFolderPath: string): Promise<void> {
    const absDir = path.join(this.workspaceRoot, REQUESTS_DIR, relativeFolderPath);

    if (!fs.existsSync(absDir)) {
      throw new Error(`Folder not found: ${relativeFolderPath}`);
    }

    fs.rmSync(absDir, { recursive: true, force: true });
    this.output.appendLine(`[CollectionService] Deleted folder: ${relativeFolderPath}`);
  }

  /**
   * Update the order array in `collection.yaml`.
   * Call this after drag-and-drop reorders or any structural change.
   */
  async updateOrder(order: CollectionOrderEntry[]): Promise<void> {
    const manifestPath = path.join(this.workspaceRoot, COLLECTION_YAML);

    let current: RawCollectionYaml = { name: '', version: 1, order: [] };
    if (fs.existsSync(manifestPath)) {
      try {
        current = (yaml.load(fs.readFileSync(manifestPath, 'utf8')) as RawCollectionYaml) ?? current;
      } catch {
        // Use defaults if manifest is corrupted
      }
    }

    const updated = {
      name: typeof current.name === 'string' ? current.name : '',
      version: typeof current.version === 'number' ? current.version : 1,
      order,
    };

    await this.ensureDir(path.dirname(manifestPath));
    await this.atomicWrite(manifestPath, yaml.dump(updated, { lineWidth: 120 }));
  }

  // ---------------------------------------------------------------------------
  // Initialization command support
  // ---------------------------------------------------------------------------

  /**
   * Create the standard `.volt/` scaffold in `workspaceRoot`:
   * ```
   * .volt/
   *   collection.yaml
   *   envs/
   *     default.yaml
   *   requests/
   * ```
   * Idempotent — does nothing if the collection already exists.
   * Returns `true` if it was just created, `false` if it already existed.
   */
  async initCollection(): Promise<boolean> {
    const manifestPath = path.join(this.workspaceRoot, COLLECTION_YAML);

    if (fs.existsSync(manifestPath)) {
      return false; // Already initialised
    }

    await this.ensureDir(path.join(this.workspaceRoot, '.volt', 'envs'));
    await this.ensureDir(path.join(this.workspaceRoot, REQUESTS_DIR));

    // Write collection manifest
    await this.atomicWrite(manifestPath, DEFAULT_COLLECTION_YAML_CONTENT);

    // Write default environment
    const defaultEnvPath = path.join(this.workspaceRoot, '.volt', 'envs', 'default.yaml');
    await this.atomicWrite(
      defaultEnvPath,
      `# Default environment\nname: "Default"\nvariables:\n  baseUrl: http://localhost:3000\n`,
    );

    // Add .secrets.local.yaml to .gitignore if not already there
    await this.ensureSecretsIgnored();

    this.output.appendLine('[CollectionService] Initialised new .volt/ collection');
    return true;
  }

  // ---------------------------------------------------------------------------
  // File scanning
  // ---------------------------------------------------------------------------

  /**
   * Recursively scan a directory tree and build an array of `CollectionTreeNode`.
   * Respects the order from `collection.yaml` for top-level entries; within
   * subdirectories, alphabetical order is used.
   */
  private scanDirectory(
    absDir: string,
    requestsRoot: string,
    orderEntries: CollectionOrderEntry[],
  ): CollectionTreeNode[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return [];
    }

    // Separate folders and files
    const subdirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith('.yaml') && e.name !== KEEP_FILE)
      .map((e) => e.name)
      .sort();

    const nodes: CollectionTreeNode[] = [];

    // Build folder nodes
    for (const dir of subdirs) {
      const childAbs = path.join(absDir, dir);
      const children = this.scanDirectory(childAbs, requestsRoot, []);
      const folderNode: CollectionFolderItem = {
        kind: 'folder',
        name: dir,
        children,
      };
      nodes.push(folderNode);
    }

    // Build request nodes
    for (const file of files) {
      const absFile = path.join(absDir, file);
      const relPath = path.relative(requestsRoot, absFile).replace(/\\/g, '/');
      const relNoExt = relPath.replace(/\.yaml$/, '');

      let method: HttpMethod = 'GET';
      let name = path.basename(file, '.yaml');

      try {
        const raw = yaml.load(fs.readFileSync(absFile, 'utf8')) as RawRequestYaml;
        if (raw && typeof raw === 'object') {
          if (typeof raw.name === 'string') name = raw.name;
          if (typeof raw.method === 'string' && isValidMethod(raw.method)) {
            method = raw.method as HttpMethod;
          }
        }
      } catch {
        // Non-fatal — use defaults
      }

      const requestNode: CollectionRequestItem = {
        kind: 'request',
        path: relNoExt,
        name,
        method,
      };
      nodes.push(requestNode);
    }

    return applyOrder(nodes, orderEntries);
  }

  // ---------------------------------------------------------------------------
  // YAML parsing
  // ---------------------------------------------------------------------------

  private parseRequestFile(absPath: string): HttpRequestDef {
    const raw = yaml.load(fs.readFileSync(absPath, 'utf8')) as RawRequestYaml;

    if (!raw || typeof raw !== 'object') {
      throw new Error(`Invalid YAML in ${absPath}: expected an object`);
    }

    // Validate using ajv schema
    const validation = validateRequestDef(raw);
    if (!validation.valid) {
      // Surfaced as a warning — we still try to coerce it
      this.output.appendLine(
        `[CollectionService] VALIDATION WARNING for ${absPath}: ${validation.errors.join('; ')}`,
      );
      vscode.window
        .showWarningMessage(
          `Volt: Request file has schema issues — ${path.basename(absPath)}: ${validation.errors[0] ?? 'unknown error'}`,
        )
        .then(undefined, () => undefined);
    }

    return coerceToRequestDef(raw, absPath);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Read the HTTP method from a request YAML file without fully parsing it.
   * Returns the method string (e.g. 'GET', 'POST') or undefined on failure.
   */
  private readMethodFromFile(absPath: string): string | undefined {
    try {
      const raw = yaml.load(fs.readFileSync(absPath, 'utf8')) as Record<string, unknown> | null;
      if (raw && typeof raw === 'object' && typeof raw['method'] === 'string') {
        return raw['method'].toUpperCase();
      }
    } catch {
      // Non-fatal
    }
    return undefined;
  }

  private async ensureDir(absDir: string): Promise<void> {
    fs.mkdirSync(absDir, { recursive: true });
  }

  /**
   * Atomic write: write to a temp file then rename.
   * On Windows, renameSync overwrites atomically on NTFS.
   */
  private async atomicWrite(targetPath: string, content: string): Promise<void> {
    const tmp = targetPath + '.tmp';
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, targetPath);
  }

  private async removeFromOrder(relPath: string): Promise<void> {
    const manifestPath = path.join(this.workspaceRoot, COLLECTION_YAML);
    if (!fs.existsSync(manifestPath)) return;

    try {
      const raw = yaml.load(fs.readFileSync(manifestPath, 'utf8')) as RawCollectionYaml;
      if (!raw || !Array.isArray(raw.order)) return;

      const filtered = (raw.order as CollectionOrderEntry[]).filter(
        (e) => !('request' in e && e.request === relPath),
      );

      await this.atomicWrite(
        manifestPath,
        yaml.dump({ ...raw, order: filtered }, { lineWidth: 120 }),
      );
    } catch {
      // Non-critical — order cleanup failure is cosmetic
    }
  }

  private async updateOrderPath(oldRelPath: string, newRelPath: string): Promise<void> {
    const manifestPath = path.join(this.workspaceRoot, COLLECTION_YAML);
    if (!fs.existsSync(manifestPath)) return;

    try {
      const raw = yaml.load(fs.readFileSync(manifestPath, 'utf8')) as RawCollectionYaml;
      if (!raw || !Array.isArray(raw.order)) return;

      const updated = (raw.order as CollectionOrderEntry[]).map((e) =>
        'request' in e && e.request === oldRelPath ? { request: newRelPath } : e,
      );

      await this.atomicWrite(
        manifestPath,
        yaml.dump({ ...raw, order: updated }, { lineWidth: 120 }),
      );
    } catch {
      // Non-critical
    }
  }

  private async ensureSecretsIgnored(): Promise<void> {
    const gitignorePath = path.join(this.workspaceRoot, '.gitignore');

    if (!fs.existsSync(gitignorePath)) return;

    try {
      const content = fs.readFileSync(gitignorePath, 'utf8');
      if (
        content.includes('.secrets.local.yaml') ||
        content.includes('*.local.yaml')
      ) {
        return;
      }

      // Append the entry
      const appended =
        content.endsWith('\n')
          ? content + '.secrets.local.yaml\n'
          : content + '\n.secrets.local.yaml\n';
      fs.writeFileSync(gitignorePath, appended, 'utf8');
      this.output.appendLine('[CollectionService] Added .secrets.local.yaml to .gitignore');
    } catch {
      // Non-critical
    }
  }

  // ---------------------------------------------------------------------------
  // File watchers (REQ-COL-006)
  // ---------------------------------------------------------------------------

  private startWatchers(): void {
    // Watch everything under .volt/ except envs (environment-service watches those)
    const requestsPattern = new vscode.RelativePattern(
      this.workspaceRoot,
      '.volt/requests/**/*.yaml',
    );
    const manifestPattern = new vscode.RelativePattern(
      this.workspaceRoot,
      '.volt/collection.yaml',
    );

    const requestsWatcher = vscode.workspace.createFileSystemWatcher(requestsPattern);
    const manifestWatcher = vscode.workspace.createFileSystemWatcher(manifestPattern);

    const fireChange = (kind: CollectionChangeEvent['kind']) => () => {
      this.scheduleRefresh(kind);
    };

    requestsWatcher.onDidChange(fireChange('request'), undefined, this.disposables);
    requestsWatcher.onDidCreate(fireChange('request'), undefined, this.disposables);
    requestsWatcher.onDidDelete(fireChange('request'), undefined, this.disposables);

    manifestWatcher.onDidChange(fireChange('manifest'), undefined, this.disposables);
    manifestWatcher.onDidCreate(fireChange('manifest'), undefined, this.disposables);
    manifestWatcher.onDidDelete(fireChange('manifest'), undefined, this.disposables);

    this.disposables.push(requestsWatcher, manifestWatcher);

    this.output.appendLine('[CollectionService] File watchers started for .volt/requests/ + collection.yaml');
  }

  /**
   * Debounce rapid change events — only fires after 100 ms of silence.
   * This prevents N tree refreshes during a git checkout. (REQ-COL-006)
   */
  private scheduleRefresh(kind: CollectionChangeEvent['kind']): void {
    if (this.debounceHandle !== undefined) {
      clearTimeout(this.debounceHandle);
    }
    this.debounceHandle = setTimeout(() => {
      this.debounceHandle = undefined;
      this.output.appendLine(`[CollectionService] Firing change event (kind: ${kind})`);
      this._onDidChange.fire({ kind });
    }, 100);
  }

  // ---------------------------------------------------------------------------
  // Disposable
  // ---------------------------------------------------------------------------

  dispose(): void {
    if (this.debounceHandle !== undefined) {
      clearTimeout(this.debounceHandle);
    }
    this.disposables.forEach((d) => d.dispose());
    this.disposables.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (no side effects)
// ---------------------------------------------------------------------------

/**
 * Normalise a relative file path to posix separators and strip `.yaml` extension.
 */
function normalizeRelPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\.yaml$/, '');
}

/**
 * Build a human-readable YAML string for a request definition.
 */
function buildRequestYaml(req: HttpRequestDef): string {
  // Shape the object for YAML output — matches the YAML schema
  const out: Record<string, unknown> = {
    name: req.name ?? '',
    method: req.method,
    url: req.url,
  };

  if (req.description) {
    out['description'] = req.description;
  }

  if (Object.keys(req.headers).length > 0) {
    out['headers'] = req.headers;
  }

  if (req.body && req.body.type !== 'none') {
    if (req.body.type === 'binary') {
      out['body'] = { type: req.body.type, filePath: req.body.filePath };
    } else if (req.body.type === 'graphql') {
      out['body'] = {
        type: 'graphql',
        query: req.body.query,
        variables: req.body.variables,
        operationName: req.body.operationName,
      };
    } else {
      out['body'] = { type: req.body.type, content: req.body.content };
    }
  }

  if (req.queryParams.length > 0) {
    out['queryParams'] = req.queryParams.map((p) => ({
      key: p.key,
      value: p.value,
      enabled: p.enabled,
    }));
  }

  if (req.preScript) {
    out['preScript'] = req.preScript;
  }

  if (req.postScript) {
    out['postScript'] = req.postScript;
  }

  if (req.settings !== undefined) {
    out['settings'] = req.settings;
  }

  if (req.auth !== undefined && req.auth.type !== 'none') {
    out['auth'] = req.auth;
  }

  if (req.timeout !== undefined) {
    out['timeout'] = req.timeout;
  }

  if (req.assertions && req.assertions.length > 0) {
    out['assertions'] = req.assertions.map((a) => ({
      id: a.id,
      subject: a.subject,
      property: a.property,
      operator: a.operator,
      expected: a.expected,
    }));
  }

  return yaml.dump(out, { lineWidth: 120, noCompatMode: true });
}

/**
 * Coerce a raw parsed YAML object to an `HttpRequestDef`.
 * Fills in defaults for optional fields.
 */
function coerceToRequestDef(raw: RawRequestYaml, absPath: string): HttpRequestDef {
  const method: HttpMethod =
    typeof raw.method === 'string' && isValidMethod(raw.method)
      ? (raw.method as HttpMethod)
      : 'GET';

  const url = typeof raw.url === 'string' ? raw.url : '';
  const id = typeof raw.id === 'string' ? raw.id : path.basename(absPath, '.yaml');
  const name = typeof raw.name === 'string' ? raw.name : path.basename(absPath, '.yaml');

  const headers: Record<string, string> = {};
  if (raw.headers && typeof raw.headers === 'object') {
    for (const [k, v] of Object.entries(raw.headers as Record<string, unknown>)) {
      if (typeof v === 'string') headers[k] = v;
    }
  }

  const queryParams: Array<{ key: string; value: string; enabled: boolean }> = [];
  if (Array.isArray(raw.queryParams)) {
    for (const p of raw.queryParams as unknown[]) {
      if (
        p &&
        typeof p === 'object' &&
        'key' in p &&
        'value' in p &&
        'enabled' in p
      ) {
        const pp = p as Record<string, unknown>;
        queryParams.push({
          key: String(pp['key'] ?? ''),
          value: String(pp['value'] ?? ''),
          enabled: Boolean(pp['enabled'] ?? true),
        });
      }
    }
  }

  let body: HttpRequestDef['body'];
  if (raw.body && typeof raw.body === 'object') {
    const b = raw.body as Record<string, unknown>;
    const type = b['type'];
    if (type === 'json' || type === 'text' || type === 'form-data') {
      body = { type, content: typeof b['content'] === 'string' ? b['content'] : '' };
    } else if (type === 'none') {
      body = { type: 'none' };
    } else if (type === 'graphql') {
      body = {
        type: 'graphql',
        query: typeof b['query'] === 'string' ? b['query'] : '',
        variables: typeof b['variables'] === 'string' ? b['variables'] : '{}',
        operationName: typeof b['operationName'] === 'string' ? b['operationName'] : '',
      };
    }
  }

  const preScript = typeof raw.preScript === 'string' ? raw.preScript : undefined;
  const postScript = typeof raw.postScript === 'string' ? raw.postScript : undefined;
  const description = typeof raw.description === 'string' ? raw.description : undefined;

  let settings: HttpRequestDef['settings'];
  if (raw.settings && typeof raw.settings === 'object') {
    const s = raw.settings as Record<string, unknown>;
    const sslVerify = typeof s['sslVerify'] === 'boolean' ? s['sslVerify'] : undefined;
    const followRedirects = typeof s['followRedirects'] === 'boolean' ? s['followRedirects'] : undefined;
    if (sslVerify !== undefined || followRedirects !== undefined) {
      settings = {
        ...(sslVerify !== undefined ? { sslVerify } : {}),
        ...(followRedirects !== undefined ? { followRedirects } : {}),
      };
    }
  }

  // Parse auth configuration
  let auth: AuthConfig | undefined;
  if (raw.auth && typeof raw.auth === 'object') {
    const a = raw.auth as Record<string, unknown>;
    const authType = a['type'];
    if (authType === 'bearer' && typeof a['token'] === 'string') {
      auth = { type: 'bearer', token: a['token'] };
    } else if (
      authType === 'basic' &&
      typeof a['username'] === 'string' &&
      typeof a['password'] === 'string'
    ) {
      auth = { type: 'basic', username: a['username'], password: a['password'] };
    } else if (
      authType === 'apikey' &&
      typeof a['key'] === 'string' &&
      typeof a['value'] === 'string' &&
      (a['addTo'] === 'header' || a['addTo'] === 'query')
    ) {
      auth = { type: 'apikey', key: a['key'], value: a['value'], addTo: a['addTo'] };
    } else if (
      authType === 'oauth2' &&
      (a['grantType'] === 'client_credentials' || a['grantType'] === 'authorization_code') &&
      typeof a['tokenUrl'] === 'string' &&
      typeof a['clientId'] === 'string' &&
      typeof a['clientSecret'] === 'string'
    ) {
      auth = {
        type: 'oauth2',
        grantType: a['grantType'],
        tokenUrl: a['tokenUrl'],
        clientId: a['clientId'],
        clientSecret: a['clientSecret'],
        scope: typeof a['scope'] === 'string' ? a['scope'] : '',
        accessToken: typeof a['accessToken'] === 'string' ? a['accessToken'] : '',
      };
    } else if (
      authType === 'aws' &&
      typeof a['accessKeyId'] === 'string' &&
      typeof a['secretAccessKey'] === 'string' &&
      typeof a['region'] === 'string' &&
      typeof a['service'] === 'string'
    ) {
      auth = {
        type: 'aws',
        accessKeyId: a['accessKeyId'],
        secretAccessKey: a['secretAccessKey'],
        region: a['region'],
        service: a['service'],
        ...(typeof a['sessionToken'] === 'string' ? { sessionToken: a['sessionToken'] } : {}),
      };
    }
  }

  // Parse timeout
  const timeout: number | undefined =
    typeof raw.timeout === 'number' && raw.timeout > 0 ? raw.timeout : undefined;

  // Parse assertions
  const assertions: import('../../shared/models').AssertionRule[] = [];
  if (Array.isArray(raw.assertions)) {
    const validSubjects = new Set(['status', 'time', 'jsonpath', 'header']);
    const validOperators = new Set(['eq', 'neq', 'contains', 'gt', 'lt', 'exists']);
    for (const a of raw.assertions as unknown[]) {
      if (a && typeof a === 'object') {
        const ar = a as Record<string, unknown>;
        const subject = ar['subject'];
        const operator = ar['operator'];
        if (
          typeof ar['id'] === 'string' &&
          typeof subject === 'string' && validSubjects.has(subject) &&
          typeof operator === 'string' && validOperators.has(operator)
        ) {
          assertions.push({
            id: ar['id'],
            subject: subject as import('../../shared/models').AssertionSubject,
            property: typeof ar['property'] === 'string' ? ar['property'] : '',
            operator: operator as import('../../shared/models').AssertionOperator,
            expected: typeof ar['expected'] === 'string' ? ar['expected'] : '',
          });
        }
      }
    }
  }

  return {
    id, name, method, url, headers, queryParams,
    ...(body !== undefined ? { body } : {}),
    ...(description ? { description } : {}),
    ...(preScript ? { preScript } : {}),
    ...(postScript ? { postScript } : {}),
    ...(settings !== undefined ? { settings } : {}),
    ...(auth !== undefined ? { auth } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    ...(assertions.length > 0 ? { assertions } : {}),
  };
}

/**
 * Parse the `order` array from collection.yaml into typed entries.
 */
function parseOrderEntries(raw: unknown[]): CollectionOrderEntry[] {
  const result: CollectionOrderEntry[] = [];
  for (const entry of raw) {
    if (entry && typeof entry === 'object') {
      const e = entry as Record<string, unknown>;
      if (typeof e['folder'] === 'string') result.push({ folder: e['folder'] });
      else if (typeof e['request'] === 'string') result.push({ request: e['request'] });
    }
  }
  return result;
}

/**
 * Reorder a list of nodes according to `order` entries.
 * Items not mentioned in `order` are appended after the ordered items.
 */
function applyOrder(nodes: CollectionTreeNode[], order: CollectionOrderEntry[]): CollectionTreeNode[] {
  if (order.length === 0) return nodes;

  const remaining = [...nodes];
  const ordered: CollectionTreeNode[] = [];

  for (const entry of order) {
    const key = 'folder' in entry ? entry.folder : entry.request;
    const kind = 'folder' in entry ? 'folder' : 'request';

    const idx = remaining.findIndex((n) => {
      if (n.kind !== kind) return false;
      if (kind === 'folder') return n.name === key;
      // For requests, collection.yaml stores the relative path, not the display name
      return (n as CollectionRequestItem).path === key;
    });
    if (idx !== -1) {
      ordered.push(remaining.splice(idx, 1)[0]!);
    }
  }

  return [...ordered, ...remaining];
}

/**
 * Type guard: check if a string is a valid `HttpMethod`.
 */
function isValidMethod(m: string): m is HttpMethod {
  return (VALID_METHODS as string[]).includes(m);
}
