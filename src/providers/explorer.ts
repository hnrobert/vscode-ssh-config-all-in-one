import type { TreeDataProvider, TreeItem } from 'vscode'
import { commands, EventEmitter, languages, Uri, window, workspace } from 'vscode'
import { SSHConfigFileItem } from '../models/SSHConfigFileItem'
import { SSHFolderItem } from '../models/SSHFolderItem'
import { SSHHostItem } from '../models/SSHHostItem'
import { getSSHConfigFiles } from '../utils/sshConfig'
import { getCurrentSSHFolder, getCurrentSSHHost } from '../utils/sshDetection'
import { clearRecentCache, getRecentSSHConnections } from '../utils/sshHistory'

export class SSHExplorerProvider implements TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new EventEmitter<TreeItem | undefined | null | void>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  private configFilesCache: SSHConfigFileItem[] = []
  private hostsCache: Map<string, SSHHostItem[]> = new Map()
  private recentFolders: Map<string, string[]> = new Map()
  private recentFoldersLoaded = false
  private currentHostCache: string | undefined
  private allCollapsed = false

  refresh(): void {
    this.configFilesCache = []
    this.hostsCache.clear()
    this.excludedFolders.clear()
    this.currentHostCache = undefined
    this.recentFoldersLoaded = false
    this.recentFolders.clear()
    clearRecentCache()
    this._onDidChangeTreeData.fire()
  }

  collapseAll(): void {
    this.allCollapsed = true
    this.configFilesCache = []
    this.hostsCache.clear()
    this._onDidChangeTreeData.fire()
  }

  expandAll(): void {
    this.allCollapsed = false
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
        this.allCollapsed,
        file.isCustom,
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

  async getHostsForConfig(configFile: SSHConfigFileItem): Promise<SSHHostItem[]> {
    // Return cached if available
    if (this.hostsCache.has(configFile.filePath))
      return this.hostsCache.get(configFile.filePath)!

    const configFiles = await getSSHConfigFiles()
    const config = configFiles.find(f => f.path === configFile.filePath)
    if (!config)
      return []

    const currentHost = this.currentHostCache || await getCurrentSSHHost()
    if (!this.currentHostCache)
      this.currentHostCache = currentHost
    const activeConfigFile = workspace.getConfiguration('remote.SSH').get<string>('configFile')

    const hosts = config.hosts.map((e) => {
      const hasRecent = this.recentFolders.has(e.host) || this.recentFolders.has(e.hostname || '')
      const isConfigActive = !activeConfigFile
        || configFile.filePath === activeConfigFile
      const isConnected = currentHost && isConfigActive
        ? (e.host.toLowerCase() === currentHost.toLowerCase()
          || Boolean(e.hostname && e.hostname.toLowerCase() === currentHost.toLowerCase()))
        : false

      return new SSHHostItem(
        e.host,
        e.hostname,
        e.configFile || configFile.filePath,
        e.lineNumber,
        hasRecent,
        isConnected,
        this.allCollapsed,
      )
    })

    this.hostsCache.set(configFile.filePath, hosts)

    // Load recent folders in background — hosts show immediately,
    // then tree refreshes to add folder indicators and expand
    if (!this.recentFoldersLoaded) {
      this.loadRecentFoldersInBackground()
    }

    return hosts
  }

  private async loadRecentFoldersInBackground(): Promise<void> {
    this.recentFolders = await getRecentSSHConnections()
    this.recentFoldersLoaded = true
    this.configFilesCache = []
    this.hostsCache.clear()
    this._onDidChangeTreeData.fire()
  }

  private excludedFolders: Set<string> = new Set()

  findHostItem(hostName: string): SSHHostItem | undefined {
    const activeConfigFile = workspace.getConfiguration('remote.SSH').get<string>('configFile')

    // If a specific config file is set, search it first
    if (activeConfigFile) {
      const activeHosts = this.hostsCache.get(activeConfigFile)
      if (activeHosts) {
        const found = activeHosts.find(h => h.hostName === hostName)
        if (found)
          return found
      }
    }

    // Fallback: search all config files
    for (const [configPath, hosts] of this.hostsCache.entries()) {
      if (configPath === activeConfigFile)
        continue
      const found = hosts.find(h => h.hostName === hostName)
      if (found)
        return found
    }
    return undefined
  }

  removeRecentFolder(hostName: string, folder: string): void {
    this.excludedFolders.add(`${hostName}:${folder}`)
    // Remove from in-memory cache
    const folders = this.recentFolders.get(hostName)
    if (folders) {
      const idx = folders.indexOf(folder)
      if (idx >= 0)
        folders.splice(idx, 1)
      if (folders.length === 0)
        this.recentFolders.delete(hostName)
    }
    this.hostsCache.clear()
    this._onDidChangeTreeData.fire()
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
      const folders = this.recentFolders.get(element.hostName)
        || this.recentFolders.get(element.description || '')
        || []

      if (folders.length === 0)
        return []

      const currentHost = this.currentHostCache || await getCurrentSSHHost()
      const currentFolder = getCurrentSSHFolder()
      const activeConfigFile = workspace.getConfiguration('remote.SSH').get<string>('configFile')
      const isConfigActive = !activeConfigFile || element.configFile === activeConfigFile
      const isThisHostConnected = isConfigActive && (element.hostName === currentHost || element.description === currentHost)

      return folders.map((folder) => {
        const isFolderConnected = isThisHostConnected && currentFolder === folder
        return new SSHFolderItem(element.hostName, folder, isFolderConnected, element.configFile)
      })
    }

    return []
  }
}

async function setRemoteSSHConfigFile(configFile: string | undefined): Promise<void> {
  if (!configFile)
    return
  const cfg = workspace.getConfiguration('remote.SSH')
  await cfg.update('configFile', configFile, true)
}

export async function connectHost(
  hostName: string,
  provider: SSHExplorerProvider,
  reuseWindow: boolean,
  configFile?: string,
): Promise<void> {
  await setRemoteSSHConfigFile(configFile)

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
  configFile?: string,
): Promise<void> {
  await setRemoteSSHConfigFile(configFile)

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
    const editor = await window.showTextDocument(uri)
    const doc = editor.document

    if (doc.languageId === 'plaintext') {
      const text = doc.getText()
      const BLOCK_RE = /^\s*(?:Host|Match)\s+\S/
      const KEYWORD_RE = /^\s+(?:HostName|User|Port|IdentityFile|ProxyCommand|ProxyJump|ForwardAgent|StrictHostKeyChecking|AddKeysToAgent|UseKeychain|ServerAliveInterval|ServerAliveCountMax|ConnectTimeout|Compression|LogLevel|Include)\b/i
      let hasBlock = false
      let hasKeyword = false
      for (const line of text.split('\n').slice(0, 100)) {
        if (BLOCK_RE.test(line))
          hasBlock = true
        if (KEYWORD_RE.test(line))
          hasKeyword = true
        if (hasBlock && hasKeyword)
          break
      }
      if (hasBlock && hasKeyword) {
        try {
          await languages.setTextDocumentLanguage(doc, 'ssh_config')
        }
        catch {}
      }
    }

    if (lineNumber && lineNumber > 0) {
      const position = doc.lineAt(lineNumber - 1).range.start
      editor.selection = new (await import('vscode')).Selection(position, position)
      editor.revealRange(doc.lineAt(lineNumber - 1).range)
    }
  }
  catch (error) {
    window.showErrorMessage(`Failed to open config file: ${error instanceof Error ? error.message : String(error)}`)
  }
}
