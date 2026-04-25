import type { Disposable, ExtensionContext } from 'vscode'
import { commands, Position, SnippetString, Uri, window, workspace } from 'vscode'
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

  // Collapse/expand all
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
        const input = await window.showInputBox({
          prompt: 'Enter SSH connection command or host alias',
          placeHolder: 'user@hostname',
          title: 'Add New SSH Host',
        })
        if (!input)
          return

        const parsed = parseSSHInput(input)

        const doc = await workspace.openTextDocument(Uri.file(item.filePath))
        const editor = await window.showTextDocument(doc)

        const lastLine = doc.lineAt(doc.lineCount - 1)
        const prefix = lastLine.text.trimEnd().length > 0 ? '\n\n' : '\n'

        const pos = new Position(doc.lineCount - 1, lastLine.text.length)
        await editor.insertSnippet(
          new SnippetString(`${prefix}${parsed.toSnippetString()}`),
          pos,
        )

        explorerProvider.refresh()
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

interface ParsedSSH {
  host: string
  hostname: string
  port?: string
  user?: string
  identityFile?: string
  toSnippetString: () => string
}

function parseSSHInput(input: string): ParsedSSH {
  const trimmed = input.trim()

  let user = ''
  let hostname = ''
  let port = ''
  let identityFile = ''
  let isSSHCommand = false

  // Split into tokens, handling ssh command prefix
  const tokens = trimmed.split(/\s+/)
  let i = 0

  if (tokens[0].toLowerCase() === 'ssh') {
    isSSHCommand = true
    i = 1
  }

  // Parse -flags first
  let destination = ''
  while (i < tokens.length) {
    const token = tokens[i]
    if (token === '-p' && tokens[i + 1]) {
      port = tokens[++i]
    }
    else if (token === '-i' && tokens[i + 1]) {
      identityFile = tokens[++i]
    }
    else if (token === '-l' && tokens[i + 1]) {
      user = tokens[++i]
    }
    else if (token.startsWith('-')) {
      // Skip unknown flag and its value
      i++
    }
    else {
      destination = token
    }
    i++
  }

  // If no destination from tokens (plain input without ssh prefix)
  if (!destination) {
    destination = isSSHCommand ? '' : trimmed
  }

  // Parse destination: [user@]hostname[:port]
  if (destination) {
    const atIndex = destination.lastIndexOf('@')
    if (atIndex > 0) {
      user = user || destination.slice(0, atIndex)
      destination = destination.slice(atIndex + 1)
    }

    // Check for :port suffix (port must be valid uint16)
    const lastColon = destination.lastIndexOf(':')
    if (lastColon > 0) {
      const maybePort = destination.slice(lastColon + 1)
      const portNum = Number.parseInt(maybePort, 10)
      if (Number.isInteger(portNum) && portNum > 0 && portNum <= 65535 && String(portNum) === maybePort) {
        port = port || maybePort
        destination = destination.slice(0, lastColon)
      }
    }

    hostname = destination
  }

  // Fallback: if nothing parsed, use raw input as host
  if (!hostname) {
    hostname = trimmed.replace(/^ssh\s+/i, '').trim()
  }

  const host = user ? `${user}@${hostname}` : hostname

  return {
    host,
    hostname,
    port: port || undefined,
    user: user || undefined,
    identityFile: identityFile || undefined,
    toSnippetString() {
      let snippet = `Host \${1:${host}}\n    HostName \${2:${hostname}}`
      if (user)
        snippet += `\n    User ${user}`
      if (port)
        snippet += `\n    Port ${port}`
      if (identityFile)
        snippet += `\n    IdentityFile ${identityFile}`
      // Add User placeholder only if not already set from input
      if (!user)
        snippet += `\n    User \${3}`
      snippet += '\n'
      return snippet
    },
  }
}
