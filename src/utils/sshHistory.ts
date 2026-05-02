import { readFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import initSqlJs from 'sql.js'
import { env, window } from 'vscode'
import { decodeSSHHostname } from './sshDetection'

function log(msg: string) {
  window
    .createOutputChannel('SSH Config All-In-One')
    .appendLine(`[History] ${msg}`)
}

function getVSCodeStoragePath(): string {
  const plat = platform()
  const appName = env.appName.includes('Insiders') ? 'Code - Insiders' : 'Code'

  let basePath: string
  if (plat === 'darwin') {
    basePath = join(homedir(), 'Library', 'Application Support', appName)
  } else if (plat === 'win32') {
    basePath = join(process.env.APPDATA || '', appName)
  } else {
    basePath = join(homedir(), '.config', appName)
  }

  return join(basePath, 'User', 'globalStorage', 'state.vscdb')
}

async function openDB(): Promise<initSqlJs.Database | null> {
  try {
    const dbPath = getVSCodeStoragePath()
    const SQL = await initSqlJs()
    const buf = readFileSync(dbPath)
    return new SQL.Database(buf)
  } catch (err) {
    log(
      `Failed to open state.vscdb: ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }
}

function queryValue(db: initSqlJs.Database, key: string): string | null {
  const result = db.exec(`SELECT value FROM ItemTable WHERE key = ?`, [key])
  if (result.length > 0 && result[0].values.length > 0)
    return result[0].values[0][0] as string
  return null
}

/**
 * Read folder history from Remote SSH extension storage (folder.history.v1)
 */
async function getFromRemoteSSHStorage(
  db: initSqlJs.Database,
): Promise<Map<string, string[]>> {
  const hostFolders = new Map<string, string[]>()

  const raw = queryValue(db, 'ms-vscode-remote.remote-ssh')
  if (!raw) return hostFolders

  try {
    const data = JSON.parse(raw)
    const folderHistory: Record<string, string[]> =
      data['folder.history.v1'] || {}
    log(
      `Remote SSH folder.history.v1: ${Object.keys(folderHistory).length} hosts`,
    )

    for (const [rawHost, folders] of Object.entries(folderHistory)) {
      if (!Array.isArray(folders) || folders.length === 0) continue

      let hostname = rawHost
      try {
        hostname = await decodeSSHHostname(rawHost)
      } catch {
        hostname = decodeURIComponent(rawHost)
      }

      hostFolders.set(hostname, folders)
    }
  } catch (err) {
    log(
      `Failed to parse Remote SSH storage: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  return hostFolders
}

const SSH_URI_RE = /^vscode-remote:\/\/ssh-remote(?:\+|%2[bB])([^/]+)(\/.*)$/

/**
 * Read folder history from VS Code's recently opened paths list
 */
async function getFromRecentlyOpened(
  db: initSqlJs.Database,
): Promise<Map<string, string[]>> {
  const hostFolders = new Map<string, string[]>()
  const dbKeys = ['recently.opened', 'history.recentlyOpenedPathsList']

  let rawData: string | null = null
  for (const key of dbKeys) {
    rawData = queryValue(db, key)
    if (rawData) {
      log(`Found recently opened data with key: ${key}`)
      break
    }
  }

  if (!rawData) return hostFolders

  try {
    const data = JSON.parse(rawData)
    const entries: {
      folderUri?: string
      workspace?: { configPath: string }
    }[] = data.entries || []

    for (const entry of entries) {
      const uri = entry.folderUri || entry.workspace?.configPath
      if (!uri) continue

      const match = SSH_URI_RE.exec(uri)
      if (!match) continue

      let hostname = match[1]
      const folderPath = match[2] || '/'

      try {
        hostname = await decodeSSHHostname(hostname)
      } catch {
        hostname = decodeURIComponent(hostname)
      }

      if (!hostFolders.has(hostname)) hostFolders.set(hostname, [])

      const folders = hostFolders.get(hostname)!
      if (!folders.includes(folderPath)) folders.push(folderPath)
    }
  } catch (err) {
    log(
      `Failed to parse recently opened: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  return hostFolders
}

export async function getRecentSSHConnections(): Promise<
  Map<string, string[]>
> {
  const hostFolders = new Map<string, string[]>()

  const db = await openDB()
  if (!db) return hostFolders

  try {
    // Primary: Remote SSH extension's own folder history
    const remoteSSHData = await getFromRemoteSSHStorage(db)
    for (const [host, folders] of remoteSSHData)
      hostFolders.set(host, [...folders])

    // Secondary: VS Code's recently opened paths
    const recentlyOpened = await getFromRecentlyOpened(db)
    for (const [host, folders] of recentlyOpened) {
      if (!hostFolders.has(host)) {
        hostFolders.set(host, [...folders])
      } else {
        const existing = hostFolders.get(host)!
        for (const f of folders) {
          if (!existing.includes(f)) existing.push(f)
        }
      }
    }

    log(`Total: ${hostFolders.size} hosts with recent folders`)
    for (const [host, folders] of hostFolders.entries())
      log(`  ${host}: ${folders.length} folder(s)`)
  } catch (error) {
    log(
      `Failed to get recent SSH connections: ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    db.close()
  }

  return hostFolders
}
