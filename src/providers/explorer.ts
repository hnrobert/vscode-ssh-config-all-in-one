import type { TreeDataProvider, TreeItem } from 'vscode'
import { commands, EventEmitter, languages, TreeItemCollapsibleState, Uri, window, workspace } from 'vscode'
import { SSHConfigFileItem } from '../models/SSHConfigFileItem'
import { SSHFolderItem } from '../models/SSHFolderItem'
import { SSHHostItem } from '../models/SSHHostItem'
import { getSSHConfigFiles } from '../utils/sshConfig'
import { getCurrentSSHFolder, getCurrentSSHHost } from '../utils/sshDetection'
import { clearRecentCache, getRecentSSHConnections } from '../utils/sshHistory'

const t0 = () => performance.now()
const dt = (start: number) => `${(performance.now() - start).toFixed(1)}ms`

export class SSHExplorerProvider implements TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new EventEmitter<TreeItem | undefined | null | void>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  private configFilesCache: SSHConfigFileItem[] = []
  private hostsCache: Map<string, SSHHostItem[]> = new Map()
  private recentFolders: Map<string, string[]> = new Map()
  private recentFoldersLoaded = false
  private currentHostCache: string | undefined
  private parsedConfigFilesCache: Awaited<ReturnType<typeof getSSHConfigFiles>> | null = null
  private allCollapsed = false
  private _nonce = 0

  refresh(): void {
    this.configFilesCache = []
    this.hostsCache.clear()
    this.excludedFolders.clear()
    this.currentHostCache = undefined
    this.recentFoldersLoaded = false
    this.recentFolders.clear()
    this.parsedConfigFilesCache = null
    clearRecentCache()
    this._onDidChangeTreeData.fire()
  }

  collapseAll(): void {
    this.allCollapsed = true
    this._nonce++
    for (const item of this.configFilesCache) {
      if (item.collapsibleState !== TreeItemCollapsibleState.None) {
        item.collapsibleState = TreeItemCollapsibleState.Collapsed
        item.id = `${item.filePath}::${this._nonce}`
      }
    }
    for (const hosts of this.hostsCache.values()) {
      for (const host of hosts) {
        if (host.collapsibleState !== TreeItemCollapsibleState.None) {
          host.collapsibleState = TreeItemCollapsibleState.Collapsed
          host.id = `${host.configFile}:${host.hostName}::${this._nonce}`
        }
      }
    }
    this._onDidChangeTreeData.fire()
  }

  expandAll(): void {
    this.allCollapsed = false
    this._nonce++
    for (const item of this.configFilesCache) {
      if (item.collapsibleState !== TreeItemCollapsibleState.None) {
        item.collapsibleState = TreeItemCollapsibleState.Expanded
        item.id = `${item.filePath}::${this._nonce}`
      }
    }
    for (const hosts of this.hostsCache.values()) {
      for (const host of hosts) {
        if (host.collapsibleState !== TreeItemCollapsibleState.None) {
          host.collapsibleState = TreeItemCollapsibleState.Expanded
          host.id = `${host.configFile}:${host.hostName}::${this._nonce}`
        }
      }
    }
    this._onDidChangeTreeData.fire()
  }

  async getConfigFiles(): Promise<SSHConfigFileItem[]> {
    if (this.configFilesCache.length > 0)
      return this.configFilesCache

    const ts = t0()
    // Load all data upfront so hosts know their expandable state immediately
    const [configFiles] = await Promise.all([
      getSSHConfigFiles(),
      this.ensureCurrentHost(),
      this.ensureRecentFolders(),
    ])
    // console.log(`[SSH Config] getSSHConfigFiles: ${dt(ts)}, ${configFiles.length} files`)

    const ts2 = t0()
    this.configFilesCache = configFiles.map(file =>
      new SSHConfigFileItem(
        file.path,
        file.label,
        file.hosts.length,
        this.allCollapsed,
        file.isCustom,
        this._nonce,
      ),
    )
    // console.log(`[SSH Config] create config items: ${dt(ts2)}`)

    // console.log(`[SSH Config] getConfigFiles total: ${dt(ts)}`)
    return this.configFilesCache
  }

  private async ensureCurrentHost(): Promise<void> {
    if (!this.currentHostCache) {
      const ts = t0()
      this.currentHostCache = await getCurrentSSHHost()
      // console.log(`[SSH Config] getCurrentSSHHost: ${dt(ts)} → ${this.currentHostCache || '(none)'}`)
    }
  }

  async getHostsForConfig(configFile: SSHConfigFileItem): Promise<SSHHostItem[]> {
    if (this.hostsCache.has(configFile.filePath))
      return this.hostsCache.get(configFile.filePath)!

    const ts = t0()
    if (!this.parsedConfigFilesCache)
      this.parsedConfigFilesCache = await getSSHConfigFiles()
    const config = this.parsedConfigFilesCache.find(f => f.path === configFile.filePath)
    if (!config)
      return []

    const currentHost = this.currentHostCache!
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
        this._nonce,
      )
    })

    this.hostsCache.set(configFile.filePath, hosts)
    // console.log(`[SSH Config] getHostsForConfig (${configFile.label}): ${dt(ts)}, ${hosts.length} hosts`)

    return hosts
  }

  private async ensureRecentFolders(): Promise<void> {
    if (!this.recentFoldersLoaded) {
      const ts = t0()
      this.recentFolders = await getRecentSSHConnections()
      this.recentFoldersLoaded = true
      // console.log(`[SSH Config] loadRecentFolders: ${dt(ts)}`)
    }
  }

  private excludedFolders: Set<string> = new Set()

  findHostItem(hostName: string): SSHHostItem | undefined {
    const activeConfigFile = workspace.getConfiguration('remote.SSH').get<string>('configFile')

    if (activeConfigFile) {
      const activeHosts = this.hostsCache.get(activeConfigFile)
      if (activeHosts) {
        const found = activeHosts.find(h => h.hostName === hostName)
        if (found)
          return found
      }
    }

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

  getChildren(element?: TreeItem): TreeItem[] | Promise<TreeItem[]> {
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

      // Fully sync — all data pre-loaded, no await, no loading indicator
      const currentHost = this.currentHostCache
      const currentFolder = getCurrentSSHFolder()
      const activeConfigFile = workspace.getConfiguration('remote.SSH').get<string>('configFile')
      const isConfigActive = !activeConfigFile || element.configFile === activeConfigFile
      const isThisHostConnected = !!currentHost && isConfigActive && (element.hostName === currentHost || element.description === currentHost)

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

  await commands.executeCommand(
    command,
    Uri.parse(`vscode-remote://ssh-remote+${hostName}`),
  )

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

  const command = reuseWindow
    ? 'vscode.openFolder'
    : 'vscode.openFolder'

  await commands.executeCommand(
    command,
    Uri.parse(`vscode-remote://ssh-remote+${hostName}${folder}`),
    !reuseWindow,
  )
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
        catch { }
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
