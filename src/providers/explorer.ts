import type { ExtensionContext, TreeDataProvider } from 'vscode'
import { readFile } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { commands, env, EventEmitter, ThemeColor, ThemeIcon, TreeItem, TreeItemCollapsibleState, window, workspace } from 'vscode'

const readFileAsync = promisify(readFile)

function replaceHomeDirectory(path: string): string {
  // Replace home directory with ~ for better readability
  // Linux/macOS: /home/username/... or /Users/username/...
  // Windows: /c:/Users/username/... or C:\Users\username\...

  // Handle URL-encoded paths
  const decodedPath = decodeURIComponent(path)

  // Linux: /home/username/...
  const linuxMatch = /^\/home\/[^/]+\/(.*)$/.exec(decodedPath)
  if (linuxMatch) {
    return `~/${linuxMatch[1]}`
  }

  // macOS: /Users/username/...
  const macMatch = /^\/Users\/[^/]+\/(.*)$/.exec(decodedPath)
  if (macMatch) {
    return `~/${macMatch[1]}`
  }

  // Windows: /c:/Users/username/... or C:\Users\username\...
  const winMatch = /^\/[a-z]:\/Users\/[^/]+\/(.*)$/i.exec(decodedPath)
  if (winMatch) {
    return `~/${winMatch[1]}`
  }

  // If just home directory
  if (decodedPath === '/home' || decodedPath === '/Users' || /^\/[a-z]:\/Users$/i.test(decodedPath)) {
    return '~'
  }

  // If path is just /home/username or /Users/username
  if (/^\/home\/[^/]+$/.test(decodedPath) || /^\/Users\/[^/]+$/.test(decodedPath)) {
    return '~'
  }

  return decodedPath
}

function getBaseName(path: string): string {
  // Get the last part of the path as the folder name
  const decodedPath = decodeURIComponent(path)
  const parts = decodedPath.split('/').filter(p => p.length > 0)
  return parts.length > 0 ? parts[parts.length - 1] : path
}

function getCurrentSSHHost(): string | undefined {
  // env.remoteName returns something like "ssh-remote+hostname" when in SSH session
  const remoteName = env.remoteName
  if (remoteName?.startsWith('ssh-remote+')) {
    return remoteName.substring('ssh-remote+'.length)
  }
  return undefined
}

function getCurrentSSHFolder(): string | undefined {
  // Get current workspace folder path if in SSH session
  if (!env.remoteName?.startsWith('ssh-remote+'))
    return undefined

  const workspaceFolder = workspace.workspaceFolders?.[0]
  if (!workspaceFolder)
    return undefined

  // The URI path for remote workspaces
  return workspaceFolder.uri.path
}

interface RecentWorkspace {
  folderUri?: string
  workspace?: { configPath: string }
  label?: string
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

  return join(basePath, 'User', 'globalStorage', 'state.vscdb')
}

