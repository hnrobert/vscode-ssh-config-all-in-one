import type { Disposable, ExtensionContext } from 'vscode'
import { commands, window } from 'vscode'
import { copyPublicKey, openUserConfig } from './functions'
import {
  connectFolder,
  connectHost,
  openConfigFile,
  SSHCodeLensProvider,
  SSHCompletionItemsProvider,
  SSHDocumentLinkProvider,
  SSHExplorerProvider,
  SSHFormatProvider,
  SSHHoverProvider,
} from './providers'

export function activate(context: ExtensionContext) {
  const subscriptions = context.subscriptions
  const disposable: Disposable[] = []

  // Tree view
  const explorerProvider = new SSHExplorerProvider()
  const treeView = window.createTreeView('ssh-explorer-hosts', {
    treeDataProvider: explorerProvider,
    showCollapseAll: false,
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
            commands.executeCommand('vscode.newWindow', {
              remoteAuthority: `ssh-remote+${hostStr}`,
              reuseWindow: true,
            })
          })
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
            commands.executeCommand('vscode.newWindow', {
              remoteAuthority: `ssh-remote+${hostStr}`,
              reuseWindow: false,
            })
          })
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

  // Track collapse/expand state
  disposable.push(
    commands.registerCommand('ssh-explorer.toggleCollapseAll', () => {
      explorerProvider.collapseAll()
      commands.executeCommand('setContext', 'ssh-explorer.allCollapsed', true)
    }),
  )

  disposable.push(
    commands.registerCommand('ssh-explorer.toggleExpandAll', () => {
      explorerProvider.expandAll()
      commands.executeCommand('setContext', 'ssh-explorer.allCollapsed', false)
    }),
  )

  // Initialize context
  commands.executeCommand('setContext', 'ssh-explorer.allCollapsed', false)

  disposable.push(
    commands.registerCommand(
      'ssh-explorer.connectCurrentWindow',
      (item: { hostName: string }) => {
        connectHost(item.hostName, explorerProvider, true)
      },
    ),
  )

  disposable.push(
    commands.registerCommand(
      'ssh-explorer.connectNewWindow',
      (item: { hostName: string }) => {
        connectHost(item.hostName, explorerProvider, false)
      },
    ),
  )

  disposable.push(
    commands.registerCommand(
      'ssh-explorer.connectFolderCurrentWindow',
      (item: { hostName: string, folder: string }) => {
        connectFolder(item.hostName, item.folder, explorerProvider, true)
      },
    ),
  )

  disposable.push(
    commands.registerCommand(
      'ssh-explorer.connectFolderNewWindow',
      (item: { hostName: string, folder: string }) => {
        connectFolder(item.hostName, item.folder, explorerProvider, false)
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

          // Refresh and find host
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

  // New commands for config file management
  disposable.push(
    commands.registerCommand(
      'ssh-explorer.openConfigFile',
      (item: { filePath: string }) => {
        openConfigFile(item.filePath)
      },
    ),
  )

  disposable.push(
    commands.registerCommand(
      'ssh-explorer.addNewHost',
      async (item: { filePath: string }) => {
        await openConfigFile(item.filePath)
        // TODO: Insert template at end of file
      },
    ),
  )

  disposable.push(
    commands.registerCommand(
      'ssh-explorer.openHostInConfig',
      (item: { configFile: string, lineNumber?: number }) => {
        openConfigFile(item.configFile, item.lineNumber)
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
