/**
 * @fileoverview Volt extension entry point.
 *
 * `activate` is called by VS Code when the activation event fires
 * (`workspaceContains:.volt/collection.yaml` or an explicit command invocation).
 * It wires together all providers, services, and commands for the Volt MVP.
 *
 * `deactivate` is called on extension teardown — all cleanup is handled via
 * `ExtensionContext.subscriptions`, so this function is mostly a hook for any
 * async teardown not covered by `Disposable.dispose`.
 *
 * @see REQ-EXT-001 — Lazy Activation
 * @see REQ-EXT-002 — Command Registration
 */

import * as vscode from 'vscode';
import { WebviewProvider, PANEL_VIEW_TYPE } from './providers/webview-provider';
import { CollectionTreeProvider } from './providers/collection-tree-provider';
import { MessageRouter } from './message-router';
import { HttpService } from './services/http-service';
import { EnvironmentService } from './services/environment-service';
import { CollectionService } from './services/collection-service';

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

/**
 * Extension activation entry point.
 *
 * Registration order:
 * 1. Output channel (logging)
 * 2. Services: HttpService, EnvironmentService, CollectionService
 * 3. MessageRouter (receives all services)
 * 4. WebviewProvider (panel management, requires router)
 * 5. CollectionTreeProvider (sidebar, wired to CollectionService)
 * 6. Commands (depend on providers + services)
 * 7. WebviewPanelSerializer (panel restoration)
 * 8. TreeView registration (with DnD controller)
 */
