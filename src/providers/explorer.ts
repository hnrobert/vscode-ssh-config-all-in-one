import type { ExtensionContext, TreeDataProvider } from 'vscode'
import { readFile } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { commands, env, EventEmitter, ThemeColor, ThemeIcon, TreeItem, TreeItemCollapsibleState, window } from 'vscode'

const readFileAsync = promisify(readFile)

function getCurrentSSHHost(): string | undefined {
  // env.remoteName returns something like "ssh-remote+hostname" when in SSH session
  const remoteName = env.remoteName
  if (remoteName?.startsWith('ssh-remote+')) {
    return remoteName.substring('ssh-remote+'.length)
  }
  return undefined
}

interface RecentWorkspace {
  folderUri?: string
  workspace?: { configPath: string }
  label?: string
}

interface StorageData {
  recentlyOpenedPathsList?: {
    entries: RecentWorkspace[]
  }
}

async function getVSCodeStoragePath(): Promise<string> {
  const plat = platform()
  const appName = env.appName.includes('Insiders') ? 'Code - Insiders' : 'Code'

  let basePath: string
  if (plat === 'darwin') {
    basePath = join(homedir(), 'Library', 'Application Support', appName)
  }
  else if (plat === 'win32') {
    basePath = join(process.env.APPDATA || '', appName)
  }
  else {
    basePath = join(homedir(), '.config', appName)
  }

  return join(basePath, 'User', 'globalStorage', 'storage.json')
}

async function getRecentSSHConnections(): Promise<Map<string, string[]>> {
  const hostFolders = new Map<string, string[]>()

  try {
    const storagePath = await getVSCodeStoragePath()
    const content = await readFileAsync(storagePath, 'utf8')
    const data: StorageData = JSON.parse(content)

    const entries = data.recentlyOpenedPathsList?.entries || []

    for (const entry of entries) {
      const uri = entry.folderUri || entry.workspace?.configPath
      if (!uri)
        continue

      // Parse vscode-remote://ssh-remote+hostname/path/to/folder
      const match = /^vscode-remote:\/\/ssh-remote\+([^/]+)(\/.*)$/.exec(uri)
      if (match) {
        const hostname = match[1]
        const folderPath = match[2] || '/'

        if (!hostFolders.has(hostname)) {
          hostFolders.set(hostname, [])
        }

        const folders = hostFolders.get(hostname)!
        if (!folders.includes(folderPath)) {
          folders.push(folderPath)
        }
      }
    }
  }
  catch (error) {
    console.error('Failed to read VS Code storage:', error)
  }

  return hostFolders
}

export class SSHHostItem extends TreeItem {
  constructor(
    public readonly hostName: string,
    public readonly description: string | undefined,
    hasRecentFolders: boolean,
    isConnected: boolean = false,
  ) {
    super(hostName, hasRecentFolders
      ? TreeItemCollapsibleState.Collapsed
      : TreeItemCollapsibleState.None)
    this.contextValue = isConnected ? 'host-connected' : 'host'

    // Use 'vm' icon (same as VS Code Remote SSH)
    if (isConnected) {
      this.iconPath = new ThemeIcon('vm-active') || new ThemeIcon('vm', new ThemeColor('terminal.ansiGreen'))
      this.tooltip = `SSH Host: ${hostName} (Connected)`
    }
    else {
      this.iconPath = new ThemeIcon('vm')
      this.tooltip = `SSH Host: ${hostName}`
    }

    this.description = description
  }
}

export class SSHFolderItem extends TreeItem {
  constructor(
    public readonly hostName: string,
    public readonly folder: string,
  ) {
    super(folder, TreeItemCollapsibleState.None)
    this.contextValue = 'folder'
    this.iconPath = new ThemeIcon('folder')
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
  private recentFolders: Map<string, string[]> = new Map()

  refresh(): void {
    this._onDidChangeTreeData.fire()
  }

  async getHosts(): Promise<SSHHostItem[]> {
    const entries = await parseSSHConfig()
    const currentHost = getCurrentSSHHost()
    this.recentFolders = await getRecentSSHConnections()

    this.hostsCache = entries.map((e) => {
      const hasRecent = this.recentFolders.has(e.host) || this.recentFolders.has(e.hostname || '')
      return new SSHHostItem(
        e.host,
        e.hostname,
        hasRecent,
        e.host === currentHost || e.hostname === currentHost,
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

      if (folders.length === 0)
        return []

      return folders.map(folder => new SSHFolderItem(element.hostName, folder))
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
  const command = reuseWindow
    ? 'opensshremotes.openEmptyWindowInCurrentWindow'
    : 'opensshremotes.openEmptyWindow'

  try {
    await window.withProgress(
      {
        location: 15,
        title: `Connecting to ${hostName}:${folder}...`,
      },
      () => commands.executeCommand(command, {
        host: hostName,
        folderPath: folder,
      }),
    )
  }
  catch {
    // Fallback: open remote window and let user navigate
    await commands.executeCommand('vscode.newWindow', {
      remoteAuthority: `ssh-remote+${hostName}`,
      reuseWindow,
    })
  }

  provider.refresh()
}
