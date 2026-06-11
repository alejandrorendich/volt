/**
 * @fileoverview HistoryService — per-request execution history.
 *
 * Stores the last 50 executions of each saved request in
 * `.volt/history/{request-path}.json`. Files are auto-created on first write.
 * Read/write uses synchronous fs calls because files are tiny (<10 KB).
 *
 * History files are stored mirroring the request path:
 *   request `auth/login` → `.volt/history/auth/login.json`
 */

import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import type { HistoryEntry } from '../../shared/protocol';

export type { HistoryEntry };

interface HistoryFile {
  request: string;
  entries: HistoryEntry[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ENTRIES = 50;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class HistoryService {
  private readonly output: vscode.OutputChannel;
  private readonly historyDir: string;

  constructor(output: vscode.OutputChannel, workspaceRoot: string) {
    this.output = output;
    this.historyDir = path.join(workspaceRoot, '.volt', 'history');
  }

  /**
   * Append an entry for the given request path.
   * Trims to the last MAX_ENTRIES entries (newest first).
   */
  addEntry(requestPath: string, entry: HistoryEntry): void {
    try {
      const filePath = this.filePathFor(requestPath);
      const existing = this.readFile(filePath, requestPath);

      // Prepend new entry (newest first), then trim
      const trimmed = [entry, ...existing.entries].slice(0, MAX_ENTRIES);

      this.ensureDir(path.dirname(filePath));
      fs.writeFileSync(
        filePath,
        JSON.stringify({ request: requestPath, entries: trimmed }, null, 2),
        'utf8',
      );
    } catch (err: unknown) {
      this.output.appendLine(`[HistoryService] ERROR writing entry: ${String(err)}`);
    }
  }

  /**
   * Returns the history entries for a request, newest first.
   * Returns an empty array if no history file exists.
   */
  getHistory(requestPath: string): HistoryEntry[] {
    try {
      const filePath = this.filePathFor(requestPath);
      if (!fs.existsSync(filePath)) return [];
      const file = this.readFile(filePath, requestPath);
      return file.entries;
    } catch (err: unknown) {
      this.output.appendLine(`[HistoryService] ERROR reading history: ${String(err)}`);
      return [];
    }
  }

  /**
   * Deletes the history file for a request. No-op if the file doesn't exist.
   */
  clearHistory(requestPath: string): void {
    try {
      const filePath = this.filePathFor(requestPath);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (err: unknown) {
      this.output.appendLine(`[HistoryService] ERROR clearing history: ${String(err)}`);
    }
  }

  /**
   * Delete a single entry by timestamp.
   */
  deleteEntry(requestPath: string, timestamp: string): void {
    try {
      const filePath = this.filePathFor(requestPath);
      const existing = this.readFile(filePath, requestPath);
      const filtered = existing.entries.filter((e) => e.timestamp !== timestamp);
      if (filtered.length === 0) {
        // No entries left — delete the file
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        return;
      }
      fs.writeFileSync(
        filePath,
        JSON.stringify({ request: requestPath, entries: filtered }, null, 2),
        'utf8',
      );
    } catch (err: unknown) {
      this.output.appendLine(`[HistoryService] ERROR deleting entry: ${String(err)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private filePathFor(requestPath: string): string {
    // Normalize separators so `auth/login` works on all platforms
    const normalized = requestPath.split('/').join(path.sep);
    return path.join(this.historyDir, `${normalized}.json`);
  }

  private readFile(filePath: string, requestPath: string): HistoryFile {
    if (!fs.existsSync(filePath)) {
      return { request: requestPath, entries: [] };
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as HistoryFile;
    if (!Array.isArray(parsed.entries)) {
      return { request: requestPath, entries: [] };
    }
    return parsed;
  }

  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}