export function activate(context: vscode.ExtensionContext): void {
  // 1. Output channel
  const output = vscode.window.createOutputChannel('Volt');
  context.subscriptions.push(output);
  output.appendLine('[Volt] Activating…');

  const workspaceRoot =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

  // 2a. HTTP Service (Phase 3)
  const httpService = new HttpService(output);
  context.subscriptions.push(httpService);

  // 2b. Environment Service (Phase 3)
  const environmentService = new EnvironmentService(output, workspaceRoot);
  context.subscriptions.push(environmentService);
  // Non-blocking initialisation — env files may not exist yet
  void environmentService.initialise();

  // 2c. Collection Service (Phase 4)
  const collectionService = new CollectionService(output, workspaceRoot);
  context.subscriptions.push(collectionService);
  collectionService.initialise();

  // 3. Message router — all Phase 3+4 services injected
  const router = new MessageRouter(output, {
    http: httpService,
    collection: collectionService,
    environment: environmentService,
  });
  context.subscriptions.push(router);

  // 4. Webview provider
  const webviewProvider = new WebviewProvider(context, router);
  context.subscriptions.push(webviewProvider);

  // 5. Collection tree provider — wired to CollectionService
  const treeProvider = new CollectionTreeProvider();
  treeProvider.setCollectionService(collectionService);
  context.subscriptions.push(treeProvider);

  // 6. Commands ---------------------------------------------------------------

  // volt.newRequest — open (or focus) the Volt panel
  context.subscriptions.push(
    vscode.commands.registerCommand('volt.newRequest', () => {
      output.appendLine('[Volt] Command: volt.newRequest');
      webviewProvider.openPanel();
    }),
  );

  // volt.openCollection — open the panel
  context.subscriptions.push(
    vscode.commands.registerCommand('volt.openCollection', () => {
      output.appendLine('[Volt] Command: volt.openCollection');
      webviewProvider.openPanel();
    }),
  );

  // volt.sendRequest — focus the panel and trigger a send (Phase 6 wires the full flow)
  context.subscriptions.push(
    vscode.commands.registerCommand('volt.sendRequest', () => {
      output.appendLine('[Volt] Command: volt.sendRequest');
      webviewProvider.openPanel();
    }),
  );

  // volt.switchEnvironment — open panel and show env switcher
  context.subscriptions.push(
    vscode.commands.registerCommand('volt.switchEnvironment', () => {
      output.appendLine('[Volt] Command: volt.switchEnvironment');
      webviewProvider.openPanel();
    }),
  );

  // volt.refreshTree — force-reload the sidebar tree
  context.subscriptions.push(
    vscode.commands.registerCommand('volt.refreshTree', () => {
      output.appendLine('[Volt] Command: volt.refreshTree');
      treeProvider.refresh();
    }),
  );

  // volt.initCollection — create .volt/ scaffold if it doesn't exist (REQ-COL-002)
  context.subscriptions.push(
    vscode.commands.registerCommand('volt.initCollection', async () => {
      output.appendLine('[Volt] Command: volt.initCollection');
      try {
        const created = await collectionService.initCollection();
        if (created) {
          await vscode.window.showInformationMessage(
            'Volt: Collection initialised! .volt/ directory created in workspace.',
          );
          treeProvider.refresh();
        } else {
          await vscode.window.showInformationMessage(
            'Volt: Collection already exists (.volt/collection.yaml found).',
          );
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await vscode.window.showErrorMessage(`Volt: Failed to initialise collection — ${msg}`);
      }
    }),
  );

  // volt.openRequest — open a specific request in the webview panel
  // Called by tree item double-click (command on VoltTreeItem)
  context.subscriptions.push(
    vscode.commands.registerCommand('volt.openRequest', async (requestPath: string) => {
      output.appendLine(`[Volt] Command: volt.openRequest — ${requestPath}`);
      webviewProvider.openPanel();
      // Phase 6 will deep-link to the specific request in the webview
      // For now, opening the panel is sufficient
    }),
  );

  // Context-menu commands for tree items (Phase 4 wires CRUD)
  context.subscriptions.push(
    vscode.commands.registerCommand('volt.newRequestInFolder', async (item: unknown) => {
      output.appendLine('[Volt] Command: volt.newRequestInFolder');
      const folderName = item && typeof item === 'object' && 'label' in item
        ? String((item as { label: unknown }).label)
        : '';
      const name = await vscode.window.showInputBox({
        prompt: 'Request name',
        placeHolder: 'e.g. get-users',
      });
      if (!name) return;
      const relPath = folderName ? `${folderName}/${name}` : name;
      await collectionService.saveRequest(relPath, {
        id: relPath,
        method: 'GET',
        url: '',
        headers: {},
        queryParams: [],
      });
      treeProvider.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('volt.newFolder', async () => {
      output.appendLine('[Volt] Command: volt.newFolder');
      const name = await vscode.window.showInputBox({
        prompt: 'Folder name',
        placeHolder: 'e.g. auth',
      });
      if (!name) return;
      await collectionService.createFolder(name);
      treeProvider.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('volt.deleteRequest', async (item: unknown) => {
      output.appendLine('[Volt] Command: volt.deleteRequest');
      if (!item || typeof item !== 'object' || !('requestPath' in item)) return;
      const relPath = String((item as { requestPath: unknown }).requestPath);
      const confirm = await vscode.window.showWarningMessage(
        `Delete request "${relPath}"?`,
        { modal: true },
        'Delete',
      );
      if (confirm !== 'Delete') return;
      await collectionService.deleteRequest(relPath);
      treeProvider.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('volt.deleteFolder', async (item: unknown) => {
      output.appendLine('[Volt] Command: volt.deleteFolder');
      if (!item || typeof item !== 'object' || !('label' in item)) return;
      const folderName = String((item as { label: unknown }).label);
      const confirm = await vscode.window.showWarningMessage(
        `Delete folder "${folderName}" and all its requests?`,
        { modal: true },
        'Delete',
      );
      if (confirm !== 'Delete') return;
      await collectionService.deleteFolder(folderName);
      treeProvider.refresh();
    }),
  );

  // 7. Panel serializer — restores panels across VS Code restarts (REQ-EXT-003)
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(PANEL_VIEW_TYPE, webviewProvider),
  );

  // 8. Tree view registration (REQ-EXT-004) — with DnD controller
  const treeView = vscode.window.createTreeView('volt.collectionTree', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
    dragAndDropController: treeProvider,
  });
  context.subscriptions.push(treeView);

  output.appendLine('[Volt] Activated successfully');
}

// ---------------------------------------------------------------------------
// Deactivation
// ---------------------------------------------------------------------------

/**
 * Called by VS Code when the extension is deactivated (workspace closed, VS Code
 * quit, extension disabled). All `Disposable`-based cleanup is already handled
 * by `context.subscriptions`; this function handles any async-only teardown.
 */
export function deactivate(): void {
  // All disposables registered via context.subscriptions are cleaned up
  // automatically by VS Code. No additional async teardown is required yet.
}
