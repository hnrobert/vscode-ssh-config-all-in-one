import type { TreeDataProvider, TreeItem } from 'vscode'
import { commands, EventEmitter, TreeItemCollapsibleState, Uri, window } from 'vscode'
import { SSHFolderItem } from '../models/SSHFolderItem'
import { SSHHostItem } from '../models/SSHHostItem'
import { parseSSHConfig } from '../utils/sshConfig'
import { getCurrentSSHFolder, getCurrentSSHHost } from '../utils/sshDetection'
import { getRecentSSHConnections } from '../utils/sshHistory'

export class SSHExplorerProvider implements TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new EventEmitter<TreeItem | undefined | null | void>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  private hostsCache: SSHHostItem[] = []
  private recentFolders: Map<string, string[]> = new Map()
  private collapsedHosts: Set<string> = new Set()

  refresh(): void {
    // // console.log('[SSH Explorer] Refresh triggered')
    this.hostsCache = []
    this.recentFolders.clear()
    this._onDidChangeTreeData.fire()
  }

  collapseAll(): void {
    // Mark all hosts as collapsed
    this.hostsCache.forEach(host => this.collapsedHosts.add(host.hostName))
    this._onDidChangeTreeData.fire()
  }

  expandAll(): void {
    // Clear all collapsed hosts
    this.collapsedHosts.clear()
    this._onDidChangeTreeData.fire()
  }

  isAllCollapsed(): boolean {
    return this.hostsCache.length > 0 && this.hostsCache.every(host =>
      host.collapsibleState === TreeItemCollapsibleState.None || this.collapsedHosts.has(host.hostName),
    )
  }

  async getHosts(): Promise<SSHHostItem[]> {
    // // console.log('[SSH Explorer] Getting hosts...')
    const entries = await parseSSHConfig()
    const currentHost = await getCurrentSSHHost()
    this.recentFolders = await getRecentSSHConnections()

    // // console.log(`[SSH Explorer] Current SSH host from env.remoteName: "${currentHost}"`)
    // // console.log(`[SSH Explorer] env.remoteName raw value: "${env.remoteName}"`)
    // // console.log(`[SSH Explorer] Found ${entries.length} hosts in SSH config`)

    this.hostsCache = entries.map((e) => {
      const hasRecent = this.recentFolders.has(e.host) || this.recentFolders.has(e.hostname || '')
      // Case-insensitive comparison for hostname matching
      const isConnected = currentHost
        ? (e.host.toLowerCase() === currentHost.toLowerCase()
          || Boolean(e.hostname && e.hostname.toLowerCase() === currentHost.toLowerCase()))
        : false
      const isCollapsed = this.collapsedHosts.has(e.host)

      // // console.log(`[SSH Explorer] Host ${e.host} (${e.hostname}): hasRecent=${hasRecent}, isConnected=${isConnected}, isCollapsed=${isCollapsed}`)
      // if (currentHost) {
      //   // console.log(`  Comparing: "${e.host}" vs "${currentHost}" = ${e.host.toLowerCase() === currentHost.toLowerCase()}`)
      //   // console.log(`  Comparing: "${e.hostname}" vs "${currentHost}" = ${e.hostname?.toLowerCase() === currentHost.toLowerCase()}`)
      // }

      return new SSHHostItem(
        e.host,
        e.hostname,
        hasRecent,
        isConnected,
        isCollapsed,
      )
    })
    return this.hostsCache
  }

  findHostItem(hostName: string): SSHHostItem | undefined {
    return this.hostsCache.find(h => h.hostName === hostName)
  }

  getTreeItem(element: TreeItem): TreeItem {
    return element
  }

  getParent(element: TreeItem): TreeItem | undefined {
    if (element instanceof SSHFolderItem)
      return this.hostsCache.find(h => h.hostName === element.hostName)
    return undefined
  }

  async getChildren(element?: TreeItem): Promise<TreeItem[]> {
    if (!element)
      return this.getHosts()

    if (element instanceof SSHHostItem) {
      // Get recent folders for this host from VS Code storage
      const folders = this.recentFolders.get(element.hostName)
        || this.recentFolders.get(element.description || '')
        || []

      // // console.log(`[SSH Explorer] Getting children for host ${element.hostName}: ${folders.length} folders`)

      if (folders.length === 0)
        return []

      // Check if we're currently connected to this host and which folder
      const currentHost = await getCurrentSSHHost()
      const currentFolder = getCurrentSSHFolder()
      const isThisHostConnected = element.hostName === currentHost || element.description === currentHost

      // // console.log(`[SSH Explorer] Current host: ${currentHost}, Current folder: ${currentFolder}`)
      // // console.log(`[SSH Explorer] This host: ${element.hostName}, isThisHostConnected: ${isThisHostConnected}`)

      return folders.map((folder) => {
        const isFolderConnected = isThisHostConnected && currentFolder === folder
        // // console.log(`[SSH Explorer] Folder ${folder}: isConnected=${isFolderConnected} (currentFolder=${currentFolder})`)
        return new SSHFolderItem(element.hostName, folder, isFolderConnected)
      })
    }

    return []
  }
}

export async function connectHost(
  hostName: string,
  provider: SSHExplorerProvider,
  reuseWindow: boolean,
): Promise<void> {
  const command = reuseWindow
    ? 'opensshremotes.openEmptyWindowInCurrentWindow'
    : 'opensshremotes.openEmptyWindow'

  try {
    await window.withProgress(
      {
        location: 15,
        title: `Connecting to ${hostName}...`,
      },
      () => commands.executeCommand(command, { host: hostName }),
    )
  }
  catch {
    await commands.executeCommand('vscode.newWindow', {
      remoteAuthority: `ssh-remote+${hostName}`,
      reuseWindow,
    })
  }

  provider.refresh()
}

export async function connectFolder(
  hostName: string,
  folder: string,
  provider: SSHExplorerProvider,
  reuseWindow: boolean,
): Promise<void> {
  try {
    // Construct the remote URI
    const folderUri = Uri.parse(`vscode-remote://ssh-remote+${encodeURIComponent(hostName)}${folder}`)

    await window.withProgress(
      {
        location: 15,
        title: `Opening ${hostName}:${folder}...`,
      },
      async () => {
        // Use vscode.openFolder to open the remote folder
        await commands.executeCommand('vscode.openFolder', folderUri, {
          forceNewWindow: !reuseWindow,
        })
      },
    )
  }
  catch (error) {
    window.showErrorMessage(`Failed to open folder: ${error instanceof Error ? error.message : String(error)}`)
  }

  provider.refresh()
}
