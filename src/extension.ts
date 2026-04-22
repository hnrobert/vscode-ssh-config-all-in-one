import type { Disposable, ExtensionContext } from 'vscode'
import { commands, Uri, window } from 'vscode'
import { copyPublicKey, openUserConfig } from './functions'
import {
  connectFolder,
  connectHost,
  RecentConnectionsManager,
  SSHCodeLensProvider,
  SSHCompletionItemsProvider,
  SSHDocumentLinkProvider,
  SSHExplorerProvider,
  SSHFormatProvider,
  SSHHoverProvider,
} from './providers'

/**
 * Activates the extension.
 *
 * @param context - The extension context.
 */
export function activate(context: ExtensionContext) {
  const subscriptions = context.subscriptions
  const disposable: Disposable[] = []

  // Recent connections & tree view
  const recentManager = new RecentConnectionsManager(context)
  const explorerProvider = new SSHExplorerProvider(recentManager)
  const treeView = window.createTreeView('ssh-explorer-hosts', {
    treeDataProvider: explorerProvider,
    showCollapseAll: true,
  })
  disposable.push(treeView)

  disposable.push(
    commands.registerCommand(
      'vscode-ssh-config-all-in-one.openUserConfig',
      () => openUserConfig(),
    ),
  )

  disposable.push(
    commands.registerCommand(
      'vscode-ssh-config-all-in-one.connectCurrentWindow',
      (hostStr: string) => {
        commands
          .executeCommand('opensshremotes.openEmptyWindowInCurrentWindow', {
            host: hostStr,
          })
          .then(undefined, () => {
            // Fallback if the remote extension changes its API
            commands.executeCommand('vscode.newWindow', {
              remoteAuthority: `ssh-remote+${hostStr}`,
              reuseWindow: true,
            })
          })
        recentManager.add(hostStr)
      },
    ),
  )

  disposable.push(
    commands.registerCommand(
      'vscode-ssh-config-all-in-one.connectNewWindow',
      (hostStr: string) => {
        commands
          .executeCommand('opensshremotes.openEmptyWindow', { host: hostStr })
          .then(undefined, () => {
            // Fallback
            commands.executeCommand('vscode.newWindow', {
              remoteAuthority: `ssh-remote+${hostStr}`,
              reuseWindow: false,
            })
          })
        recentManager.add(hostStr)
      },
    ),
  )

  disposable.push(
    commands.registerCommand(
      'vscode-ssh-config-all-in-one.copyPublicKey',
      (hostStr: string) => {
        copyPublicKey(hostStr)
      },
    ),
  )

  // SSH Explorer commands
  disposable.push(
    commands.registerCommand('ssh-explorer.refresh', () => {
      explorerProvider.refresh()
    }),
  )

  disposable.push(
    commands.registerCommand(
      'ssh-explorer.connectCurrentWindow',
      (item: { hostName: string }) => {
        connectHost(item.hostName, recentManager, explorerProvider, true)
      },
    ),
  )

  disposable.push(
    commands.registerCommand(
      'ssh-explorer.connectNewWindow',
      (item: { hostName: string }) => {
        connectHost(item.hostName, recentManager, explorerProvider, false)
      },
    ),
  )

  disposable.push(
    commands.registerCommand(
      'ssh-explorer.connectFolderCurrentWindow',
      (item: { hostName: string, description: string }) => {
        connectFolder(item.hostName, item.description, recentManager, explorerProvider, true)
      },
    ),
  )

  disposable.push(
    commands.registerCommand(
      'ssh-explorer.connectFolderNewWindow',
      (item: { hostName: string, description: string }) => {
        connectFolder(item.hostName, item.description, recentManager, explorerProvider, false)
      },
    ),
  )

  disposable.push(
    commands.registerCommand(
      'ssh-explorer.revealHost',
      async (hostName: string) => {
        try {
          // Ensure the Remote Explorer view is visible
          await commands.executeCommand('workbench.view.remote')

          // Refresh and get hosts
          await explorerProvider.getHosts()
          const item = explorerProvider.findHostItem(hostName)

          if (item) {
            await treeView.reveal(item, {
              expand: true,
              focus: true,
              select: true,
            })
          }
          else {
            window.showWarningMessage(`Host "${hostName}" not found in SSH config`)
          }
        }
        catch (error) {
          window.showErrorMessage(`Failed to reveal host: ${error instanceof Error ? error.message : String(error)}`)
        }
      },
    ),
  )

  new SSHCompletionItemsProvider(disposable)
  new SSHHoverProvider(disposable)
  new SSHDocumentLinkProvider(disposable)
  new SSHFormatProvider(disposable)
  new SSHCodeLensProvider(disposable)

  subscriptions.push(...disposable)
}

export function deactivate() {
  // noop
}
