/**
 * @fileoverview Volt Collection Tree Provider — Phase 4 full implementation.
 *
 * Implements `TreeDataProvider<VoltTreeItem>` and `TreeDragAndDropController`
 * to power the Volt sidebar.
 *
 * Features:
 * - Folder nodes (collapsible) with folder icon
 * - Request nodes (leaf) with method-coloured ThemeIcon labels
 * - Context menu actions: New Request, New Folder, Rename, Delete, Duplicate
 * - Drag-and-drop reorder within and between folders (REQ-COL-004)
 * - Live refresh on CollectionService file-watcher events (REQ-COL-001)
 * - Double-click opens request in webview (via `volt.openRequest` command)
 *
 * Method colour coding (VS Code ThemeColor):
 *   GET    → charts.green
 *   POST   → charts.blue
 *   PUT    → charts.yellow
 *   PATCH  → charts.orange
 *   DELETE → charts.red
 *   HEAD   → charts.purple
 *   OPTIONS → foreground (default)
 *
 * @see REQ-COL-001 — Tree View Display
 * @see REQ-COL-002 — CRUD Operations
 * @see REQ-COL-004 — Drag and Drop Reorder
 */

import * as vscode from 'vscode';
import type { CollectionService } from '../services/collection-service';
import type {
  CollectionTreeNode,
  CollectionFolderItem,
  CollectionRequestItem,
  HttpMethod,
} from '../../shared/models';

// ---------------------------------------------------------------------------
// Tree item
// ---------------------------------------------------------------------------

/** Discriminated kind mirroring CollectionTreeNode plus a placeholder state. */
export type VoltTreeItemKind = 'folder' | 'request' | 'empty';

/**
 * A single node rendered in the Volt sidebar.
 */
export class VoltTreeItem extends vscode.TreeItem {
  readonly kind: VoltTreeItemKind;
  /** Relative path inside `.volt/requests/` (requests only, no extension). */
  readonly requestPath: string | undefined;
  /** HTTP method (requests only). */
  readonly method: HttpMethod | undefined;

  constructor(
    label: string,
    kind: VoltTreeItemKind,
    collapsibleState: vscode.TreeItemCollapsibleState,
    options?: {
      requestPath?: string;
      method?: HttpMethod;
      description?: string;
      tooltip?: string;
      contextValue?: string;
    },
  ) {
    super(label, collapsibleState);
    this.kind = kind;
    this.requestPath = options?.requestPath;
    this.method = options?.method;

    if (options?.description !== undefined) this.description = options.description;
    if (options?.tooltip !== undefined) this.tooltip = options.tooltip;
    if (options?.contextValue !== undefined) this.contextValue = options.contextValue;
  }
}

// ---------------------------------------------------------------------------
// Drag-and-drop MIME type
// ---------------------------------------------------------------------------

const VOLT_DRAG_MIME = 'application/vnd.code.tree.volt.collectionTree';

// ---------------------------------------------------------------------------
// CollectionTreeProvider
// ---------------------------------------------------------------------------

/**
 * Full tree provider wired to `CollectionService`.
 * Replaces the Phase 2 shell implementation.
 */
