import type { TreeDataProvider, TreeItem } from 'vscode'
import { commands, EventEmitter, TreeItemCollapsibleState, Uri, window } from 'vscode'
import { SSHConfigFileItem } from '../models/SSHConfigFileItem'
import { SSHFolderItem } from '../models/SSHFolderItem'
import { SSHHostItem } from '../models/SSHHostItem'
import { getSSHConfigFiles } from '../utils/sshConfig'
import { getCurrentSSHFolder, getCurrentSSHHost } from '../utils/sshDetection'
import { getRecentSSHConnections } from '../utils/sshHistory'

export class SSHExplorerProvider implements TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new EventEmitter<TreeItem | undefined | null | void>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  private configFilesCache: SSHConfigFileItem[] = []
  private hostsCache: Map<string, SSHHostItem[]> = new Map()
  private recentFolders: Map<string, string[]> = new Map()
  private collapsedHosts: Set<string> = new Set()
  private collapsedConfigFiles: Set<string> = new Set()
  private recentFoldersLoaded = false
  private currentHostCache: string | undefined

  refresh(): void {
    this.configFilesCache = []
    this.hostsCache.clear()
    this.recentFolders.clear()
    this.recentFoldersLoaded = false
    this.currentHostCache = undefined
    this._onDidChangeTreeData.fire()
  }

  collapseAll(): void {
    // Mark all config files as collapsed
    this.configFilesCache.forEach(file => this.collapsedConfigFiles.add(file.filePath))
    // Mark all hosts as collapsed
    this.hostsCache.forEach(hosts =>
      hosts.forEach(host => this.collapsedHosts.add(host.hostName)),
    )
    // Clear caches to force recreation with new state
    this.configFilesCache = []
    this.hostsCache.clear()
    this._onDidChangeTreeData.fire()
  }

  expandAll(): void {
    // Clear all collapsed states
    this.collapsedConfigFiles.clear()
    this.collapsedHosts.clear()
    // Clear caches to force recreation with new state
    this.configFilesCache = []
    this.hostsCache.clear()
    this._onDidChangeTreeData.fire()
  }

  async getConfigFiles(): Promise<SSHConfigFileItem[]> {
    if (this.configFilesCache.length > 0)
      return this.configFilesCache

    const configFiles = await getSSHConfigFiles()
    this.configFilesCache = configFiles.map(file =>
      new SSHConfigFileItem(
        file.path,
        file.label,
        file.hosts.length,
        this.collapsedConfigFiles.has(file.path),
      ),
    )

    // Start loading current host in background
    this.loadCurrentHostInBackground()

    return this.configFilesCache
  }

  private async loadCurrentHostInBackground(): Promise<void> {
    if (!this.currentHostCache) {
      this.currentHostCache = await getCurrentSSHHost()
      // Clear hosts cache to force recreation with connection status
      if (this.currentHostCache) {
        this.hostsCache.clear()
        this._onDidChangeTreeData.fire()
      }
    }
  }

  private async loadRecentFoldersInBackground(): Promise<void> {
    if (!this.recentFoldersLoaded) {
      this.recentFolders = await getRecentSSHConnections()
      this.recentFoldersLoaded = true
      // Clear hosts cache to force recreation with folder info
      this.hostsCache.clear()
      // Refresh to update folder indicators
      this._onDidChangeTreeData.fire()
    }
  }

  async getHostsForConfig(configFile: SSHConfigFileItem): Promise<SSHHostItem[]> {
    // Return cached if available
    if (this.hostsCache.has(configFile.filePath))
      return this.hostsCache.get(configFile.filePath)!

    const configFiles = await getSSHConfigFiles()
    const config = configFiles.find(f => f.path === configFile.filePath)
    if (!config)
      return []

    // Get current host (use cache if available)
    const currentHost = this.currentHostCache || await getCurrentSSHHost()
    if (!this.currentHostCache)
      this.currentHostCache = currentHost

    // Create hosts without waiting for recent folders
    const hosts = config.hosts.map((e) => {
      const hasRecent = this.recentFolders.has(e.host) || this.recentFolders.has(e.hostname || '')
      const isConnected = currentHost
        ? (e.host.toLowerCase() === currentHost.toLowerCase()
          || Boolean(e.hostname && e.hostname.toLowerCase() === currentHost.toLowerCase()))
        : false
      const isCollapsed = this.collapsedHosts.has(e.host)

      return new SSHHostItem(
        e.host,
        e.hostname,
        e.configFile || configFile.filePath,
        e.lineNumber,
        hasRecent,
        isConnected,
        isCollapsed,
      )
    })

    this.hostsCache.set(configFile.filePath, hosts)

    // Load recent folders in background
    if (!this.recentFoldersLoaded) {
      this.loadRecentFoldersInBackground()
    }

    return hosts
  }

  findHostItem(hostName: string): SSHHostItem | undefined {
    for (const hosts of this.hostsCache.values()) {
      const found = hosts.find(h => h.hostName === hostName)
      if (found)
        return found
    }
    return undefined
  }

  getTreeItem(element: TreeItem): TreeItem {
    return element
  }

  getParent(element: TreeItem): TreeItem | undefined {
    if (element instanceof SSHFolderItem) {
      for (const hosts of this.hostsCache.values()) {
        const found = hosts.find(h => h.hostName === element.hostName)
        if (found)
          return found
      }
    }
    if (element instanceof SSHHostItem) {
      return this.configFilesCache.find(f => f.filePath === element.configFile)
    }
    return undefined
  }

  async getChildren(element?: TreeItem): Promise<TreeItem[]> {
    if (!element)
      return this.getConfigFiles()

    if (element instanceof SSHConfigFileItem)
      return this.getHostsForConfig(element)

    if (element instanceof SSHHostItem) {
      // Ensure recent folders are loaded
      if (!this.recentFoldersLoaded) {
        await this.loadRecentFoldersInBackground()
      }

      const folders = this.recentFolders.get(element.hostName)
        || this.recentFolders.get(element.description || '')
        || []

      if (folders.length === 0)
        return []

      const currentHost = this.currentHostCache || await getCurrentSSHHost()
      const currentFolder = getCurrentSSHFolder()
      const isThisHostConnected = element.hostName === currentHost || element.description === currentHost

      return folders.map((folder) => {
        const isFolderConnected = isThisHostConnected && currentFolder === folder
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
    const folderUri = Uri.parse(`vscode-remote://ssh-remote+${encodeURIComponent(hostName)}${folder}`)

    await window.withProgress(
      {
        location: 15,
        title: `Opening ${hostName}:${folder}...`,
      },
      async () => {
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

export async function openConfigFile(filePath: string, lineNumber?: number): Promise<void> {
  try {
    const uri = Uri.file(filePath)
    const document = await window.showTextDocument(uri)

    if (lineNumber && lineNumber > 0) {
      const position = document.document.lineAt(lineNumber - 1).range.start
      document.selection = new (await import('vscode')).Selection(position, position)
      document.revealRange(document.document.lineAt(lineNumber - 1).range)
    }
  }
  catch (error) {
    window.showErrorMessage(`Failed to open config file: ${error instanceof Error ? error.message : String(error)}`)
  }
}
