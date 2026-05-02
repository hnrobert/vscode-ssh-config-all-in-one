import { exec } from 'node:child_process'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { env, window } from 'vscode'
import { decodeSSHHostname } from './sshDetection'

const execAsync = promisify(exec)

const OUTPUT_CHANNEL_NAME = 'SSH Config All-In-One'

function getOutputChannel() {
  return window.createOutputChannel(OUTPUT_CHANNEL_NAME)
}

function log(msg: string) {
  getOutputChannel().appendLine(`[History] ${msg}`)
}

// Match: ssh-remote+hostname or ssh-remote%2Bhostname
const SSH_URI_RE = /^vscode-remote:\/\/ssh-remote(?:\+|%2[bB])([^/]+)(\/.*)$/

export async function getVSCodeStoragePath(): Promise<string> {
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

async function querySQLite(dbPath: string, query: string): Promise<string> {
  const { stdout } = await execAsync(
    `sqlite3 "${dbPath}" "${query}"`,
    { timeout: 5000 },
  )
  return stdout.trim()
}

/**
 * Read folder history from Remote SSH extension storage (folder.history.v1)
 */
async function getFromRemoteSSHStorage(dbPath: string): Promise<Map<string, string[]>> {
  const hostFolders = new Map<string, string[]>()

  try {
    const raw = await querySQLite(
      dbPath,
      `SELECT value FROM ItemTable WHERE key='ms-vscode-remote.remote-ssh'`,
    )
    if (!raw)
      return hostFolders

    const data = JSON.parse(raw)
    const folderHistory: Record<string, string[]> = data['folder.history.v1'] || {}
    log(`Remote SSH folder.history.v1: ${Object.keys(folderHistory).length} hosts`)

    for (const [rawHost, folders] of Object.entries(folderHistory)) {
      if (!Array.isArray(folders) || folders.length === 0)
        continue

      let hostname = rawHost
      try {
        hostname = await decodeSSHHostname(rawHost)
      }
      catch {
        hostname = decodeURIComponent(rawHost)
      }

      hostFolders.set(hostname, folders)
    }
  }
  catch (err) {
    log(`Remote SSH storage query failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  return hostFolders
}

/**
 * Read folder history from VS Code's recently opened paths list (legacy + new key)
 */
async function getFromRecentlyOpened(dbPath: string): Promise<Map<string, string[]>> {
  const hostFolders = new Map<string, string[]>()
  const dbKeys = ['recently.opened', 'history.recentlyOpenedPathsList']

  let rawData = ''
  for (const key of dbKeys) {
    try {
      const result = await querySQLite(
        dbPath,
        `SELECT value FROM ItemTable WHERE key='${key}'`,
      )
      if (result) {
        rawData = result
        log(`Found data with key: ${key}`)
        break
      }
    }
    catch {
      // key not found, try next
    }
  }

  if (!rawData)
    return hostFolders

  const data = JSON.parse(rawData)
  const entries: { folderUri?: string, workspace?: { configPath: string } }[] = data.entries || []

  for (const entry of entries) {
    const uri = entry.folderUri || entry.workspace?.configPath
    if (!uri)
      continue

    const match = SSH_URI_RE.exec(uri)
    if (!match)
      continue

    let hostname = match[1]
    const folderPath = match[2] || '/'

    try {
      hostname = await decodeSSHHostname(hostname)
    }
    catch {
      hostname = decodeURIComponent(hostname)
    }

    if (!hostFolders.has(hostname))
      hostFolders.set(hostname, [])

    const folders = hostFolders.get(hostname)!
    if (!folders.includes(folderPath))
      folders.push(folderPath)
  }

  return hostFolders
}

export async function getRecentSSHConnections(): Promise<Map<string, string[]>> {
  const hostFolders = new Map<string, string[]>()

  try {
    const dbPath = await getVSCodeStoragePath()
    log(`DB path: ${dbPath}`)

    // Primary source: Remote SSH extension's own folder history
    const remoteSSHData = await getFromRemoteSSHStorage(dbPath)
    for (const [host, folders] of remoteSSHData)
      hostFolders.set(host, [...folders])

    // Secondary source: VS Code's recently opened paths (may have additional entries)
    const recentlyOpened = await getFromRecentlyOpened(dbPath)
    for (const [host, folders] of recentlyOpened) {
      if (!hostFolders.has(host)) {
        hostFolders.set(host, [...folders])
      }
      else {
        const existing = hostFolders.get(host)!
        for (const f of folders) {
          if (!existing.includes(f))
            existing.push(f)
        }
      }
    }

    log(`Total: ${hostFolders.size} hosts with recent folders`)
    for (const [host, folders] of hostFolders.entries())
      log(`  ${host}: ${folders.length} folder(s)`)
  }
  catch (error) {
    log(`Failed to get recent SSH connections: ${error instanceof Error ? error.message : String(error)}`)
  }

  return hostFolders
}
