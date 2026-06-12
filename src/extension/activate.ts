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
import { HistoryService } from './services/history-service';
import { CookieService } from './services/cookie-service';
import { importPostmanCollection } from './services/postman-import';
import { buildCurlCommand } from './utils/curl';

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

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  if (!workspaceRoot) {
    output.appendLine('[Volt] No workspace folder open — collection and environment features disabled.');
    vscode.window.showWarningMessage(
      'Volt: Open a folder to save requests and use environments.',
    );
  }

  // 2a. HTTP Service (Phase 3) — always available (can send requests without a workspace)
  const httpService = new HttpService(output);
  context.subscriptions.push(httpService);

  // 2b. Environment Service (Phase 3) — requires workspace
  let environmentService: EnvironmentService | undefined;
  if (workspaceRoot) {
    environmentService = new EnvironmentService(output, workspaceRoot);
    context.subscriptions.push(environmentService);
    void environmentService.initialise();
  }

  // 2c. Collection Service (Phase 4) — requires workspace
  let collectionService: CollectionService | undefined;
  if (workspaceRoot) {
    collectionService = new CollectionService(output, workspaceRoot);
    context.subscriptions.push(collectionService);
    collectionService.initialise();
  }

  // 2d. History Service — requires workspace
  let historyService: HistoryService | undefined;
  if (workspaceRoot) {
    historyService = new HistoryService(output, workspaceRoot);
  }

  // 2e. Cookie Service — in-memory, always available
  const cookieService = new CookieService(output);

  // 3. Message router — all Phase 3+4 services injected
  const router = new MessageRouter(output, {
    http: httpService,
    ...(collectionService ? { collection: collectionService } : {}),
    ...(environmentService ? { environment: environmentService } : {}),
    ...(historyService ? { history: historyService } : {}),
    cookies: cookieService,
  });
  context.subscriptions.push(router);
  if (environmentService) {
    const envSvc = environmentService;
    envSvc.onDidChange = () => {
      envSvc.getResolved().then((resolved) => {
        router.send({
          type: 'event:environment-changed',
          correlationId: `env-watch-${Date.now()}`,
          payload: resolved,
        });
      }).catch((err: unknown) => {
        output.appendLine(`[Volt] ERROR pushing env change to webview: ${String(err)}`);
      });
    };
  }

  // 4. Webview provider
  const webviewProvider = new WebviewProvider(context, router);
  context.subscriptions.push(webviewProvider);

  // 5. Collection tree provider — wired to CollectionService
  const treeProvider = new CollectionTreeProvider();
  if (collectionService) {
    treeProvider.setCollectionService(collectionService);
  }
  context.subscriptions.push(treeProvider);

  // Wire up router's treeRefresh so import triggers immediate sidebar reload
  router.treeRefresh = () => treeProvider.refresh();

  // 6. Commands ---------------------------------------------------------------

  // volt.openPanel — opens (or focuses) the Volt panel
  context.subscriptions.push(
    vscode.commands.registerCommand('volt.openPanel', () => {
      output.appendLine('[Volt] Command: volt.openPanel');
      webviewProvider.openPanel();
    }),
  );

  // volt.newRequest — create a new request at the root of the collection
  context.subscriptions.push(
    vscode.commands.registerCommand('volt.newRequest', async () => {
      output.appendLine('[Volt] Command: volt.newRequest');
      if (!collectionService) {
        vscode.window.showWarningMessage('Volt: Open a folder to create requests.');
        webviewProvider.openPanel();
        return;
      }
      // Auto-generate a unique name
      const baseName = 'new-request';
      let name = baseName;
      let attempt = 1;
      while (true) {
        try {
          await collectionService.loadRequest(name);
          attempt++;
          name = `${baseName}-${attempt}`;
        } catch {
          break; // doesn't exist, use this name
        }
      }
      try {
        await collectionService.saveRequest(name, {
          id: name,
          name,
          method: 'GET',
          url: '',
          headers: { 'Content-Type': 'application/json', 'Accept': '*/*' },
          queryParams: [],
        });
        treeProvider.refresh();
        webviewProvider.openPanel();
        setTimeout(() => router.pushRequest(name), 100);
      } catch (err: unknown) {
        output.appendLine(`[Volt] ERROR in newRequest: ${String(err)}`);
      }
    }),
  );

  // volt.openCollection — open the panel
  context.subscriptions.push(
    vscode.commands.registerCommand('volt.openCollection', () => {
      output.appendLine('[Volt] Command: volt.openCollection');
      webviewProvider.openPanel();
    }),
  );

  // volt.sendRequest — focus the panel so the webview's Ctrl+Enter handler fires.
  // The actual HTTP send is handled inside the webview: the keybinding
  // (when: voltPanelFocused) triggers a postMessage which the webview
  // intercepts and routes to its internal RequestBuilder send handler.
  // Opening the panel here ensures the webview is focused so the keybinding
  // conditions are met.
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

  // volt.newEnvironment — create a new environment file
  context.subscriptions.push(
    vscode.commands.registerCommand('volt.newEnvironment', async () => {
      output.appendLine('[Volt] Command: volt.newEnvironment');
      const name = await vscode.window.showInputBox({
        prompt: 'Environment name',
        placeHolder: 'e.g. dev, staging, prod',
        validateInput: (value) => {
          if (!value) return 'Name is required';
          if (!/^[a-zA-Z0-9_-]+$/.test(value)) return 'Only letters, numbers, hyphens and underscores';
          return undefined;
        },
      });
      if (!name) return;
      if (!environmentService) {
        vscode.window.showWarningMessage('Volt: Open a folder to manage environments.');
        return;
      }
      try {
        await environmentService.createEnvironment(name);
        vscode.window.showInformationMessage(`Volt: Environment "${name}" created.`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Volt: ${msg}`);
      }
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
      if (!collectionService) {
        vscode.window.showWarningMessage('Volt: Open a folder to initialise a collection.');
        return;
      }
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
    vscode.commands.registerCommand('volt.openRequest', (requestPath: string) => {
      output.appendLine(`[Volt] Command: volt.openRequest — ${requestPath}`);
      webviewProvider.openPanel();
      // Push the request definition to the webview builder (REQ-COL-001)
      // The router queues the message if the panel is still warming up
      router.pushRequest(requestPath);
    }),
  );

  // Context-menu commands for tree items (Phase 4 wires CRUD)
  context.subscriptions.push(
    vscode.commands.registerCommand('volt.newRequestInFolder', async (item: unknown) => {
      output.appendLine('[Volt] Command: volt.newRequestInFolder');
      if (!collectionService) return;
      const folderName = item && typeof item === 'object' && 'label' in item
        ? String((item as { label: unknown }).label)
        : '';
      // Auto-generate a unique name
      const baseName = 'new-request';
      let name = baseName;
      let attempt = 1;
      const relPathBase = folderName ? `${folderName}/${baseName}` : baseName;
      let relPath = relPathBase;
      while (true) {
        try {
          await collectionService.loadRequest(relPath);
          attempt++;
          name = `${baseName}-${attempt}`;
          relPath = folderName ? `${folderName}/${name}` : name;
        } catch {
          break;
        }
      }
      await collectionService.saveRequest(relPath, {
        id: relPath,
        name,
        method: 'GET',
        url: '',
        headers: { 'Content-Type': 'application/json', 'Accept': '*/*' },
        queryParams: [],
      });
      treeProvider.refresh();
      webviewProvider.openPanel();
      setTimeout(() => router.pushRequest(relPath), 100);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('volt.newFolder', async () => {
      output.appendLine('[Volt] Command: volt.newFolder');
      if (!collectionService) return;
      // Auto-generate a unique folder name
      const fs = await import('fs');
      const path = await import('path');
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) return;
      const baseName = 'new-folder';
      let name = baseName;
      let attempt = 1;
      while (fs.existsSync(path.join(workspaceRoot, '.volt', 'requests', name))) {
        attempt++;
        name = `${baseName}-${attempt}`;
      }
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
      if (!collectionService) return;
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
      if (!collectionService) return;
      await collectionService.deleteFolder(folderName);
      treeProvider.refresh();
    }),
  );

  // volt.exportRequest — export a single request to .volt-request.json
  context.subscriptions.push(
    vscode.commands.registerCommand('volt.exportRequest', (item: unknown) => {
      output.appendLine('[Volt] Command: volt.exportRequest');
      if (!item || typeof item !== 'object' || !('requestPath' in item)) return;
      const relPath = String((item as { requestPath: unknown }).requestPath);
      router.receive(
        {
          type: 'request:export-request',
          correlationId: `export-req-${Date.now()}`,
          payload: { path: relPath },
        },
        undefined as unknown as vscode.Webview,
      );
    }),
  );

  // volt.exportFolder — export all requests in a folder to .volt-collection.json
  context.subscriptions.push(
    vscode.commands.registerCommand('volt.exportFolder', (item: unknown) => {
      output.appendLine('[Volt] Command: volt.exportFolder');
      if (!item || typeof item !== 'object' || !('label' in item)) return;
      const folderName = String((item as { label: unknown }).label);
      router.receive(
        {
          type: 'request:export-folder',
          correlationId: `export-folder-${Date.now()}`,
          payload: { folder: folderName },
        },
        undefined as unknown as vscode.Webview,
      );
    }),
  );

  // volt.import — import a .volt-request.json or .volt-collection.json
  context.subscriptions.push(
    vscode.commands.registerCommand('volt.import', () => {
      output.appendLine('[Volt] Command: volt.import');
      router.receive(
        {
          type: 'request:import',
          correlationId: `import-${Date.now()}`,
        },
        undefined as unknown as vscode.Webview,
      );
    }),
  );

  // volt.importPostman — import a Postman v2.1 collection JSON
  context.subscriptions.push(
    vscode.commands.registerCommand('volt.importPostman', async () => {
      output.appendLine('[Volt] Command: volt.importPostman');

      if (!collectionService || !environmentService) {
        vscode.window.showWarningMessage('Volt: Open a folder to import a Postman collection.');
        return;
      }

      const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Import',
        filters: { 'Postman Collection': ['json'] },
        title: 'Import Postman Collection',
      });

      if (!uris || uris.length === 0) return;

      const filePath = uris[0]?.fsPath;
      if (!filePath) return;

      try {
        const result = await importPostmanCollection(
          filePath,
          collectionService,
          environmentService,
          output,
        );

        treeProvider.refresh();

        await vscode.window.showInformationMessage(
          `Volt: Imported ${result.requests} request${result.requests !== 1 ? 's' : ''}, ` +
          `${result.folders} folder${result.folders !== 1 ? 's' : ''}, ` +
          `${result.variables} variable${result.variables !== 1 ? 's' : ''}.`,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        output.appendLine(`[Volt] ERROR in importPostman: ${msg}`);
        await vscode.window.showErrorMessage(`Volt: Postman import failed — ${msg}`);
      }
    }),
  );

  // volt.duplicateRequest — duplicate a request in the same folder
  context.subscriptions.push(
    vscode.commands.registerCommand('volt.duplicateRequest', async (item: unknown) => {
      output.appendLine('[Volt] Command: volt.duplicateRequest');
      if (!collectionService) return;
      if (!item || typeof item !== 'object' || !('requestPath' in item)) return;
      const relPath = String((item as { requestPath: unknown }).requestPath);
      try {
        const request = await collectionService.loadRequest(relPath);
        if (!request) return;
        // Find a unique name by appending -copy, -copy-2, etc.
        let copyPath = `${relPath}-copy`;
        let attempt = 1;
        while (true) {
          try {
            await collectionService.loadRequest(copyPath);
            // Exists — try next suffix
            attempt++;
            copyPath = `${relPath}-copy-${attempt}`;
          } catch {
            break; // Doesn't exist — use this path
          }
        }
        await collectionService.saveRequest(copyPath, {
          ...request,
          id: copyPath,
          name: (request.name ?? relPath.split('/').pop() ?? '') + ' (copy)',
        });
        treeProvider.refresh();
      } catch (err: unknown) {
        output.appendLine(`[Volt] ERROR in duplicateRequest: ${String(err)}`);
      }
    }),
  );

  // volt.duplicateFolder — duplicate an entire folder with all requests
  context.subscriptions.push(
    vscode.commands.registerCommand('volt.duplicateFolder', async (item: unknown) => {
      output.appendLine('[Volt] Command: volt.duplicateFolder');
      if (!collectionService) return;
      if (!item || typeof item !== 'object' || !('label' in item)) return;
      const folderName = String((item as { label: unknown }).label);
      try {
        // Find a unique folder name
        const fs = await import('fs');
        const path = await import('path');
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) return;
        let copyFolder = `${folderName}-copy`;
        let attempt = 1;
        while (fs.existsSync(path.join(workspaceRoot, '.volt', 'requests', copyFolder))) {
          attempt++;
          copyFolder = `${folderName}-copy-${attempt}`;
        }
        // Create the folder
        await collectionService.createFolder(copyFolder);
        // Load all requests from the source folder and save to the copy
        const tree = await collectionService.loadTree();
        const folderNode = tree.nodes.find(
          (n) => n.kind === 'folder' && n.name === folderName,
        );
        if (folderNode && folderNode.kind === 'folder') {
          for (const child of folderNode.children) {
            if (child.kind === 'request') {
              const req = await collectionService.loadRequest(child.path);
              if (req) {
                const newPath = `${copyFolder}/${child.name}`;
                await collectionService.saveRequest(newPath, { ...req, id: newPath });
              }
            }
          }
        }
        treeProvider.refresh();
      } catch (err: unknown) {
        output.appendLine(`[Volt] ERROR in duplicateFolder: ${String(err)}`);
      }
    }),
  );

  // volt.renameRequest — rename a request YAML file from the tree context menu
  context.subscriptions.push(
    vscode.commands.registerCommand('volt.renameRequest', async (item: unknown) => {
      output.appendLine('[Volt] Command: volt.renameRequest');
      if (!collectionService) return;
      if (!item || typeof item !== 'object' || !('requestPath' in item)) return;
      const relPath = String((item as { requestPath: unknown }).requestPath);

      // Current base name (no folder prefix) used as default in the input box
      const currentName = relPath.split('/').pop() ?? relPath;

      const newName = await vscode.window.showInputBox({
        prompt: 'New request name',
        value: currentName,
        valueSelection: [0, currentName.length],
        validateInput: (value) => {
          if (!value || value.trim() === '') return 'Name cannot be empty';
          if (/[/\\]/.test(value)) return 'Name cannot contain path separators';
          return undefined;
        },
      });

      if (!newName || newName.trim() === '' || newName.trim() === currentName) return;

      // Build new path: keep folder prefix if present
      const folderPrefix = relPath.includes('/')
        ? relPath.slice(0, relPath.lastIndexOf('/') + 1)
        : '';
      const newRelPath = `${folderPrefix}${newName.trim()}`;

      try {
        await collectionService.renameRequest(relPath, newRelPath);
        treeProvider.refresh();
        // If the renamed request was open in the webview, push the updated definition
        setTimeout(() => router.pushRequest(newRelPath), 100);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        output.appendLine(`[Volt] ERROR in renameRequest: ${msg}`);
        await vscode.window.showErrorMessage(`Volt: ${msg}`);
      }
    }),
  );

  // volt.copyAsCurl — build a cURL command from a saved request and copy to clipboard
  context.subscriptions.push(
    vscode.commands.registerCommand('volt.copyAsCurl', async (item: unknown) => {
      output.appendLine('[Volt] Command: volt.copyAsCurl');
      if (!collectionService) return;
      if (!item || typeof item !== 'object' || !('requestPath' in item)) return;
      const relPath = String((item as { requestPath: unknown }).requestPath);

      try {
        const request = await collectionService.loadRequest(relPath);

        // Resolve environment variables if environment service is available
        let resolved = request;
        if (environmentService && typeof environmentService.resolveRequest === 'function') {
          resolved = await environmentService.resolveRequest(request) ?? request;
        }

        const curlCmd = buildCurlCommand(resolved);
        await vscode.env.clipboard.writeText(curlCmd);
        await vscode.window.showInformationMessage('Volt: cURL copied to clipboard.');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        output.appendLine(`[Volt] ERROR in copyAsCurl: ${msg}`);
        await vscode.window.showErrorMessage(`Volt: Failed to copy as cURL — ${msg}`);
      }
    }),
  );

  // volt.runCollection — run all requests in a folder sequentially (Feature 7)
  context.subscriptions.push(
    vscode.commands.registerCommand('volt.runCollection', async (item: unknown) => {
      output.appendLine('[Volt] Command: volt.runCollection');

      if (!collectionService) {
        vscode.window.showWarningMessage('Volt: Open a folder to run a collection.');
        return;
      }

      // Item may come from the tree context menu or be undefined (command palette)
      let folderName: string | undefined;
      if (item && typeof item === 'object' && 'label' in item) {
        folderName = String((item as { label: unknown }).label);
      } else {
        // Command palette: ask the user to pick a folder
        const tree = await collectionService.loadTree();
        const folders = tree.nodes
          .filter((n) => n.kind === 'folder')
          .map((n) => n.name);

        if (folders.length === 0) {
          vscode.window.showWarningMessage('Volt: No folders found in the collection.');
          return;
        }

        folderName = await vscode.window.showQuickPick(folders, {
          placeHolder: 'Select a folder to run',
          title: 'Volt: Run Collection',
        });
      }

      if (!folderName) return;

      const folder = folderName;

      // Open the webview so the runner panel is visible
      webviewProvider.openPanel();

      // Dispatch the run-collection message through the router
      router.receive(
        {
          type: 'request:run-collection',
          correlationId: `run-collection-${Date.now()}`,
          payload: { folder, delay: 0 },
        },
        undefined as unknown as vscode.Webview,
      );
    }),
  );

  // volt.clearCookies — clear the in-memory cookie jar (Feature 8)
  context.subscriptions.push(
    vscode.commands.registerCommand('volt.clearCookies', () => {
      output.appendLine('[Volt] Command: volt.clearCookies');
      router.receive(
        {
          type: 'request:clear-cookies',
          correlationId: `clear-cookies-${Date.now()}`,
        },
        undefined as unknown as vscode.Webview,
      );
      vscode.window.showInformationMessage('Volt: Cookie jar cleared.');
    }),
  );

  // 7. Panel serializer — restores panels across VS Code restarts (REQ-EXT-003)
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(PANEL_VIEW_TYPE, webviewProvider),
  );

  // 7a. Status bar item — shows active environment; clicking opens env switcher
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBarItem.text = '$(zap) Volt';
  statusBarItem.tooltip = 'Volt: No environment active — click to switch';
  statusBarItem.command = 'volt.switchEnvironment';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Refresh status bar text whenever the active environment changes
  const updateStatusBar = (): void => {
    if (!environmentService) return;
    environmentService.getResolved().then((env) => {
      if (env.active) {
        statusBarItem.text = `$(zap) Volt: ${env.active}`;
        statusBarItem.tooltip = `Volt active environment: ${env.active} — click to switch`;
      } else {
        statusBarItem.text = '$(zap) Volt';
        statusBarItem.tooltip = 'Volt: No environment active — click to switch';
      }
    }).catch(() => { /* ignore errors in status bar update */ });
  };

  // Immediate callback from the router on env switch (fired from webview UI)
  router.onEnvironmentChanged = (envName) => {
    statusBarItem.text = `$(zap) Volt: ${envName}`;
    statusBarItem.tooltip = `Volt active environment: ${envName} — click to switch`;
  };

  // Initial update (env files may not be loaded yet — use a short delay)
  setTimeout(updateStatusBar, 500);

  // Re-update whenever collection changes (env might have been created)
  if (collectionService) {
    context.subscriptions.push(
      collectionService.onDidChange(() => {
        setTimeout(updateStatusBar, 200);
      }),
    );
  }

  // 8. Tree view registration (REQ-EXT-004) — with DnD controller
  const treeView = vscode.window.createTreeView('volt.collectionTree', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
    dragAndDropController: treeProvider,
  });
  context.subscriptions.push(treeView);

  // 9. Unhandled rejection guard — catch any forgotten void promises and log
  //    them to the Volt output channel rather than silently swallowing them
  //    (REQ-MSG-002 — graceful crash recovery).
  const rejectionHandler = (reason: unknown): void => {
    const msg = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
    output.appendLine(`[Volt] Unhandled rejection: ${msg}`);
  };
  process.on('unhandledRejection', rejectionHandler);
  context.subscriptions.push({
    dispose: () => process.off('unhandledRejection', rejectionHandler),
  });

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
