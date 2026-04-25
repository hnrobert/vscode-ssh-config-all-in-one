import type { Disposable, ExtensionContext } from 'vscode'
import { commands, Position, Range, SnippetString, Uri, window, workspace } from 'vscode'
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
import { parseSSHConfig } from './utils/sshConfig'
import { getCurrentSSHHost } from './utils/sshDetection'

export function activate(context: ExtensionContext) {
  const subscriptions = context.subscriptions
  const disposable: Disposable[] = []

  // Tree view
  const explorerProvider = new SSHExplorerProvider()
  const treeView = window.createTreeView('vscode-ssh-config-all-in-one-hosts', {
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
      (hostOrItem: string | { hostName: string, configFile: string }, configFile?: string) => {
        const hostName = typeof hostOrItem === 'string' ? hostOrItem : hostOrItem.hostName
        const cfg = typeof hostOrItem === 'string' ? configFile : hostOrItem.configFile
        connectHost(hostName, explorerProvider, true, cfg)
      },
    ),
  )

  disposable.push(
    commands.registerCommand(
      'vscode-ssh-config-all-in-one.connectNewWindow',
      (hostOrItem: string | { hostName: string, configFile: string }, configFile?: string) => {
        const hostName = typeof hostOrItem === 'string' ? hostOrItem : hostOrItem.hostName
        const cfg = typeof hostOrItem === 'string' ? configFile : hostOrItem.configFile
        connectHost(hostName, explorerProvider, false, cfg)
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

  // Open extension settings
  disposable.push(
    commands.registerCommand('vscode-ssh-config-all-in-one.openSettings', () => {
      commands.executeCommand('workbench.action.openSettings', 'sshConfigAllInOne')
    }),
  )

  // SSH Explorer commands
  disposable.push(
    commands.registerCommand('vscode-ssh-config-all-in-one.refresh', () => {
      explorerProvider.refresh()
    }),
  )

  // Search hosts with live filtering
  disposable.push(
    commands.registerCommand('vscode-ssh-config-all-in-one.searchHosts', async () => {
      const allHosts = await parseSSHConfig()

      interface HostPickItem { label: string, description?: string, detail?: string, hostName: string, configFile?: string, lineNumber?: number }
      const toItem = (h: typeof allHosts[number]): HostPickItem => ({
        label: h.host,
        description: h.hostname,
        detail: h.configFile,
        hostName: h.host,
        configFile: h.configFile,
        lineNumber: h.lineNumber,
      })

      const allItems: HostPickItem[] = allHosts.map(toItem)

      const quickPick = window.createQuickPick<HostPickItem>()
      quickPick.placeholder = 'Search SSH hosts...'
      quickPick.matchOnDescription = true
      quickPick.matchOnDetail = true
      quickPick.items = allItems.slice(0, 10)

      quickPick.onDidChangeValue((value) => {
        if (!value) {
          quickPick.items = allItems.slice(0, 10)
          return
        }
        const lower = value.toLowerCase()
        const scored = allItems
          .map((item) => {
            const hostMatch = item.hostName.toLowerCase().includes(lower) ? 2 : 0
            const descMatch = (item.description ?? '').toLowerCase().includes(lower) ? 1 : 0
            return { item, score: hostMatch + descMatch }
          })
          .filter(s => s.score > 0)
          .sort((a, b) => b.score - a.score)
        quickPick.items = scored.slice(0, 10).map(s => s.item)
      })

      quickPick.onDidAccept(async () => {
        const selected = quickPick.selectedItems[0]
        quickPick.hide()

        if (!selected)
          return

        // Ensure explorer is loaded and reveal the host
        await commands.executeCommand('workbench.view.remote')
        await explorerProvider.getConfigFiles()
        const item = explorerProvider.findHostItem(selected.hostName)
        if (item) {
          await treeView.reveal(item, { expand: true, focus: true, select: true })
        }
        else if (selected.configFile && selected.lineNumber) {
          await openConfigFile(selected.configFile, selected.lineNumber)
        }
      })

      quickPick.show()
    }),
  )

  // Add config file from file picker
  disposable.push(
    commands.registerCommand('vscode-ssh-config-all-in-one.addConfigFile', async () => {
      const result = await window.showOpenDialog({
        title: 'Select SSH Config File',
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
      })
      if (!result || result.length === 0)
        return

      const filePath = result[0].fsPath
      const cfg = workspace.getConfiguration('sshConfigAllInOne.config')
      const current = cfg.get<string[]>('additionalFiles', [])

      // Dedup by resolved path
      if (current.includes(filePath))
        return

      await cfg.update('additionalFiles', [...current, filePath], true)
      explorerProvider.refresh()
    }),
  )

  // Collapse/expand all
  disposable.push(
    commands.registerCommand('vscode-ssh-config-all-in-one.toggleCollapseAll', () => {
      explorerProvider.collapseAll()
      commands.executeCommand('setContext', 'vscode-ssh-config-all-in-one.allCollapsed', true)
    }),
  )

  disposable.push(
    commands.registerCommand('vscode-ssh-config-all-in-one.toggleExpandAll', () => {
      explorerProvider.expandAll()
      commands.executeCommand('setContext', 'vscode-ssh-config-all-in-one.allCollapsed', false)
    }),
  )

  // Initialize context
  commands.executeCommand('setContext', 'vscode-ssh-config-all-in-one.allCollapsed', false)

  // Locate current remote host in explorer
  disposable.push(
    commands.registerCommand('vscode-ssh-config-all-in-one.locateCurrentHost', async () => {
      const hostName = await getCurrentSSHHost()
      if (!hostName)
        return

      await commands.executeCommand('workbench.view.remote')
      await explorerProvider.getConfigFiles()

      const item = explorerProvider.findHostItem(hostName)
      if (item) {
        await treeView.reveal(item, {
          expand: true,
          focus: true,
          select: true,
        })
      }
    }),
  )

  // Update hasRemote context when workspace changes
  const updateRemoteContext = async () => {
    const host = await getCurrentSSHHost()
    commands.executeCommand('setContext', 'vscode-ssh-config-all-in-one.hasRemote', !!host)
  }
  updateRemoteContext()
  disposable.push(workspace.onDidChangeWorkspaceFolders(() => updateRemoteContext()))

  disposable.push(
    commands.registerCommand(
      'vscode-ssh-config-all-in-one.connectFolderCurrentWindow',
      (item: { hostName: string, folder: string, configFile?: string }) => {
        connectFolder(item.hostName, item.folder, explorerProvider, true, item.configFile)
      },
    ),
  )

  disposable.push(
    commands.registerCommand(
      'vscode-ssh-config-all-in-one.connectFolderNewWindow',
      (item: { hostName: string, folder: string, configFile?: string }) => {
        connectFolder(item.hostName, item.folder, explorerProvider, false, item.configFile)
      },
    ),
  )

  disposable.push(
    commands.registerCommand(
      'vscode-ssh-config-all-in-one.revealHost',
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
      'vscode-ssh-config-all-in-one.openConfigFile',
      (item: { filePath: string }) => {
        openConfigFile(item.filePath)
      },
    ),
  )

  disposable.push(
    commands.registerCommand(
      'vscode-ssh-config-all-in-one.addNewHost',
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
      'vscode-ssh-config-all-in-one.openHostInConfig',
      (item: { configFile: string, lineNumber?: number }) => {
        openConfigFile(item.configFile, item.lineNumber)
      },
    ),
  )

  // Send public key to host
  disposable.push(
    commands.registerCommand(
      'vscode-ssh-config-all-in-one.sendPublicKey',
      (item: { hostName: string }) => {
        copyPublicKey(item.hostName)
      },
    ),
  )

  // Remove host from config file
  disposable.push(
    commands.registerCommand(
      'vscode-ssh-config-all-in-one.removeHost',
      async (item: { hostName: string, configFile: string, lineNumber?: number }) => {
        const confirm = await window.showWarningMessage(
          `Remove host "${item.hostName}"?`,
          { modal: true },
          'Remove',
        )
        if (confirm !== 'Remove')
          return

        const doc = await workspace.openTextDocument(Uri.file(item.configFile))
        const editor = await window.showTextDocument(doc)

        // Find the Host block boundaries
        const startLine = (item.lineNumber ?? 1) - 1
        let endLine = startLine + 1
        while (endLine < doc.lineCount) {
          const trimmed = doc.lineAt(endLine).text.trim()
          if (trimmed === '' || trimmed.startsWith('Host ') || trimmed.startsWith('Match '))
            break
          endLine++
        }

        // Remove lines from startLine to endLine-1 (inclusive)
        const range = new Range(startLine, 0, endLine, 0)
        await editor.edit(builder => builder.delete(range))
        await doc.save()

        explorerProvider.refresh()
      },
    ),
  )

  // Remove folder from recent list
  disposable.push(
    commands.registerCommand(
      'vscode-ssh-config-all-in-one.removeRecentFolder',
      async (item: { hostName: string, folder: string }) => {
        explorerProvider.removeRecentFolder(item.hostName, item.folder)
      },
    ),
  )

  // Test SSH connection
  disposable.push(
    commands.registerCommand(
      'vscode-ssh-config-all-in-one.testConnection',
      async (hostNameOrItem: string | { hostName: string }) => {
        const hostName = typeof hostNameOrItem === 'string' ? hostNameOrItem : hostNameOrItem.hostName
        if (!hostName)
          return

        const result = await window.withProgress(
          { location: 15, title: `Testing connection to ${hostName}...` },
          () => testSSHConnection(hostName),
        )

        if (result === 'success') {
          window.showInformationMessage(`Connection to ${hostName} succeeded.`)
        }
        else if (result === 'timeout') {
          window.showWarningMessage(`Connection to ${hostName} timed out after 5s.`)
        }
        else {
          window.showErrorMessage(`Connection to ${hostName} failed: ${result}`)
        }
      },
    ),
  )

  // Ignore auto-discovered config file (add to exclude list)
  disposable.push(
    commands.registerCommand(
      'vscode-ssh-config-all-in-one.ignoreConfigFile',
      async (item: { filePath: string }) => {
        const cfg = workspace.getConfiguration('sshConfigAllInOne.config')
        const current = cfg.get<string[]>('excludeDefaultFiles', [])
        if (current.includes(item.filePath))
          return
        await cfg.update('excludeDefaultFiles', [...current, item.filePath], true)
        explorerProvider.refresh()
      },
    ),
  )

  // Remove manually added config file from list
  disposable.push(
    commands.registerCommand(
      'vscode-ssh-config-all-in-one.removeConfigFile',
      async (item: { filePath: string }) => {
        const cfg = workspace.getConfiguration('sshConfigAllInOne.config')
        const current = cfg.get<string[]>('additionalFiles', [])
        // Match either raw path or resolved path
        const filtered = current.filter(p => p !== item.filePath && p.replace(/^~/, '') !== item.filePath.replace(/^~/, ''))
        if (filtered.length === current.length)
          return
        await cfg.update('additionalFiles', filtered, true)
        explorerProvider.refresh()
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

async function testSSHConnection(hostName: string): Promise<string> {
  const { exec } = await import('node:child_process')

  const timeoutMs = 5000

  return new Promise<string>((resolve) => {
    const timer = setTimeout(() => {
      child.kill()
      resolve('timeout')
    }, timeoutMs)

    let child: import('node:child_process').ChildProcess
    try {
      child = exec(
        `ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=no "${hostName}" exit 0`,
        { timeout: timeoutMs },
        (error, _stdout, _stderr) => {
          clearTimeout(timer)
          if (!error) {
            resolve('success')
          }
          else if (error.killed) {
            resolve('timeout')
          }
          else if (typeof error.code === 'number' && error.code !== 255) {
            resolve('success')
          }
          else {
            const lines = error.message.split('\n').filter(l => !l.includes('WARNING:'))
            resolve(lines[0]?.trim() || 'connection refused')
          }
        },
      )
    }
    catch {
      clearTimeout(timer)
      resolve('failed to spawn ssh')
    }
  })
}
