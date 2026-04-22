import type { ExtensionContext, TreeDataProvider } from 'vscode'
import { readFile } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { commands, EventEmitter, ThemeIcon, TreeItem, TreeItemCollapsibleState, window } from 'vscode'

const readFileAsync = promisify(readFile)

interface RecentConnection {
  host: string
  folder: string
  timestamp: number
}

export class RecentConnectionsManager {
  private static readonly STORAGE_KEY = 'ssh-explorer.recent'
  private static readonly MAX_ENTRIES = 20

  constructor(private context: ExtensionContext) {}

  async add(host: string, folder?: string): Promise<void> {
    const entries = this.getAll()
    const key = `${host}:${folder || '/'}`
    const filtered = entries.filter(
      e => `${e.host}:${e.folder}` !== key,
    )
    filtered.unshift({ host, folder: folder || '/', timestamp: Date.now() })
    await this.context.globalState.update(
      RecentConnectionsManager.STORAGE_KEY,
      filtered.slice(0, RecentConnectionsManager.MAX_ENTRIES),
    )
  }

  getAll(): RecentConnection[] {
    return this.context.globalState.get<RecentConnection[]>(
      RecentConnectionsManager.STORAGE_KEY,
      [],
    )
  }

  getForHost(host: string): RecentConnection[] {
    return this.getAll().filter(e => e.host === host)
  }
}

export class SSHHostItem extends TreeItem {
  constructor(
    public readonly hostName: string,
    public readonly description: string | undefined,
    hasRecentFolders: boolean,
  ) {
    super(hostName, hasRecentFolders
      ? TreeItemCollapsibleState.Collapsed
      : TreeItemCollapsibleState.None)
    this.contextValue = 'host'
    this.iconPath = new ThemeIcon('server')
    this.description = description
    this.tooltip = `SSH Host: ${hostName}`
  }
}

export class SSHFolderItem extends TreeItem {
  constructor(
    public readonly hostName: string,
    folder: string,
  ) {
    super(folder, TreeItemCollapsibleState.None)
    this.contextValue = 'folder'
    this.iconPath = new ThemeIcon('folder')
    this.description = folder
    this.tooltip = `${hostName}:${folder}`
  }
}

interface HostEntry {
  host: string
  hostname?: string
}

async function parseSSHConfig(): Promise<HostEntry[]> {
  const configPath = join(homedir(), '.ssh', 'config')
  let content: string
  try {
    content = await readFileAsync(configPath, 'utf8')
  }
  catch {
    return []
  }

  const hosts: HostEntry[] = []
  let currentHost: HostEntry | null = null

  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('#') || trimmed === '')
      continue

    const matchHost = /^Host\s+(\S.*)$/i.exec(trimmed)
    if (matchHost) {
      if (currentHost)
        hosts.push(currentHost)
      const name = matchHost[1].trim()
      if (name.includes('*') || name.includes('?'))
        continue
      currentHost = { host: name }
      continue
    }

    if (currentHost) {
      const matchHostname = /^\s*HostName\s+(\S.*)$/i.exec(trimmed)
      if (matchHostname)
        currentHost.hostname = matchHostname[1].trim()
    }
  }

  if (currentHost)
    hosts.push(currentHost)

  return hosts
}

export class SSHExplorerProvider implements TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new EventEmitter<TreeItem | undefined | null | void>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  private hostsCache: SSHHostItem[] = []

  constructor(private recentManager: RecentConnectionsManager) {}

  refresh(): void {
    this._onDidChangeTreeData.fire()
  }

  async getHosts(): Promise<SSHHostItem[]> {
    const entries = await parseSSHConfig()
    this.hostsCache = entries.map(
      e => new SSHHostItem(
        e.host,
        e.hostname,
        this.recentManager.getForHost(e.host).length > 0,
      ),
    )
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
      const recent = this.recentManager.getForHost(element.hostName)
      if (recent.length === 0)
        return [new SSHFolderItem(element.hostName, '/')]
      return recent.map(
        r => new SSHFolderItem(element.hostName, r.folder),
      )
    }

    return []
  }
}

export async function connectHost(
  hostName: string,
  recentManager: RecentConnectionsManager,
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

  await recentManager.add(hostName)
  provider.refresh()
}

export async function connectFolder(
  hostName: string,
  folder: string,
  recentManager: RecentConnectionsManager,
  provider: SSHExplorerProvider,
  reuseWindow: boolean,
): Promise<void> {
  try {
    await commands.executeCommand(
      'opensshremotes.openEmptyWindowInCurrentWindow',
      { host: hostName, folder },
    )
  }
  catch {
    // Remote-SSH may not support folder param via fallback
    await commands.executeCommand('vscode.newWindow', {
      remoteAuthority: `ssh-remote+${hostName}`,
      reuseWindow,
    })
  }

  await recentManager.add(hostName, folder)
  provider.refresh()
}
