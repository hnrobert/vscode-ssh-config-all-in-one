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

async function getCurrentSSHHost(): Promise<string | undefined> {
  // Check if we're in an SSH remote session
  const remoteName = env.remoteName
  console.log(`[getCurrentSSHHost] env.remoteName = "${remoteName}"`)

  if (remoteName !== 'ssh-remote') {
    console.log(`[getCurrentSSHHost] Not an SSH remote session`)
    return undefined
  }

  // Try to get hostname from workspace URI authority first
  const workspaceFolder = workspace.workspaceFolders?.[0]
  if (workspaceFolder) {
    const authority = workspaceFolder.uri.authority
    console.log(`[getCurrentSSHHost] Workspace URI authority: "${authority}"`)

    if (authority.startsWith('ssh-remote+')) {
      let hostname = authority.substring('ssh-remote+'.length)
      return await decodeSSHHostname(hostname)
    }
  }

  // If no workspace folder, we cannot reliably determine the current host
  // This is a known limitation - the host can only be detected when a folder is open
  console.log(`[getCurrentSSHHost] No workspace folder - cannot determine current SSH host`)
  console.log(`[getCurrentSSHHost] Note: Host detection only works when a folder is open in the remote session`)
  return undefined
}

async function decodeSSHHostname(hostname: string): Promise<string> {
  console.log(`[decodeSSHHostname] Input: "${hostname}"`)

  // Decode URL-encoded hostname
  hostname = decodeURIComponent(hostname)
  console.log(`[decodeSSHHostname] After URL decode: "${hostname}"`)

  // If it's hex-encoded JSON, decode it
  if (/^[0-9a-f]+$/i.test(hostname)) {
    console.log(`[decodeSSHHostname] Detected hex-encoded JSON`)
    try {
      const { Buffer } = await import('node:buffer')
      const decoded = Buffer.from(hostname, 'hex').toString('utf-8')
      console.log(`[decodeSSHHostname] Hex decoded to: "${decoded}"`)
      const hostData = JSON.parse(decoded)
      console.log(`[decodeSSHHostname] Parsed JSON:`, hostData)
      hostname = hostData.hostName || hostname
      console.log(`[decodeSSHHostname] Final hostname: "${hostname}"`)
    }
    catch (err) {
      console.log(`[decodeSSHHostname] Failed to decode hex JSON:`, err)
    }
  }
  else {
    console.log(`[decodeSSHHostname] Not hex-encoded, using as-is: "${hostname}"`)
  }

  return hostname
}

function getCurrentSSHFolder(): string | undefined {
  // Get current workspace folder path if in SSH session
  if (env.remoteName !== 'ssh-remote')
    return undefined

  const workspaceFolder = workspace.workspaceFolders?.[0]
  if (!workspaceFolder)
    return undefined

  // The URI path for remote workspaces
  const folderPath = workspaceFolder.uri.path
  console.log(`[getCurrentSSHFolder] Current folder path: "${folderPath}"`)
  return folderPath
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
    isCollapsed: boolean = false,
  ) {
    // Determine collapsible state based on whether it has folders and collapse state
    let state: TreeItemCollapsibleState
    if (!hasRecentFolders) {
      state = TreeItemCollapsibleState.None
    }
    else if (isCollapsed) {
      state = TreeItemCollapsibleState.Collapsed
    }
    else {
      state = TreeItemCollapsibleState.Expanded
    }

    super(hostName, state)
    this.contextValue = isConnected ? 'host-connected' : 'host'

    // Use 'vm-active' icon with green color for connected hosts
    if (isConnected) {
      this.iconPath = new ThemeIcon('vm-active', new ThemeColor('charts.green'))
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
      this.iconPath = new ThemeIcon('folder', new ThemeColor('charts.green'))
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
  private collapsedHosts: Set<string> = new Set()

  refresh(): void {
    console.log('[SSH Explorer] Refresh triggered')
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
    console.log('[SSH Explorer] Getting hosts...')
    const entries = await parseSSHConfig()
    const currentHost = await getCurrentSSHHost()
    this.recentFolders = await getRecentSSHConnections()

    console.log(`[SSH Explorer] Current SSH host from env.remoteName: "${currentHost}"`)
    console.log(`[SSH Explorer] env.remoteName raw value: "${env.remoteName}"`)
    console.log(`[SSH Explorer] Found ${entries.length} hosts in SSH config`)

    this.hostsCache = entries.map((e) => {
      const hasRecent = this.recentFolders.has(e.host) || this.recentFolders.has(e.hostname || '')
      // Case-insensitive comparison for hostname matching
      const isConnected = currentHost
        ? (e.host.toLowerCase() === currentHost.toLowerCase()
          || Boolean(e.hostname && e.hostname.toLowerCase() === currentHost.toLowerCase()))
        : false
      const isCollapsed = this.collapsedHosts.has(e.host)

      console.log(`[SSH Explorer] Host ${e.host} (${e.hostname}): hasRecent=${hasRecent}, isConnected=${isConnected}, isCollapsed=${isCollapsed}`)
      if (currentHost) {
        console.log(`  Comparing: "${e.host}" vs "${currentHost}" = ${e.host.toLowerCase() === currentHost.toLowerCase()}`)
        console.log(`  Comparing: "${e.hostname}" vs "${currentHost}" = ${e.hostname?.toLowerCase() === currentHost.toLowerCase()}`)
      }

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

      console.log(`[SSH Explorer] Getting children for host ${element.hostName}: ${folders.length} folders`)

      if (folders.length === 0)
        return []

      // Check if we're currently connected to this host and which folder
      const currentHost = await getCurrentSSHHost()
      const currentFolder = getCurrentSSHFolder()
      const isThisHostConnected = element.hostName === currentHost || element.description === currentHost

      console.log(`[SSH Explorer] Current host: ${currentHost}, Current folder: ${currentFolder}`)
      console.log(`[SSH Explorer] This host: ${element.hostName}, isThisHostConnected: ${isThisHostConnected}`)

      return folders.map((folder) => {
        const isFolderConnected = isThisHostConnected && currentFolder === folder
        console.log(`[SSH Explorer] Folder ${folder}: isConnected=${isFolderConnected} (currentFolder=${currentFolder})`)
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