export class CollectionTreeProvider
  implements
    vscode.TreeDataProvider<VoltTreeItem>,
    vscode.TreeDragAndDropController<VoltTreeItem>,
    vscode.Disposable
{
  // TreeDragAndDropController required fields
  readonly dropMimeTypes = [VOLT_DRAG_MIME];
  readonly dragMimeTypes = [VOLT_DRAG_MIME];

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    VoltTreeItem | undefined | null | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Cached flat tree from last load. Used for drag-and-drop path resolution. */
  private cachedNodes: CollectionTreeNode[] = [];

  private readonly disposables: vscode.Disposable[] = [];
  private collectionService: CollectionService | undefined;

  constructor() {
    this.disposables.push(this._onDidChangeTreeData);
  }

  // ---------------------------------------------------------------------------
  // Service injection (called from activate.ts in Phase 4)
  // ---------------------------------------------------------------------------

  /**
   * Wire a CollectionService instance. Called after the service is constructed
   * in `activate.ts`. Subscribes to file-watcher change events.
   */
  setCollectionService(service: CollectionService): void {
    this.collectionService = service;

    // Subscribe to watcher events — refresh the tree on any file change
    const sub = service.onDidChange(() => {
      this.refresh();
    });
    this.disposables.push(sub);
  }

  // ---------------------------------------------------------------------------
  // TreeDataProvider
  // ---------------------------------------------------------------------------

  getTreeItem(element: VoltTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: VoltTreeItem): Promise<VoltTreeItem[]> {
    if (!this.collectionService) {
      return [makePlaceholder('No collection service — run "Volt: Initialize Collection"')];
    }

    try {
      const tree = await this.collectionService.loadTree();
      this.cachedNodes = [...tree.nodes]; // cache for DnD

      if (!element) {
        // Root level
        if (tree.nodes.length === 0) {
          return [makePlaceholder('No requests yet — right-click to add one')];
        }
        return tree.nodes.map(nodeToTreeItem);
      }

      // Folder children
      if (element.kind === 'folder') {
        const folderNode = findFolderByName(tree.nodes, element.label as string);
        if (!folderNode) return [];
        return folderNode.children.map(nodeToTreeItem);
      }

      return [];
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window
        .showErrorMessage(`Volt: Failed to load collection tree — ${msg}`)
        .then(undefined, () => undefined);
      return [makePlaceholder(`Error loading collection: ${msg}`)];
    }
  }

  // ---------------------------------------------------------------------------
  // Drag and Drop (REQ-COL-004 — SHOULD, implemented within budget)
  // ---------------------------------------------------------------------------

  handleDrag(
    source: readonly VoltTreeItem[],
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken,
  ): void {
    // Only allow dragging request nodes
    const requestItems = source.filter((i) => i.kind === 'request');
    if (requestItems.length === 0) return;

    dataTransfer.set(
      VOLT_DRAG_MIME,
      new vscode.DataTransferItem(requestItems.map((i) => i.requestPath ?? '')),
    );
  }

  async handleDrop(
    target: VoltTreeItem | undefined,
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    if (!this.collectionService) return;

    const item = dataTransfer.get(VOLT_DRAG_MIME);
    if (!item) return;

    const paths = item.value as string[];
    if (!paths || paths.length === 0) return;

    const targetFolderName = target?.kind === 'folder' ? (target.label as string) : undefined;

    let moved = false;
    for (const relPath of paths) {
      if (!relPath) continue;

      try {
        // Move the YAML file to the target folder
        const fileName = relPath.split('/').pop() ?? relPath;
        const newRelPath = targetFolderName ? `${targetFolderName}/${fileName}` : fileName;

        if (newRelPath !== relPath) {
          // Load the request from its current location
          const request = await this.collectionService.loadRequest(relPath);
          // Save it at the new location
          await this.collectionService.saveRequest(newRelPath, request);
          // Delete the old file
          await this.collectionService.deleteRequest(relPath);
          moved = true;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window
          .showErrorMessage(`Volt: Move failed — ${msg}`)
          .then(undefined, () => undefined);
      }
    }

    // Only refresh the tree when at least one item was actually moved
    if (moved) {
      this.refresh();
    }
  }

  // ---------------------------------------------------------------------------
  // Refresh
  // ---------------------------------------------------------------------------

  /**
   * Trigger a full tree refresh. Called by:
   * - `volt.refreshTree` command
   * - CollectionService `onDidChange` event (file watcher)
   * - After CRUD operations
   */
  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  // ---------------------------------------------------------------------------
  // Disposable
  // ---------------------------------------------------------------------------

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.disposables.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Node → TreeItem conversion helpers
// ---------------------------------------------------------------------------

/**
 * Convert a `CollectionTreeNode` to a `VoltTreeItem` for the VS Code tree.
 */
function nodeToTreeItem(node: CollectionTreeNode): VoltTreeItem {
  if (node.kind === 'folder') {
    return folderToTreeItem(node);
  }
  return requestToTreeItem(node);
}

function folderToTreeItem(folder: CollectionFolderItem): VoltTreeItem {
  const item = new VoltTreeItem(
    folder.name,
    'folder',
    folder.children.length > 0
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None,
    {
      tooltip: `Folder: ${folder.name} (${folder.children.length} item${folder.children.length !== 1 ? 's' : ''})`,
      contextValue: 'voltFolder',
    },
  );

  item.iconPath = vscode.ThemeIcon.Folder;
  return item;
}

function requestToTreeItem(req: CollectionRequestItem): VoltTreeItem {
  const item = new VoltTreeItem(
    req.name,
    'request',
    vscode.TreeItemCollapsibleState.None,
    {
      requestPath: req.path,
      method: req.method,
      description: req.method,
      tooltip: `${req.method}  ${req.name}\n\nPath: ${req.path}`,
      contextValue: 'voltRequest',
    },
  );

  // Method-coloured icon using VS Code ThemeColor (REQ-COL-001)
  item.iconPath = methodThemeIcon(req.method);

  // Double-click to open in webview
  item.command = {
    command: 'volt.openRequest',
    title: 'Open Request',
    arguments: [req.path],
  };

  return item;
}

/**
 * Map an HTTP method to a ThemeIcon with appropriate colour.
 */
function methodThemeIcon(method: HttpMethod): vscode.ThemeIcon {
  const colorMap: Record<HttpMethod, string> = {
    GET: 'charts.green',
    POST: 'charts.blue',
    PUT: 'charts.yellow',
    PATCH: 'charts.orange',
    DELETE: 'charts.red',
    HEAD: 'charts.purple',
    OPTIONS: 'foreground',
  };
  return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(colorMap[method] ?? 'foreground'));
}

/**
 * Create a placeholder (empty-state) tree item.
 */
function makePlaceholder(message: string): VoltTreeItem {
  const item = new VoltTreeItem(message, 'empty', vscode.TreeItemCollapsibleState.None, {
    contextValue: 'voltEmptyState',
  });
  item.iconPath = new vscode.ThemeIcon('info');
  return item;
}

/**
 * Find a folder node by name recursively in the tree nodes list.
 * Searches depth-first through nested folder children.
 */
function findFolderByName(
  nodes: readonly CollectionTreeNode[],
  name: string,
): CollectionFolderItem | undefined {
  for (const node of nodes) {
    if (node.kind === 'folder') {
      if (node.name === name) return node;
      // Recurse into nested folders
      const found = findFolderByName(node.children, name);
      if (found) return found;
    }
  }
  return undefined;
}