async function getRecentSSHConnections(): Promise<Map<string, string[]>> {
  const hostFolders = new Map<string, string[]>()

  try {
    const dbPath = await getVSCodeStoragePath()

    // Try to use sqlite3 command to read the database
    const { exec } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execAsync = promisify(exec)

    try {
      const { stdout } = await execAsync(
        `sqlite3 "${dbPath}" "SELECT value FROM ItemTable WHERE key='history.recentlyOpenedPathsList'"`,
      )

      if (stdout.trim()) {
        const data = JSON.parse(stdout.trim())
        const entries: RecentWorkspace[] = data.entries || []

        console.log(`[SSH Explorer] Found ${entries.length} total entries`)

        for (const entry of entries) {
          const uri = entry.folderUri || entry.workspace?.configPath
          if (!uri)
            continue

          // Parse vscode-remote://ssh-remote+<encoded-host>/path/to/folder
          // or vscode-remote://ssh-remote%2B<hex-encoded-json>/path/to/folder
          const match = /^vscode-remote:\/\/ssh-remote[+%]2[Bb]([^/]+)(\/.*)$/.exec(uri)
          if (match) {
            let hostname = match[1]
            const folderPath = match[2] || '/'

            // The hostname is hex-encoded JSON
            try {
              const { Buffer } = await import('node:buffer')
              const decoded = Buffer.from(hostname, 'hex').toString('utf-8')
              const hostData = JSON.parse(decoded)
              hostname = hostData.hostName || hostname
            }
            catch (err) {
              // If decoding fails, try URL decoding
              hostname = decodeURIComponent(hostname)
            }

            if (!hostFolders.has(hostname)) {
              hostFolders.set(hostname, [])
            }

            const folders = hostFolders.get(hostname)!
            if (!folders.includes(folderPath)) {
              folders.push(folderPath)
            }
          }
        }

        console.log(`[SSH Explorer] Parsed ${hostFolders.size} SSH hosts with folders:`)
        for (const [host, folders] of hostFolders.entries()) {
          console.log(`  ${host}: ${folders.length} folders`)
        }
      }
      else {
        console.log('[SSH Explorer] No data returned from SQLite query')
      }
    }
    catch (sqliteError) {
      console.error('[SSH Explorer] Failed to read SQLite database:', sqliteError)
    }
  }
  catch (error) {
    console.error('[SSH Explorer] Failed to get recent SSH connections:', error)
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
      // Use green color for connected host
      this.iconPath = new ThemeIcon('vm', new ThemeColor('terminal.ansiGreen'))
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
    isConnected: boolean = false,
  ) {
    // Use folder name as label, full path as description
    const folderName = getBaseName(folder)
    const displayPath = replaceHomeDirectory(folder)

    super(folderName, TreeItemCollapsibleState.None)
    this.contextValue = isConnected ? 'folder-connected' : 'folder'

    // Use green color for connected folder
    if (isConnected) {
      this.iconPath = new ThemeIcon('folder', new ThemeColor('terminal.ansiGreen'))
      this.tooltip = `${hostName}:${displayPath} (Connected)`
    }
    else {
      this.iconPath = new ThemeIcon('folder')
      this.tooltip = `${hostName}:${displayPath}`
    }

    this.description = displayPath
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
    console.log('[SSH Explorer] Refresh triggered')
    this.hostsCache = []
    this.recentFolders.clear()
    this._onDidChangeTreeData.fire()
  }

  async getHosts(): Promise<SSHHostItem[]> {
    console.log('[SSH Explorer] Getting hosts...')
    const entries = await parseSSHConfig()
    const currentHost = getCurrentSSHHost()
    this.recentFolders = await getRecentSSHConnections()

    console.log(`[SSH Explorer] Current SSH host: ${currentHost}`)
    console.log(`[SSH Explorer] Found ${entries.length} hosts in SSH config`)

    this.hostsCache = entries.map((e) => {
      const hasRecent = this.recentFolders.has(e.host) || this.recentFolders.has(e.hostname || '')
      const isConnected = e.host === currentHost || e.hostname === currentHost

      console.log(`[SSH Explorer] Host ${e.host} (${e.hostname}): hasRecent=${hasRecent}, isConnected=${isConnected}`)

      return new SSHHostItem(
        e.host,
        e.hostname,
        hasRecent,
        isConnected,
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

      console.log(`[SSH Explorer] Getting children for host ${element.hostName}: ${folders.length} folders`)

      if (folders.length === 0)
        return []

      // Check if we're currently connected to this host and which folder
      const currentHost = getCurrentSSHHost()
      const currentFolder = getCurrentSSHFolder()
      const isThisHostConnected = element.hostName === currentHost || element.description === currentHost

      console.log(`[SSH Explorer] Current folder: ${currentFolder}, isThisHostConnected: ${isThisHostConnected}`)

      return folders.map((folder) => {
        const isFolderConnected = isThisHostConnected && currentFolder === folder
        console.log(`[SSH Explorer] Folder ${folder}: isConnected=${isFolderConnected}`)
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
    const { Uri } = await import('vscode')
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
